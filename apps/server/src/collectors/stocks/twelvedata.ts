/**
 * Twelve Data collector — primary feed for stocks + spot commodities
 * (XAU/USD, XAG/USD, WTI/USD).
 *
 * Free tier: 8 req/min, 800 req/day. We poll one asset per tick (the 60s
 * cron in scheduler.ts calls us repeatedly) so the reservoir budget is spread
 * naturally across the watchlist.
 *
 * Endpoint: GET /time_series?symbol=X&interval=1min&outputsize=N&apikey=KEY
 */

import type { PriceCandleEvent } from '@cockpit/shared';
import { getApiKey } from '../../config.js';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { getLimiter } from '../../util/rate-limiter.js';
import { logger } from '../../util/logger.js';
import { nowSec } from '../../util/time.js';
import {
  isMarketOpen,
  type MarketType,
} from '../../util/market-hours.js';

const BASE_URL = 'https://api.twelvedata.com';
const BACKFILL_OUTPUT_SIZE = 5000;
const POLL_OUTPUT_SIZE = 2;

interface TwelveDataAssetRow {
  id: number;
  symbol: string;
  type: 'stock' | 'commodity' | 'etf' | 'forex' | 'index';
}

interface TwelveDataValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

interface TwelveDataOk {
  meta: {
    symbol: string;
    interval: string;
    currency?: string;
    exchange_timezone?: string;
    type?: string;
  };
  values: TwelveDataValue[];
  status?: 'ok';
}

interface TwelveDataError {
  status: 'error';
  code?: number;
  message?: string;
}

type TwelveDataResponse = TwelveDataOk | TwelveDataError;

let apiKey: string | null = null;
let stopping = false;
let rateLimitBackoffUntilMs = 0;
let eventIdSeq = 1;

const limiter = getLimiter('twelvedata', {
  minTime: 7500,
  reservoir: 800,
  reservoirRefreshAmount: 800,
  reservoirRefreshInterval: 24 * 60 * 60 * 1000,
  maxConcurrent: 1,
});

const upsert1mStmt = db.prepare(
  `INSERT OR REPLACE INTO candles_1m (asset_id, ts, o, h, l, c, v)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

function nextEventId(): number {
  return eventIdSeq++;
}

function getTwelveDataAssets(): TwelveDataAssetRow[] {
  return db
    .prepare(
      `SELECT id, symbol, type FROM assets
        WHERE enabled = 1
          AND (type = 'stock' OR exchange = 'twelvedata')
        ORDER BY id`,
    )
    .all() as TwelveDataAssetRow[];
}

function marketTypeForAsset(row: TwelveDataAssetRow): MarketType {
  if (row.type === 'stock' || row.type === 'etf' || row.type === 'index') {
    return 'us_equities';
  }
  // XAU/USD, XAG/USD, WTI/USD trade as spot against forex sessions.
  return 'commodities_futures';
}

function readKvString(key: string): string | null {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as
    | { v: string }
    | undefined;
  return row?.v ?? null;
}

function writeKvString(key: string, value: string): void {
  db.prepare(
    `INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
  ).run(key, value, nowSec());
}

function backfillKey(symbol: string): string {
  return `backfill_progress_td:${symbol}`;
}

function isBackfillComplete(symbol: string): boolean {
  const raw = readKvString(backfillKey(symbol));
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { completed?: boolean };
    return parsed.completed === true;
  } catch {
    return false;
  }
}

function markBackfillComplete(symbol: string, lastTs: number): void {
  writeKvString(
    backfillKey(symbol),
    JSON.stringify({ completed: true, last_ts: lastTs }),
  );
}

/**
 * Parse Twelve Data's `datetime` string (UTC, minute-aligned) into unix
 * seconds. Accepts both "YYYY-MM-DD HH:MM:SS" and "YYYY-MM-DD" shapes.
 */
function parseTwelveDataTs(raw: string): number {
  const trimmed = raw.trim();
  const isoish = trimmed.includes(' ')
    ? trimmed.replace(' ', 'T') + 'Z'
    : trimmed + 'T00:00:00Z';
  const ms = Date.parse(isoish);
  if (!Number.isFinite(ms)) return 0;
  return Math.floor(ms / 1000);
}

async function fetchTimeSeries(
  symbol: string,
  outputSize: number,
): Promise<TwelveDataResponse | null> {
  if (!apiKey) return null;
  const url =
    `${BASE_URL}/time_series` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=1min` +
    `&outputsize=${outputSize}` +
    `&apikey=${encodeURIComponent(apiKey)}`;

  return limiter.schedule(async () => {
    const resp = await fetch(url);
    if (resp.status === 429) {
      rateLimitBackoffUntilMs = Date.now() + 60_000;
      logger.warn({ symbol }, 'twelvedata 429: backing off 60s');
      return { status: 'error', code: 429, message: 'rate limited' };
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      logger.error(
        { symbol, status: resp.status, body: text.slice(0, 200) },
        'twelvedata http error',
      );
      return null;
    }
    try {
      return (await resp.json()) as TwelveDataResponse;
    } catch (err) {
      logger.error({ err, symbol }, 'twelvedata bad json');
      return null;
    }
  });
}

function insertValues(
  assetId: number,
  values: TwelveDataValue[],
): { inserted: number; latestTs: number } {
  if (values.length === 0) return { inserted: 0, latestTs: 0 };
  let latestTs = 0;
  const tx = db.transaction((rows: TwelveDataValue[]) => {
    for (const v of rows) {
      const ts = parseTwelveDataTs(v.datetime);
      if (!ts) continue;
      const o = parseFloat(v.open);
      const h = parseFloat(v.high);
      const l = parseFloat(v.low);
      const c = parseFloat(v.close);
      const vol = v.volume !== undefined ? parseFloat(v.volume) : 0;
      if (![o, h, l, c].every(Number.isFinite)) continue;
      upsert1mStmt.run(assetId, ts, o, h, l, c, Number.isFinite(vol) ? vol : 0);
      if (ts > latestTs) latestTs = ts;
    }
  });
  tx(values);
  return { inserted: values.length, latestTs };
}

function emitLatestCandle(
  assetId: number,
  v: TwelveDataValue,
  source: string,
): void {
  const ts = parseTwelveDataTs(v.datetime);
  if (!ts) return;
  const o = parseFloat(v.open);
  const h = parseFloat(v.high);
  const l = parseFloat(v.low);
  const c = parseFloat(v.close);
  const vol = v.volume !== undefined ? parseFloat(v.volume) : 0;
  if (![o, h, l, c].every(Number.isFinite)) return;
  const evt: PriceCandleEvent = {
    id: nextEventId(),
    ts,
    source,
    kind: 'candle',
    assetId,
    timeframe: '1m',
    o,
    h,
    l,
    c,
    v: Number.isFinite(vol) ? vol : 0,
  };
  eventBus.emit(evt);
}

async function backfillOne(asset: TwelveDataAssetRow): Promise<void> {
  if (isBackfillComplete(asset.symbol)) return;
  logger.info({ symbol: asset.symbol }, 'twelvedata backfill starting');
  const resp = await fetchTimeSeries(asset.symbol, BACKFILL_OUTPUT_SIZE);
  if (!resp) return;
  if ('status' in resp && resp.status === 'error') {
    logger.error(
      { symbol: asset.symbol, code: resp.code, message: resp.message },
      'twelvedata backfill error',
    );
    return;
  }
  const ok = resp as TwelveDataOk;
  const values = ok.values ?? [];
  const { inserted, latestTs } = insertValues(asset.id, values);
  markBackfillComplete(asset.symbol, latestTs);
  logger.info(
    { symbol: asset.symbol, rows: inserted, latestTs },
    'twelvedata backfill complete',
  );
}

async function pollOne(asset: TwelveDataAssetRow): Promise<void> {
  if (Date.now() < rateLimitBackoffUntilMs) return;
  const resp = await fetchTimeSeries(asset.symbol, POLL_OUTPUT_SIZE);
  if (!resp) return;
  if ('status' in resp && resp.status === 'error') {
    // 429 already logged + sets backoff. Others just log.
    if (resp.code !== 429) {
      logger.warn(
        { symbol: asset.symbol, code: resp.code, message: resp.message },
        'twelvedata poll error',
      );
    }
    return;
  }
  const ok = resp as TwelveDataOk;
  const values = ok.values ?? [];
  if (values.length === 0) return;
  insertValues(asset.id, values);
  // Emit only the latest bar to avoid spamming subscribers on each 60s tick.
  emitLatestCandle(asset.id, values[0], 'twelvedata');
}

/**
 * Cron-driven tick. Iterates every enabled asset, polling the ones whose
 * market is currently open. Backfills assets that have not completed yet.
 *
 * Designed to be safe to re-enter — the Bottleneck limiter serialises the
 * actual HTTP calls.
 */
export async function twelveDataTick(): Promise<void> {
  if (stopping || !apiKey) return;
  const assets = getTwelveDataAssets();
  for (const asset of assets) {
    if (stopping) return;
    try {
      if (!isBackfillComplete(asset.symbol)) {
        await backfillOne(asset);
        continue;
      }
      const mkt = marketTypeForAsset(asset);
      if (!isMarketOpen(mkt)) continue;
      await pollOne(asset);
    } catch (err) {
      logger.error(
        { err, symbol: asset.symbol },
        'twelvedata tick: asset failed (continuing)',
      );
    }
  }
}

export function startTwelveData(): void {
  stopping = false;
  const creds = getApiKey('twelvedata');
  if (!creds || !creds.key) {
    logger.warn('twelvedata: no API key configured — collector disabled');
    apiKey = null;
    return;
  }
  apiKey = creds.key;
  logger.info('twelvedata collector enabled');
  // Kick off immediately so backfill starts at boot without waiting for
  // the first scheduler tick.
  void twelveDataTick().catch((err) => {
    logger.error({ err }, 'twelvedata initial tick failed');
  });
}

export function stopTwelveData(): void {
  stopping = true;
  apiKey = null;
}

export function isTwelveDataEnabled(): boolean {
  return apiKey !== null;
}
