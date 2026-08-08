/**
 * Binance REST collector — historical backfill, gap self-heal, and periodic
 * higher-timeframe refresh, all against the Wick `candles` table
 * (symbol, tf, ts-ms keyed).
 *
 * Strategy for 15m/4h/1d (noted in STATUS.md): periodic REST refresh — a
 * 5-minute cron re-fetches the last 2 klines per (symbol × htf) and upserts
 * the closed ones. Exact Binance values, no aggregation drift, ~21 requests
 * per 5 min — far below the 1200 weight/min budget.
 *
 * Only CLOSED klines are persisted (closeTime <= now). Forming candles reach
 * the UI via WS candle events, never the DB.
 */

import type { Timeframe } from '@wick/shared';
import { db } from '../../db/client.js';
import { getLimiter } from '../../util/rate-limiter.js';
import { logger } from '../../util/logger.js';
import { nowMs } from '../../util/time.js';

const BASE_URL = 'https://api.binance.com';
const KLINES_PATH = '/api/v3/klines';
const BACKFILL_LIMIT = 500;

/** Timeframes Wick stores (PLAN §6). */
export const WICK_TFS = ['1m', '15m', '1h', '4h', '1d'] as const satisfies readonly Timeframe[];
export type WickTf = (typeof WICK_TFS)[number];

export const TF_MS: Record<WickTf, number> = {
  '1m': 60_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

/** Higher timeframes kept fresh by the 5-minute REST refresh cron. */
const HTF_REFRESH: WickTf[] = ['15m', '4h', '1d'];

/** Lookback (in candles) per tf for the hourly gap self-heal. */
const SELF_HEAL_LOOKBACK: Record<WickTf, number> = {
  '1m': 180,
  '15m': 32,
  '1h': 26,
  '4h': 12,
  '1d': 5,
};

// Binance kline response row layout (by index).
type BinanceKlineRow = [
  openTimeMs: number,
  open: string,
  high: string,
  low: string,
  close: string,
  volume: string,
  closeTimeMs: number,
  quoteVolume: string,
  trades: number,
  takerBuyBase: string,
  takerBuyQuote: string,
  _ignore: string,
];

const limiter = getLimiter('binance-rest', { minTime: 160, maxConcurrent: 2 });

export function getActiveSymbols(): string[] {
  const rows = db
    .prepare(`SELECT symbol FROM assets WHERE active = 1 ORDER BY symbol`)
    .all() as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol);
}

async function fetchKlines(
  symbol: string,
  interval: WickTf,
  opts: { limit?: number; startTime?: number; endTime?: number } = {},
): Promise<BinanceKlineRow[]> {
  const params = new URLSearchParams({ symbol, interval });
  params.set('limit', String(opts.limit ?? BACKFILL_LIMIT));
  if (opts.startTime !== undefined) params.set('startTime', String(opts.startTime));
  if (opts.endTime !== undefined) params.set('endTime', String(opts.endTime));
  const url = `${BASE_URL}${KLINES_PATH}?${params.toString()}`;
  return limiter.schedule(async () => {
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(
        `binance klines ${resp.status} for ${symbol} ${interval}: ${text.slice(0, 200)}`,
      );
    }
    return (await resp.json()) as BinanceKlineRow[];
  });
}

/** Upsert one closed candle row. Shared with the WS collector. */
export function upsertCandle(
  symbol: string,
  tf: WickTf,
  ts: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO candles (symbol, tf, ts, o, h, l, c, v)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(symbol, tf, ts, o, h, l, c, v);
}

/** Insert only rows whose kline has closed. Returns inserted count. */
function insertClosedRows(symbol: string, tf: WickTf, rows: BinanceKlineRow[]): number {
  const cutoff = nowMs();
  const closed = rows.filter((r) => r[6] <= cutoff);
  if (closed.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO candles (symbol, tf, ts, o, h, l, c, v)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((batch: BinanceKlineRow[]) => {
    for (const r of batch) {
      stmt.run(
        symbol,
        tf,
        r[0],
        parseFloat(r[1]),
        parseFloat(r[2]),
        parseFloat(r[3]),
        parseFloat(r[4]),
        parseFloat(r[5]),
      );
    }
  });
  tx(closed);
  return closed.length;
}

/**
 * Boot backfill: newest 500 klines per (active symbol × tf) for
 * 1m/15m/1h/4h/1d. 7 symbols × 5 tfs = 35 requests ≈ 6 s at 160 ms spacing.
 */
export async function backfillAll(): Promise<void> {
  const symbols = getActiveSymbols();
  if (symbols.length === 0) {
    logger.warn('backfillAll: no active assets');
    return;
  }
  const started = Date.now();
  let totalRows = 0;
  for (const symbol of symbols) {
    for (const tf of WICK_TFS) {
      try {
        const rows = await fetchKlines(symbol, tf, { limit: BACKFILL_LIMIT });
        totalRows += insertClosedRows(symbol, tf, rows);
      } catch (err) {
        logger.error({ err, symbol, tf }, 'backfillAll: fetch failed (continuing)');
      }
    }
  }
  logger.info(
    { symbols: symbols.length, rows: totalRows, durationMs: Date.now() - started },
    'backfillAll complete',
  );
}

/**
 * Fill the gap between `fromTs` (ms, exclusive of already-stored candles is
 * fine — upsert is idempotent) and now for one (symbol, tf). Used after a WS
 * reconnect and by the self-heal when a hole is detected.
 */
export async function backfillGap(
  symbol: string,
  tf: WickTf,
  fromTs: number,
): Promise<void> {
  let cursor = fromTs;
  let total = 0;
  while (cursor < nowMs()) {
    let rows: BinanceKlineRow[];
    try {
      rows = await fetchKlines(symbol, tf, { startTime: cursor, limit: 1000 });
    } catch (err) {
      logger.error({ err, symbol, tf }, 'backfillGap: fetch failed');
      return;
    }
    if (rows.length === 0) break;
    total += insertClosedRows(symbol, tf, rows);
    const lastOpen = rows[rows.length - 1]![0];
    const next = lastOpen + TF_MS[tf];
    if (next <= cursor) break; // safety: no forward progress
    cursor = next;
    if (rows.length < 1000) break; // reached the present
  }
  if (total > 0) {
    logger.info({ symbol, tf, rows: total, fromTs }, 'backfillGap filled');
  }
}

/** Re-fetch the newest `count` klines for (symbol, tf) and upsert closed ones. */
export async function refreshRecent(
  symbol: string,
  tf: WickTf,
  count: number,
): Promise<number> {
  const rows = await fetchKlines(symbol, tf, { limit: count });
  return insertClosedRows(symbol, tf, rows);
}

/**
 * 5-minute higher-timeframe refresh (15m/4h/1d): last 2 klines per pair.
 * Started/stopped by the scheduler.
 */
export async function refreshHigherTimeframes(): Promise<void> {
  for (const symbol of getActiveSymbols()) {
    for (const tf of HTF_REFRESH) {
      try {
        await refreshRecent(symbol, tf, 2);
      } catch (err) {
        logger.error({ err, symbol, tf }, 'htf refresh failed (continuing)');
      }
    }
  }
}

/**
 * Hourly candle-gap self-heal: for each (symbol × tf), count how many of the
 * expected recent buckets are missing from the DB; if any are, re-fetch the
 * whole lookback window (which also repairs them via upsert).
 */
export async function selfHealGaps(): Promise<void> {
  const now = nowMs();
  for (const symbol of getActiveSymbols()) {
    for (const tf of WICK_TFS) {
      const lookback = SELF_HEAL_LOOKBACK[tf];
      const step = TF_MS[tf];
      // Last fully-closed bucket open time.
      const lastClosedOpen = Math.floor(now / step) * step - step;
      const windowStart = lastClosedOpen - (lookback - 1) * step;
      const { cnt } = db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM candles
            WHERE symbol = ? AND tf = ? AND ts >= ? AND ts <= ?`,
        )
        .get(symbol, tf, windowStart, lastClosedOpen) as { cnt: number };
      const missing = lookback - cnt;
      if (missing <= 0) continue;
      logger.warn({ symbol, tf, missing, lookback }, 'self-heal: candle gap detected');
      try {
        await backfillGap(symbol, tf, windowStart);
      } catch (err) {
        logger.error({ err, symbol, tf }, 'self-heal: backfill failed');
      }
    }
  }
}
