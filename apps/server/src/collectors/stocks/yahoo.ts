/**
 * Yahoo Finance fallback collector.
 *
 * Keyless, rate-limit-tolerant. Acts as a stale-data watchdog: only polls
 * assets whose last candles_1m row is older than 10 minutes. Twelve Data is
 * the primary feed — Yahoo only covers the gap when that feed is dark.
 *
 * Commodities use futures proxy symbols on Yahoo (GC=F, SI=F, CL=F) since
 * Yahoo does not expose XAU/USD spot directly.
 */

import yf from 'yahoo-finance2';
import type { PriceCandleEvent } from '@cockpit/shared';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { logger } from '../../util/logger.js';
import { nowSec, startOfMinute } from '../../util/time.js';
import { isMarketOpen } from '../../util/market-hours.js';

interface YahooAssetRow {
  id: number;
  symbol: string;
  type: 'stock' | 'commodity' | 'etf' | 'forex' | 'index';
  metadata_json: string | null;
}

const STALE_SECONDS = 10 * 60;

const COMMODITY_YAHOO_SYMBOLS: Record<string, string> = {
  'XAU/USD': 'GC=F',
  'XAG/USD': 'SI=F',
  'WTI/USD': 'CL=F',
};

let stopping = false;
let initialized = false;
let eventIdSeq = 1;
const lastEmittedPrice = new Map<number, number>();

const upsert1mStmt = db.prepare(
  `INSERT OR REPLACE INTO candles_1m (asset_id, ts, o, h, l, c, v)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

const latestCandleTsStmt = db.prepare(
  `SELECT MAX(ts) AS ts FROM candles_1m WHERE asset_id = ?`,
);

function nextEventId(): number {
  return eventIdSeq++;
}

function initialize(): void {
  if (initialized) return;
  initialized = true;
  try {
    // Newer versions expose suppressNotices on the default export. Older builds
    // may not. Guard with an optional call.
    (yf as { suppressNotices?: (names: string[]) => void }).suppressNotices?.([
      'yahooSurvey',
    ]);
  } catch {
    /* ignore */
  }
}

function getYahooAssets(): YahooAssetRow[] {
  return db
    .prepare(
      `SELECT id, symbol, type, metadata_json FROM assets
        WHERE enabled = 1
          AND (type = 'stock' OR exchange = 'twelvedata')
        ORDER BY id`,
    )
    .all() as YahooAssetRow[];
}

function yahooSymbolFor(row: YahooAssetRow): string | null {
  if (row.type === 'commodity') {
    const mapped = COMMODITY_YAHOO_SYMBOLS[row.symbol];
    if (!mapped) return null;
    return mapped;
  }
  if (row.metadata_json) {
    try {
      const meta = JSON.parse(row.metadata_json) as {
        yahoo_symbol?: string;
      };
      if (meta.yahoo_symbol) return meta.yahoo_symbol;
    } catch {
      /* fall through */
    }
  }
  return row.symbol;
}

function getLatestCandleTs(assetId: number): number {
  const row = latestCandleTsStmt.get(assetId) as { ts: number | null } | undefined;
  return row?.ts ?? 0;
}

interface YahooQuote {
  regularMarketPrice?: number;
  regularMarketTime?: Date | number;
  regularMarketVolume?: number;
}

async function fetchQuote(symbol: string): Promise<YahooQuote | null> {
  try {
    // The SDK's default export is the library object; `.quote` is the method.
    const client = yf as unknown as {
      quote: (s: string) => Promise<YahooQuote>;
    };
    return await client.quote(symbol);
  } catch (err) {
    logger.warn({ err, symbol }, 'yahoo quote failed');
    return null;
  }
}

function quoteTsSec(q: YahooQuote): number {
  const t = q.regularMarketTime;
  if (t instanceof Date) return Math.floor(t.getTime() / 1000);
  if (typeof t === 'number') {
    // Yahoo sometimes returns seconds, sometimes milliseconds.
    return t > 10_000_000_000 ? Math.floor(t / 1000) : t;
  }
  return nowSec();
}

/**
 * One scheduler tick: poll any asset whose latest 1m candle is >10 min old
 * and emit a synthetic bar if the quote comes back fresh.
 */
export async function yahooTick(): Promise<void> {
  if (stopping) return;
  if (!initialized) initialize();
  // Yahoo covers US equities + commodities (via futures proxies). If none of
  // those markets is open, bail early.
  if (
    !isMarketOpen('us_equities') &&
    !isMarketOpen('commodities_futures') &&
    !isMarketOpen('forex')
  ) {
    return;
  }

  const assets = getYahooAssets();
  const now = nowSec();
  for (const asset of assets) {
    if (stopping) return;
    try {
      const latestTs = getLatestCandleTs(asset.id);
      if (latestTs && now - latestTs < STALE_SECONDS) continue; // primary feed still fresh
      const ysym = yahooSymbolFor(asset);
      if (!ysym) continue;
      const quote = await fetchQuote(ysym);
      if (!quote || typeof quote.regularMarketPrice !== 'number') continue;
      const price = quote.regularMarketPrice;
      if (!Number.isFinite(price)) continue;

      const ts = startOfMinute(quoteTsSec(quote));
      if (ts <= latestTs) continue; // already have a fresher or equal bar
      const vol = Number.isFinite(quote.regularMarketVolume)
        ? Number(quote.regularMarketVolume)
        : 0;
      upsert1mStmt.run(asset.id, ts, price, price, price, price, vol);

      const previous = lastEmittedPrice.get(asset.id);
      if (previous === price) continue; // don't spam
      lastEmittedPrice.set(asset.id, price);

      const evt: PriceCandleEvent = {
        id: nextEventId(),
        ts,
        source: 'yahoo',
        kind: 'candle',
        assetId: asset.id,
        timeframe: '1m',
        o: price,
        h: price,
        l: price,
        c: price,
        v: vol,
      };
      eventBus.emit(evt);
    } catch (err) {
      logger.error(
        { err, symbol: asset.symbol },
        'yahoo tick: asset failed (continuing)',
      );
    }
  }
}

export function startYahoo(): void {
  stopping = false;
  initialize();
  logger.info('yahoo fallback collector enabled');
}

export function stopYahoo(): void {
  stopping = true;
}
