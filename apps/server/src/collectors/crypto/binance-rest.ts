/**
 * Binance REST collector — historical backfill, gap fill, and
 * higher-timeframe aggregation from candles_1m.
 *
 * Endpoints used:
 *   GET /api/v3/klines?symbol=X&interval=1m&startTime=...&endTime=...&limit=1000
 *
 * Rate limiting: Binance weight budget is 1200/min on REST. We keep a single
 * bottleneck at ~6 req/s (minTime 160ms) which is well below that.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { db } from '../../db/client.js';
import { getLimiter } from '../../util/rate-limiter.js';
import { logger } from '../../util/logger.js';
import { nowSec } from '../../util/time.js';

const BASE_URL = 'https://api.binance.com';
const KLINES_PATH = '/api/v3/klines';
const HISTORY_SECONDS = 90 * 24 * 60 * 60;
const MAX_KLINES_PER_REQUEST = 1000;

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

interface CryptoAssetRow {
  id: number;
  symbol: string;
}

const limiter = getLimiter('binance-rest', { minTime: 160, maxConcurrent: 2 });

let aggregationCronTask: ScheduledTask | null = null;

function getEnabledBinanceAssets(): CryptoAssetRow[] {
  return db
    .prepare(
      `SELECT id, symbol FROM assets
        WHERE type = 'crypto' AND exchange = 'binance' AND enabled = 1
        ORDER BY id`,
    )
    .all() as CryptoAssetRow[];
}

function readKv(key: string): { completed: boolean; last_ts: number } | null {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as
    | { v: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.v) as { completed: boolean; last_ts: number };
    if (
      typeof parsed.completed === 'boolean' &&
      typeof parsed.last_ts === 'number'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function writeKv(key: string, value: { completed: boolean; last_ts: number }): void {
  db.prepare(
    `INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), nowSec());
}

async function fetchKlines(
  symbol: string,
  startMs: number,
  endMs: number,
): Promise<BinanceKlineRow[]> {
  const url =
    `${BASE_URL}${KLINES_PATH}` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=1m` +
    `&startTime=${startMs}` +
    `&endTime=${endMs}` +
    `&limit=${MAX_KLINES_PER_REQUEST}`;
  return limiter.schedule(async () => {
    const resp = await fetch(url);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(
        `binance klines ${resp.status} for ${symbol}: ${text.slice(0, 200)}`,
      );
    }
    return (await resp.json()) as BinanceKlineRow[];
  });
}

const upsert1mStmt = db.prepare(
  `INSERT OR REPLACE INTO candles_1m (asset_id, ts, o, h, l, c, v)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

function insertRows(assetId: number, rows: BinanceKlineRow[]): number {
  if (rows.length === 0) return 0;
  const tx = db.transaction((batch: BinanceKlineRow[]) => {
    for (const r of batch) {
      const ts = Math.floor(r[0] / 1000);
      upsert1mStmt.run(
        assetId,
        ts,
        parseFloat(r[1]),
        parseFloat(r[2]),
        parseFloat(r[3]),
        parseFloat(r[4]),
        parseFloat(r[5]),
      );
    }
  });
  tx(rows);
  return rows.length;
}

async function backfillOneAsset(asset: CryptoAssetRow): Promise<void> {
  const progressKey = `backfill_progress:${asset.symbol}`;
  const existing = readKv(progressKey);
  const endSec = nowSec();

  let cursorSec: number;
  if (existing?.completed) {
    // Past initial backfill. Resume from where we left off so we don't
    // pull the entire 90d window again on every restart.
    cursorSec = Math.max(existing.last_ts, endSec - HISTORY_SECONDS);
  } else if (existing && existing.last_ts > 0) {
    cursorSec = existing.last_ts;
  } else {
    cursorSec = endSec - HISTORY_SECONDS;
  }

  logger.info(
    { symbol: asset.symbol, fromTs: cursorSec, toTs: endSec },
    'binance backfill starting',
  );

  let totalRows = 0;
  let consecutiveEmpty = 0;

  while (cursorSec < endSec) {
    const startMs = cursorSec * 1000;
    // Binance inclusive endTime. Cap request window so we make progress.
    const endMs = Math.min(endSec * 1000, startMs + MAX_KLINES_PER_REQUEST * 60 * 1000);

    let rows: BinanceKlineRow[];
    try {
      rows = await fetchKlines(asset.symbol, startMs, endMs);
    } catch (err) {
      logger.error({ err, symbol: asset.symbol }, 'binance backfill fetch failed; retrying in 2s');
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    if (rows.length === 0) {
      consecutiveEmpty += 1;
      // No data for this window — advance cursor and try next.
      cursorSec = Math.floor(endMs / 1000);
      if (consecutiveEmpty >= 3) break;
      continue;
    }
    consecutiveEmpty = 0;

    totalRows += insertRows(asset.id, rows);
    const lastOpenMs = rows[rows.length - 1][0];
    const nextSec = Math.floor(lastOpenMs / 1000) + 60;
    if (nextSec <= cursorSec) {
      // Safety: no forward progress; bail to avoid infinite loop.
      break;
    }
    cursorSec = nextSec;
    writeKv(progressKey, { completed: false, last_ts: cursorSec });
  }

  writeKv(progressKey, { completed: true, last_ts: endSec });
  logger.info(
    { symbol: asset.symbol, rows: totalRows },
    'binance backfill complete',
  );
}

/**
 * Fetch ~90 days of 1m candles for every enabled Binance asset. Resumable
 * across restarts via the `kv` table.
 */
export async function backfillHistorical(): Promise<void> {
  const assets = getEnabledBinanceAssets();
  if (assets.length === 0) {
    logger.warn('backfillHistorical: no enabled binance assets');
    return;
  }
  logger.info({ count: assets.length }, 'backfillHistorical: begin');
  for (const asset of assets) {
    try {
      await backfillOneAsset(asset);
    } catch (err) {
      logger.error(
        { err, symbol: asset.symbol },
        'backfillHistorical: asset failed (continuing)',
      );
    }
  }
  logger.info('backfillHistorical: all assets done');
}

/**
 * Fill any gap between `fromTs` and now for a single asset. Called after a
 * WebSocket reconnect to recover missed candles.
 */
export async function backfillGap(assetId: number, fromTs: number): Promise<void> {
  const row = db
    .prepare(
      `SELECT id, symbol FROM assets
        WHERE id = ? AND type = 'crypto' AND exchange = 'binance'`,
    )
    .get(assetId) as CryptoAssetRow | undefined;
  if (!row) {
    logger.warn({ assetId }, 'backfillGap: asset not found or not binance');
    return;
  }
  const endSec = nowSec();
  if (fromTs >= endSec) return;

  // Small gaps only need a single request; larger gaps paginate.
  let cursorSec = fromTs;
  let total = 0;
  while (cursorSec < endSec) {
    const startMs = cursorSec * 1000;
    const endMs = Math.min(endSec * 1000, startMs + MAX_KLINES_PER_REQUEST * 60 * 1000);
    let rows: BinanceKlineRow[];
    try {
      rows = await fetchKlines(row.symbol, startMs, endMs);
    } catch (err) {
      logger.error({ err, symbol: row.symbol }, 'backfillGap: fetch failed');
      return;
    }
    if (rows.length === 0) break;
    total += insertRows(row.id, rows);
    const lastOpenMs = rows[rows.length - 1][0];
    const nextSec = Math.floor(lastOpenMs / 1000) + 60;
    if (nextSec <= cursorSec) break;
    cursorSec = nextSec;
  }
  if (total > 0) {
    logger.info({ symbol: row.symbol, rows: total, fromTs }, 'backfillGap filled');
  }
}

// ─── aggregation ────────────────────────────────────────────────────

interface TimeframeSpec {
  table: string;
  windowSec: number;
}

const TIMEFRAMES: TimeframeSpec[] = [
  { table: 'candles_3m', windowSec: 180 },
  { table: 'candles_15m', windowSec: 900 },
  { table: 'candles_1h', windowSec: 3600 },
  { table: 'candles_4h', windowSec: 14400 },
  { table: 'candles_1d', windowSec: 86400 },
  { table: 'candles_1w', windowSec: 604800 },
];

/**
 * Build `candles_{tf}` from `candles_1m` for buckets that started after
 * `sinceTs`. Uses SQLite window functions (available since 3.25).
 *
 * NOTE: better-sqlite3 ships a modern SQLite, so window functions and
 * `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` are supported.
 */
function aggregateTimeframe(spec: TimeframeSpec, sinceTs: number): number {
  const sql = `
    INSERT OR REPLACE INTO ${spec.table} (asset_id, ts, o, h, l, c, v)
    SELECT asset_id, bucket, first_o, max_h, min_l, last_c, sum_v FROM (
      SELECT
        asset_id,
        (ts / ${spec.windowSec}) * ${spec.windowSec} AS bucket,
        FIRST_VALUE(o) OVER (
          PARTITION BY asset_id, ts / ${spec.windowSec}
          ORDER BY ts
        ) AS first_o,
        MAX(h) OVER (
          PARTITION BY asset_id, ts / ${spec.windowSec}
        ) AS max_h,
        MIN(l) OVER (
          PARTITION BY asset_id, ts / ${spec.windowSec}
        ) AS min_l,
        LAST_VALUE(c) OVER (
          PARTITION BY asset_id, ts / ${spec.windowSec}
          ORDER BY ts
          ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
        ) AS last_c,
        SUM(v) OVER (
          PARTITION BY asset_id, ts / ${spec.windowSec}
        ) AS sum_v,
        ROW_NUMBER() OVER (
          PARTITION BY asset_id, ts / ${spec.windowSec}
          ORDER BY ts
        ) AS rn
      FROM candles_1m
      WHERE ts >= ?
    ) WHERE rn = 1
  `;
  const info = db.prepare(sql).run(sinceTs);
  return Number(info.changes);
}

/**
 * Recompute every higher timeframe table from candles_1m.
 *
 * @param sinceTs  Optional lower-bound ts (unix seconds). Only candles at or
 *                 after this ts are aggregated. Defaults to 0 (full rebuild).
 */
export async function aggregateAll(sinceTs = 0): Promise<void> {
  const started = Date.now();
  const summary: Record<string, number> = {};
  for (const spec of TIMEFRAMES) {
    try {
      const changes = aggregateTimeframe(spec, sinceTs);
      summary[spec.table] = changes;
    } catch (err) {
      logger.error({ err, table: spec.table }, 'aggregateAll: timeframe failed');
    }
  }
  logger.info(
    { summary, durationMs: Date.now() - started, sinceTs },
    'aggregateAll complete',
  );
}

/**
 * Hourly cron that re-aggregates the last ~2d of higher timeframes so that
 * newly-finalised 1m candles roll up into 3m/15m/1h/4h/1d/1w.
 *
 * Idempotent: INSERT OR REPLACE collapses bucket duplicates.
 */
export function startAggregationCron(): ScheduledTask {
  if (aggregationCronTask) return aggregationCronTask;
  // Run once at startup (non-blocking) then every hour on the 5-minute mark.
  aggregationCronTask = cron.schedule('5 * * * *', () => {
    // Rolling 2-day lookback keeps the weekly bucket current without
    // churning the entire history. For a full rebuild call aggregateAll(0).
    const lookbackSec = 2 * 24 * 3600;
    void aggregateAll(nowSec() - lookbackSec).catch((err) => {
      logger.error({ err }, 'aggregation cron failed');
    });
  });
  logger.info('aggregation cron started (hourly)');
  return aggregationCronTask;
}

export function stopAggregationCron(): void {
  if (aggregationCronTask) {
    aggregationCronTask.stop();
    aggregationCronTask = null;
  }
}
