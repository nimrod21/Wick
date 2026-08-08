/**
 * Binance combined-stream WebSocket collector (Wick schema, symbol-keyed).
 *
 * Per active asset:
 *   <symbol>@trade       → TickEvent + last-price cache (paper engine reads this)
 *   <symbol>@miniTicker  → 24h stats cache (last/open/high/low/volume) for /summary
 *   <symbol>@kline_1m    → closed 1m candles persisted + candle events
 *   <symbol>@kline_1h    → closed 1h candles persisted + candle events (indicator engine wakes on these)
 *
 * Reconnect: exponential backoff 1s → 30s cap. Heartbeat timeout forces
 * reconnect after 10 min of silence. On reconnect, REST gap-backfill 1m/1h.
 *
 * Backfill race: while the boot backfill runs, closed klines are BUFFERED
 * (not persisted, not emitted). `flushKlineBuffer()` applies them after
 * backfill completes — upserts are idempotent so overlap is harmless.
 */

import WebSocket from 'ws';
import type { CandleEvent, TickEvent } from '@wick/shared';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { logger } from '../../util/logger.js';
import {
  backfillGap,
  getActiveSymbols,
  upsertCandle,
  type WickTf,
} from './binance-rest.js';

const WS_BASE = 'wss://stream.binance.com:9443/stream';
const BACKOFF_SCHEDULE = [1000, 2000, 4000, 8000, 16000, 30000];
const HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000;
const WS_TFS: WickTf[] = ['1m', '1h'];

interface BinanceKlineMsg {
  e: 'kline';
  E: number;
  s: string;
  k: {
    t: number; // kline open time (ms)
    T: number; // kline close time (ms)
    s: string;
    i: string; // interval
    o: string;
    c: string;
    h: string;
    l: string;
    v: string;
    x: boolean; // is kline closed
  };
}

interface BinanceTradeMsg {
  e: 'trade';
  E: number;
  s: string;
  t: number;
  p: string;
  q: string;
  T: number;
  m: boolean; // buyer is market maker → aggressor was a seller
}

interface BinanceMiniTickerMsg {
  e: '24hrMiniTicker';
  E: number;
  s: string;
  c: string; // last price
  o: string; // 24h-ago open
  h: string;
  l: string;
  v: string; // base volume
  q: string; // quote volume
}

type BinanceStreamMsg = {
  stream: string;
  data: BinanceKlineMsg | BinanceTradeMsg | BinanceMiniTickerMsg;
};

export interface TickerStats {
  lastPrice: number;
  changePct24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  ts: number;
}

interface BufferedKline {
  symbol: string;
  tf: WickTf;
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let lastMessageAt = 0;
let stopping = false;
let eventIdSeq = 1;
let buffering = true;

const klineBuffer: BufferedKline[] = [];
const knownSymbols = new Set<string>();
const lastPriceBySymbol = new Map<string, number>();
const tickerStatsBySymbol = new Map<string, TickerStats>();
/** key `${symbol}:${tf}` → last persisted candle open ts (ms). */
const lastCandleTs = new Map<string, number>();

function nextEventId(): number {
  return eventIdSeq++;
}

function buildStreamsUrl(symbols: string[]): string {
  const streams: string[] = [];
  for (const sym of symbols) {
    const s = sym.toLowerCase();
    streams.push(`${s}@trade`);
    streams.push(`${s}@miniTicker`);
    streams.push(`${s}@kline_1m`);
    streams.push(`${s}@kline_1h`);
  }
  return `${WS_BASE}?streams=${streams.join('/')}`;
}

function persistClosedKline(k: BufferedKline): void {
  try {
    upsertCandle(k.symbol, k.tf, k.ts, k.o, k.h, k.l, k.c, k.v);
    lastCandleTs.set(`${k.symbol}:${k.tf}`, k.ts);
  } catch (err) {
    logger.error({ err, symbol: k.symbol, tf: k.tf, ts: k.ts }, 'failed to persist candle');
  }
}

function handleKline(symbol: string, msg: BinanceKlineMsg): void {
  const k = msg.k;
  const tf = k.i as WickTf;
  if (!WS_TFS.includes(tf)) return;
  const candle: BufferedKline = {
    symbol,
    tf,
    ts: k.t,
    o: parseFloat(k.o),
    h: parseFloat(k.h),
    l: parseFloat(k.l),
    c: parseFloat(k.c),
    v: parseFloat(k.v),
  };

  if (k.x) {
    if (buffering) {
      // Boot backfill still running — hold closed klines, apply after.
      klineBuffer.push(candle);
      return;
    }
    persistClosedKline(candle);
  } else if (buffering) {
    // Forming candles are UI-only; suppress until market is warm.
    return;
  }

  const evt: CandleEvent = {
    id: nextEventId(),
    ts: candle.ts,
    source: 'binance-ws',
    kind: 'candle',
    symbol,
    tf,
    o: candle.o,
    h: candle.h,
    l: candle.l,
    c: candle.c,
    v: candle.v,
    closed: k.x,
  };
  eventBus.emit(evt);
}

function handleTrade(symbol: string, msg: BinanceTradeMsg): void {
  const price = parseFloat(msg.p);
  lastPriceBySymbol.set(symbol, price);
  const evt: TickEvent = {
    id: nextEventId(),
    ts: msg.T,
    source: 'binance-ws',
    kind: 'tick',
    symbol,
    price,
    qty: parseFloat(msg.q),
    // m=true → buyer is maker → aggressor was a seller
    side: msg.m ? 'sell' : 'buy',
  };
  eventBus.emit(evt);
}

function handleMiniTicker(symbol: string, msg: BinanceMiniTickerMsg): void {
  const last = parseFloat(msg.c);
  const open = parseFloat(msg.o);
  lastPriceBySymbol.set(symbol, last);
  tickerStatsBySymbol.set(symbol, {
    lastPrice: last,
    changePct24h: open > 0 ? ((last - open) / open) * 100 : 0,
    high24h: parseFloat(msg.h),
    low24h: parseFloat(msg.l),
    volume24h: parseFloat(msg.v),
    ts: msg.E,
  });
}

function handleMessage(raw: string | Buffer): void {
  lastMessageAt = Date.now();
  let parsed: BinanceStreamMsg;
  try {
    parsed = JSON.parse(raw.toString()) as BinanceStreamMsg;
  } catch (err) {
    logger.warn({ err }, 'binance ws: bad json frame');
    return;
  }
  const streamName = parsed.stream;
  if (!streamName) return;

  // stream format: "<symbol>@<type>..." — symbol is always the first part.
  const lower = streamName.split('@', 1)[0];
  if (!lower) return;
  const symbol = lower.toUpperCase();
  if (!knownSymbols.has(symbol)) return;

  if (streamName.includes('@kline')) {
    handleKline(symbol, parsed.data as BinanceKlineMsg);
  } else if (streamName.includes('@trade')) {
    handleTrade(symbol, parsed.data as BinanceTradeMsg);
  } else if (streamName.includes('@miniTicker')) {
    handleMiniTicker(symbol, parsed.data as BinanceMiniTickerMsg);
  }
}

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearHeartbeatTimer(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeatWatchdog(): void {
  clearHeartbeatTimer();
  lastMessageAt = Date.now();
  heartbeatTimer = setInterval(() => {
    if (stopping) return;
    if (Date.now() - lastMessageAt > HEARTBEAT_TIMEOUT_MS) {
      logger.warn('binance ws: heartbeat timeout, forcing reconnect');
      // Will fire 'close' which triggers scheduleReconnect.
      try {
        ws?.terminate();
      } catch (err) {
        logger.error({ err }, 'binance ws: terminate failed');
      }
    }
  }, 30_000);
}

function scheduleReconnect(): void {
  if (stopping) return;
  clearReconnectTimer();
  const delay =
    BACKOFF_SCHEDULE[Math.min(reconnectAttempt, BACKOFF_SCHEDULE.length - 1)]!;
  reconnectAttempt += 1;
  logger.info({ attempt: reconnectAttempt, delayMs: delay }, 'binance ws: reconnect scheduled');
  reconnectTimer = setTimeout(() => {
    // Fire-and-forget gap backfill per (symbol, tf) before we reconnect,
    // so post-reconnect state is accurate. Don't await — let it run.
    if (!buffering) {
      for (const [key, lastTs] of lastCandleTs.entries()) {
        const [symbol, tf] = key.split(':') as [string, WickTf];
        void backfillGap(symbol, tf, lastTs).catch((err) => {
          logger.error({ err, symbol, tf }, 'reconnect backfill failed');
        });
      }
    }
    void connect();
  }, delay);
}

async function connect(): Promise<void> {
  if (stopping) return;
  const symbols = getActiveSymbols();
  if (symbols.length === 0) {
    logger.warn('binance ws: no active assets, not connecting');
    return;
  }
  knownSymbols.clear();
  for (const s of symbols) knownSymbols.add(s);

  const url = buildStreamsUrl(symbols);
  logger.info(
    { symbolCount: symbols.length, streams: symbols.length * 4 },
    'binance ws: connecting',
  );

  const socket = new WebSocket(url);
  ws = socket;

  socket.on('open', () => {
    reconnectAttempt = 0;
    startHeartbeatWatchdog();
    logger.info({ symbols }, 'binance ws: subscribed');
  });

  socket.on('message', (data: WebSocket.RawData) => {
    // Normalise to string; binance frames are always utf8 JSON.
    handleMessage(data.toString());
  });

  socket.on('error', (err: Error) => {
    logger.error({ err: err.message }, 'binance ws: error');
  });

  socket.on('close', (code: number, reason: Buffer) => {
    logger.warn({ code, reason: reason.toString() }, 'binance ws: closed');
    clearHeartbeatTimer();
    ws = null;
    scheduleReconnect();
  });
}

/**
 * Start the WS collector. Closed klines are buffered until
 * `flushKlineBuffer()` is called (after the boot REST backfill).
 */
export async function startBinanceWs(): Promise<void> {
  stopping = false;
  buffering = true;
  // Prime lastCandleTs from DB so the first reconnect (if any) knows where
  // to backfill from.
  for (const tf of WS_TFS) {
    const rows = db
      .prepare(
        `SELECT c.symbol AS symbol, MAX(c.ts) AS lastTs
           FROM candles c
           JOIN assets a ON a.symbol = c.symbol
          WHERE a.active = 1 AND c.tf = ?
          GROUP BY c.symbol`,
      )
      .all(tf) as Array<{ symbol: string; lastTs: number }>;
    for (const r of rows) {
      if (r.lastTs) lastCandleTs.set(`${r.symbol}:${tf}`, r.lastTs);
    }
  }
  await connect();
}

/**
 * Apply klines buffered during the boot backfill, then switch to live
 * persist-on-close mode. No candle events are emitted for the flushed rows —
 * the boot sequence runs a full indicator pass right after.
 */
export function flushKlineBuffer(): void {
  const flushed = klineBuffer.length;
  for (const k of klineBuffer) persistClosedKline(k);
  klineBuffer.length = 0;
  buffering = false;
  logger.info({ flushed }, 'binance ws: kline buffer flushed, live mode');
}

export async function stopBinanceWs(): Promise<void> {
  stopping = true;
  clearReconnectTimer();
  clearHeartbeatTimer();
  if (ws) {
    try {
      ws.close();
    } catch (err) {
      logger.error({ err }, 'binance ws: close failed');
    }
    ws = null;
  }
}

/**
 * Latest traded price for a symbol (live mid proxy — Binance @trade last
 * price, also refreshed by @miniTicker). Phase 2's paper engine fills at
 * this price ± slippage.
 */
export function getLastPrice(symbol: string): number | null {
  return lastPriceBySymbol.get(symbol) ?? null;
}

/** Latest 24h rolling stats from @miniTicker (null until first frame). */
export function getTickerStats(symbol: string): TickerStats | null {
  return tickerStatsBySymbol.get(symbol) ?? null;
}

export interface WsStatus {
  connected: boolean;
  /** Age of the last frame received, ms (null before the first frame). */
  lastMessageAgoMs: number | null;
  /** 0 while healthy; climbs while the backoff ladder is walked. */
  reconnectAttempt: number;
  symbols: number;
  /** True until the boot backfill has been flushed. */
  buffering: boolean;
}

/** Ops view of the collector (GET /health, `pnpm doctor`). */
export function wsStatus(): WsStatus {
  return {
    connected: ws !== null && ws.readyState === WebSocket.OPEN,
    lastMessageAgoMs: lastMessageAt === 0 ? null : Date.now() - lastMessageAt,
    reconnectAttempt,
    symbols: knownSymbols.size,
    buffering,
  };
}
