/**
 * Binance Futures funding-rate + open-interest collector (no key).
 *
 * Every 5 minutes, for BTC/ETH/SOL perp-USDT pairs, fetch the current
 * `premiumIndex` (funding + next-funding-time) and `openInterest`. Upserts
 * `funding_<SYMBOL>` and `oi_<SYMBOL>` rows into `indicator_readings`.
 *
 * First-run backfill pulls 500 × 5-minute OI-history snapshots from
 * `/futures/data/openInterestHist` for each symbol so the mini chart
 * renders immediately. Funding isn't backfilled — Binance only exposes
 * 8h-settlement history, which would skew the display with sparse points.
 *
 * Funding is stored as a fraction (0.0001 = 0.01%); UI multiplies ×100.
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { IndicatorEvent } from '@wick/shared';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { getLimiter } from '../../util/rate-limiter.js';
import { logger } from '../../util/logger.js';
import { nowSec } from '../../util/time.js';

const TICK_CRON = '*/5 * * * *';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] as const;
type Symbol = (typeof SYMBOLS)[number];

const BASE_FAPI = 'https://fapi.binance.com';

interface PremiumIndexResponse {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  estimatedSettlePrice?: string;
  lastFundingRate: string;
  nextFundingTime: number;
  interestRate?: string;
  time: number;
}

interface OpenInterestResponse {
  openInterest: string;
  symbol: string;
  time: number;
}

interface OpenInterestHistItem {
  symbol: string;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}

let task: ScheduledTask | null = null;
let running = false;
let stopping = false;
let backfilled = false;
let eventIdSeq = 1;
const lastEmittedValue = new Map<string, number>();

const limiter = getLimiter('binance-futures', { minTime: 100, maxConcurrent: 2 });

const upsertStmt = db.prepare(
  `INSERT INTO indicator_readings (name, ts, value, meta_json)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(name, ts) DO UPDATE SET
     value = excluded.value,
     meta_json = excluded.meta_json`,
);

const priorValueStmt = db.prepare(
  `SELECT value FROM indicator_readings
    WHERE name = ? AND ts < ?
    ORDER BY ts DESC
    LIMIT 1`,
);

const rowCountStmt = db.prepare(
  `SELECT COUNT(*) AS count FROM indicator_readings WHERE name = ?`,
);

function nextEventId(): number {
  return eventIdSeq++;
}

async function fapiGet<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const url = new URL(path, BASE_FAPI);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return limiter.schedule(async () => {
    try {
      const resp = await fetch(url.toString());
      if (!resp.ok) {
        logger.warn(
          { status: resp.status, path, params },
          'binance-futures: http error',
        );
        return null;
      }
      return (await resp.json()) as T;
    } catch (err) {
      logger.error({ err, path }, 'binance-futures: fetch failed');
      return null;
    }
  });
}

function emitIndicator(
  name: string,
  ts: number,
  value: number,
  source: string,
  meta?: Record<string, unknown>,
): void {
  const prev = lastEmittedValue.get(name);
  if (prev === value) return;
  lastEmittedValue.set(name, value);

  const priorRow = priorValueStmt.get(name, ts) as { value: number } | undefined;
  const previous = priorRow?.value;
  const delta = previous !== undefined ? value - previous : undefined;

  const evt: IndicatorEvent = {
    id: nextEventId(),
    ts,
    source,
    kind: 'indicator',
    name,
    value,
    ...(previous !== undefined ? { previous } : {}),
    ...(delta !== undefined ? { delta } : {}),
  };
  eventBus.emit(evt);
  if (meta) {
    // Suppress unused-var lint when meta is only used for side-effect at the
    // emitter call site (reserved for future consumers).
    void meta;
  }
}

async function pollFunding(symbol: Symbol): Promise<void> {
  const resp = await fapiGet<PremiumIndexResponse>('/fapi/v1/premiumIndex', {
    symbol,
  });
  if (!resp) return;
  const rate = Number(resp.lastFundingRate);
  if (!Number.isFinite(rate)) return;
  const ts = resp.time ? Math.floor(resp.time / 1000) : nowSec();
  const meta = JSON.stringify({
    nextFundingTime: resp.nextFundingTime,
    markPrice: Number(resp.markPrice),
  });
  const name = `funding_${symbol}`;
  upsertStmt.run(name, ts, rate, meta);
  emitIndicator(name, ts, rate, 'binance-futures');
}

async function pollOpenInterest(symbol: Symbol): Promise<void> {
  const resp = await fapiGet<OpenInterestResponse>('/fapi/v1/openInterest', {
    symbol,
  });
  if (!resp) return;
  const oi = Number(resp.openInterest);
  if (!Number.isFinite(oi)) return;
  const ts = resp.time ? Math.floor(resp.time / 1000) : nowSec();
  const name = `oi_${symbol}`;
  upsertStmt.run(name, ts, oi, null);
  emitIndicator(name, ts, oi, 'binance-futures');
}

async function backfillOpenInterest(symbol: Symbol): Promise<void> {
  const name = `oi_${symbol}`;
  const { count } = rowCountStmt.get(name) as { count: number };
  if (count >= 50) return;

  const resp = await fapiGet<OpenInterestHistItem[]>(
    '/futures/data/openInterestHist',
    { symbol, period: '5m', limit: '500' },
  );
  if (!resp || !Array.isArray(resp) || resp.length === 0) return;

  const insertMany = db.transaction((items: OpenInterestHistItem[]) => {
    for (const item of items) {
      const value = Number(item.sumOpenInterest);
      const ts = item.timestamp ? Math.floor(item.timestamp / 1000) : null;
      if (!Number.isFinite(value) || ts === null) continue;
      upsertStmt.run(name, ts, value, null);
    }
  });
  insertMany(resp);
  logger.info({ symbol, rows: resp.length }, 'funding-oi: backfilled OI');
}

async function tick(): Promise<void> {
  if (stopping) return;

  if (!backfilled) {
    for (const sym of SYMBOLS) {
      try {
        await backfillOpenInterest(sym);
      } catch (err) {
        logger.error({ err, symbol: sym }, 'funding-oi: backfill failed');
      }
    }
    backfilled = true;
  }

  for (const sym of SYMBOLS) {
    if (stopping) return;
    try {
      await pollFunding(sym);
      await pollOpenInterest(sym);
    } catch (err) {
      logger.error({ err, symbol: sym }, 'funding-oi: tick poll failed');
    }
  }
}

export function startFundingOi(): void {
  if (running) return;
  running = true;
  stopping = false;
  logger.info('funding-oi collector enabled');
  task = cron.schedule(TICK_CRON, () => {
    void tick().catch((err: unknown) => {
      logger.error({ err }, 'funding-oi tick failed');
    });
  });
  void tick().catch((err: unknown) => {
    logger.error({ err }, 'funding-oi initial tick failed');
  });
}

export function stopFundingOi(): void {
  stopping = true;
  running = false;
  if (task) {
    try {
      task.stop();
    } catch (err) {
      logger.error({ err }, 'funding-oi: stop failed');
    }
    task = null;
  }
}

export function isFundingOiRunning(): boolean {
  return running;
}
