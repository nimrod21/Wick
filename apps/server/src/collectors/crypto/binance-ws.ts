/**
 * Binance combined-stream WebSocket collector.
 *
 * Subscribes every enabled binance asset to three streams:
 *   <symbol>@kline_1m    → persisted 1m candles + forming-candle tick events
 *   <symbol>@trade       → TradeTickEvent (not persisted)
 *   <symbol>@depth20@100ms → OrderbookEvent + in-memory snapshot cache
 *
 * Reconnect: exponential backoff 1s → 30s cap. Heartbeat timeout forces
 * reconnect after 10 min of silence. On reconnect, backfill any gap.
 */

import WebSocket from 'ws';
import type {
  AssetId,
  OrderbookEvent,
  OrderbookLevel,
  PriceCandleEvent,
  TradeTickEvent,
} from '@cockpit/shared';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { logger } from '../../util/logger.js';
import { nowSec } from '../../util/time.js';
import { backfillGap } from './binance-rest.js';

const WS_BASE = 'wss://stream.binance.com:9443/stream';
const BACKOFF_SCHEDULE = [1000, 2000, 4000, 8000, 16000, 30000];
const HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000;

interface CryptoAssetRow {
  id: number;
  symbol: string;
}

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
  m: boolean; // buyer is market maker → trade was a sell
}

interface BinanceDepthMsg {
  // depth20 partial-book snapshot (no event type field)
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

type BinanceStreamMsg =
  | { stream: string; data: BinanceKlineMsg }
  | { stream: string; data: BinanceTradeMsg }
  | { stream: string; data: BinanceDepthMsg };

let ws: WebSocket | null = null;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let lastMessageAt = 0;
let stopping = false;
let eventIdSeq = 1;

const orderbookCache = new Map<AssetId, OrderbookEvent>();
const symbolToAssetId = new Map<string, number>();
const lastCandleTsByAsset = new Map<AssetId, number>();

const upsert1mStmt = db.prepare(
  `INSERT OR REPLACE INTO candles_1m (asset_id, ts, o, h, l, c, v)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

function nextEventId(): number {
  return eventIdSeq++;
}

function getEnabledBinanceAssets(): CryptoAssetRow[] {
  return db
    .prepare(
      `SELECT id, symbol FROM assets
        WHERE type = 'crypto' AND exchange = 'binance' AND enabled = 1
        ORDER BY id`,
    )
    .all() as CryptoAssetRow[];
}

function buildStreamsUrl(assets: CryptoAssetRow[]): string {
  const streams: string[] = [];
  for (const a of assets) {
    const s = a.symbol.toLowerCase();
    streams.push(`${s}@kline_1m`);
    streams.push(`${s}@trade`);
    streams.push(`${s}@depth20@100ms`);
  }
  return `${WS_BASE}?streams=${streams.join('/')}`;
}

function parseLevels(raw: [string, string][]): OrderbookLevel[] {
  const out: OrderbookLevel[] = [];
  for (const [p, q] of raw) {
    out.push([parseFloat(p), parseFloat(q)]);
  }
  return out;
}

function handleKline(assetId: AssetId, msg: BinanceKlineMsg): void {
  const k = msg.k;
  const tsSec = Math.floor(k.t / 1000);
  const o = parseFloat(k.o);
  const h = parseFloat(k.h);
  const l = parseFloat(k.l);
  const c = parseFloat(k.c);
  const v = parseFloat(k.v);

  if (k.x) {
    // closed candle: persist
    try {
      upsert1mStmt.run(assetId, tsSec, o, h, l, c, v);
      lastCandleTsByAsset.set(assetId, tsSec);
    } catch (err) {
      logger.error({ err, assetId, tsSec }, 'failed to persist candle_1m');
    }
  }

  const evt: PriceCandleEvent = {
    id: nextEventId(),
    ts: tsSec,
    source: 'binance-ws',
    kind: 'candle',
    assetId,
    timeframe: '1m',
    o,
    h,
    l,
    c,
    v,
  };
  eventBus.emit(evt);
}

function handleTrade(assetId: AssetId, msg: BinanceTradeMsg): void {
  const evt: TradeTickEvent = {
    id: nextEventId(),
    ts: Math.floor(msg.T / 1000),
    source: 'binance-ws',
    kind: 'trade_tick',
    assetId,
    price: parseFloat(msg.p),
    qty: parseFloat(msg.q),
    // m=true → buyer is maker → aggressor was a seller
    side: msg.m ? 'sell' : 'buy',
  };
  eventBus.emit(evt);
}

function handleDepth(assetId: AssetId, msg: BinanceDepthMsg): void {
  const evt: OrderbookEvent = {
    id: nextEventId(),
    ts: nowSec(),
    source: 'binance-ws',
    kind: 'orderbook',
    assetId,
    bids: parseLevels(msg.bids),
    asks: parseLevels(msg.asks),
  };
  orderbookCache.set(assetId, evt);
  eventBus.emit(evt);
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
  const symbol = streamName.split('@', 1)[0];
  if (!symbol) return;
  const assetId = symbolToAssetId.get(symbol);
  if (assetId === undefined) return;

  if (streamName.includes('@kline')) {
    handleKline(assetId, parsed.data as BinanceKlineMsg);
  } else if (streamName.includes('@trade')) {
    handleTrade(assetId, parsed.data as BinanceTradeMsg);
  } else if (streamName.includes('@depth')) {
    handleDepth(assetId, parsed.data as BinanceDepthMsg);
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
    BACKOFF_SCHEDULE[Math.min(reconnectAttempt, BACKOFF_SCHEDULE.length - 1)];
  reconnectAttempt += 1;
  logger.info({ attempt: reconnectAttempt, delayMs: delay }, 'binance ws: reconnect scheduled');
  reconnectTimer = setTimeout(() => {
    // Fire-and-forget gap backfill for every asset before we reconnect,
    // so post-reconnect state is accurate. Don't await — let it run.
    for (const [assetId, lastTs] of lastCandleTsByAsset.entries()) {
      void backfillGap(assetId, lastTs).catch((err) => {
        logger.error({ err, assetId }, 'reconnect backfill failed');
      });
    }
    void connect();
  }, delay);
}

async function connect(): Promise<void> {
  if (stopping) return;
  const assets = getEnabledBinanceAssets();
  if (assets.length === 0) {
    logger.warn('binance ws: no enabled assets, not connecting');
    return;
  }
  symbolToAssetId.clear();
  for (const a of assets) {
    symbolToAssetId.set(a.symbol.toLowerCase(), a.id);
  }

  const url = buildStreamsUrl(assets);
  logger.info(
    { assetCount: assets.length, streams: assets.length * 3 },
    'binance ws: connecting',
  );

  const socket = new WebSocket(url);
  ws = socket;

  socket.on('open', () => {
    reconnectAttempt = 0;
    startHeartbeatWatchdog();
    for (const a of assets) {
      logger.info({ symbol: a.symbol, assetId: a.id }, 'ws subscribed');
    }
  });

  socket.on('message', (data: WebSocket.RawData) => {
    // Normalise to string; binance frames are always utf8 JSON.
    handleMessage(data.toString());
  });

  socket.on('error', (err: Error) => {
    logger.error({ err: err.message }, 'binance ws: error');
  });

  socket.on('close', (code: number, reason: Buffer) => {
    logger.warn(
      { code, reason: reason.toString() },
      'binance ws: closed',
    );
    clearHeartbeatTimer();
    ws = null;
    scheduleReconnect();
  });
}

export async function startBinanceWs(): Promise<void> {
  stopping = false;
  // Prime lastCandleTsByAsset from DB so the first reconnect (if any)
  // knows where to backfill from.
  const rows = db
    .prepare(
      `SELECT c.asset_id AS assetId, MAX(c.ts) AS lastTs
         FROM candles_1m c
         JOIN assets a ON a.id = c.asset_id
        WHERE a.type = 'crypto' AND a.exchange = 'binance' AND a.enabled = 1
        GROUP BY c.asset_id`,
    )
    .all() as Array<{ assetId: number; lastTs: number }>;
  for (const r of rows) {
    if (r.lastTs) lastCandleTsByAsset.set(r.assetId, r.lastTs);
  }
  await connect();
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

export function getLatestOrderbook(assetId: AssetId): OrderbookEvent | null {
  return orderbookCache.get(assetId) ?? null;
}
