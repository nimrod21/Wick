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

/** Watchlist seeding (IMPL-6B): how many USDT pairs the first boot installs. */
const SEED_TARGET = 50;
/** A list this long is the user's own — seed it once, never re-seed. */
const SEED_MARKER = 'watchlist.top_seeded';
/**
 * Bases that are not a crypto trade, matched by naming convention rather than
 * a list that would need maintaining: `USD…` (USDC, USD1, USDP, USDE…),
 * `…USD` (FDUSD, RLUSD, PYUSD…) and `EUR…` cover the stablecoins, the rest
 * are fiat tokens and metal trackers (the macro board already owns gold).
 * Leveraged UP/DOWN/BULL/BEAR/3L/3S products are excluded separately.
 */
const STABLE_BASES = /^USD|USD$|^EUR|^(DAI|FRAX|GBP|TRY|BRL|ARS|JPY|PAXG|XAUT)$/;
const LEVERAGED_BASES = /(UP|DOWN|BULL|BEAR)$|\d(L|S)$/;

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

/**
 * exchangeInfo gate for the watchlist: a symbol only counts if Binance spot
 * trades it right now. Cached 1h — the list is ~2500 symbols and changes
 * rarely. On a network failure callers get `null` and must REJECT the add
 * (better a retry than a symbol the collectors can never fill).
 */
let symbolCache: { ts: number; symbols: Set<string> } | null = null;
const SYMBOL_CACHE_TTL_MS = 60 * 60_000;

export async function tradableSymbols(): Promise<Set<string> | null> {
  if (symbolCache && nowMs() - symbolCache.ts < SYMBOL_CACHE_TTL_MS) return symbolCache.symbols;
  try {
    const res = await fetch(`${BASE_URL}/api/v3/exchangeInfo?permissions=SPOT`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { symbols?: Array<{ symbol?: string; status?: string }> };
    if (!Array.isArray(body.symbols)) return null;
    const set = new Set<string>();
    for (const s of body.symbols) {
      if (typeof s.symbol === 'string' && s.status === 'TRADING') set.add(s.symbol.toUpperCase());
    }
    if (set.size === 0) return null;
    symbolCache = { ts: nowMs(), symbols: set };
    return set;
  } catch (err) {
    logger.warn({ err }, 'exchangeInfo fetch failed');
    return null;
  }
}

/**
 * One-time watchlist expansion (IMPL-6B): top-`SEED_TARGET` Binance USDT
 * pairs by 24h quote volume, appended AFTER the seven seeded defaults (which
 * keep their earlier `added_ts`, so "the 7 first" survives every ordering).
 *
 * Runs at boot before the WS/backfill so the collectors see the full list on
 * the first pass. Guarded by a settings marker rather than a row count: once
 * seeded, a watchlist the user has since trimmed is never refilled behind
 * their back. A failed fetch leaves the marker unset — it simply retries next
 * boot, and the 7 defaults keep the app running meanwhile.
 */
export async function seedTopVolumeSymbols(): Promise<void> {
  const marked = db.prepare('SELECT 1 FROM settings WHERE key = ?').get(SEED_MARKER);
  if (marked) return;

  const { count } = db.prepare('SELECT COUNT(*) AS count FROM assets').get() as { count: number };
  const markDone = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  if (count >= SEED_TARGET) {
    markDone.run(SEED_MARKER, JSON.stringify({ ts: nowMs(), added: 0, reason: 'already full' }));
    return;
  }

  const tradable = await tradableSymbols();
  if (tradable === null) {
    logger.warn('watchlist seed: exchangeInfo unavailable, will retry next boot');
    return;
  }

  let tickers: Array<{ symbol: string; quoteVolume: string }>;
  try {
    const res = await fetch(`${BASE_URL}/api/v3/ticker/24hr`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`ticker/24hr ${res.status}`);
    tickers = (await res.json()) as Array<{ symbol: string; quoteVolume: string }>;
  } catch (err) {
    logger.warn({ err }, 'watchlist seed: 24h ticker unavailable, will retry next boot');
    return;
  }

  const existing = new Set(
    (db.prepare('SELECT symbol FROM assets').all() as Array<{ symbol: string }>).map(
      (r) => r.symbol,
    ),
  );
  const ranked = tickers
    .filter((t) => typeof t.symbol === 'string' && t.symbol.endsWith('USDT'))
    .map((t) => ({ symbol: t.symbol, base: t.symbol.slice(0, -4), volume: Number(t.quoteVolume) }))
    .filter(
      (t) =>
        Number.isFinite(t.volume) &&
        t.volume > 0 &&
        tradable.has(t.symbol) &&
        !existing.has(t.symbol) &&
        !STABLE_BASES.test(t.base) &&
        !LEVERAGED_BASES.test(t.base),
    )
    .sort((a, b) => b.volume - a.volume)
    .slice(0, Math.max(0, SEED_TARGET - count));

  const insert = db.prepare(
    'INSERT OR IGNORE INTO assets (symbol, display_name, active, added_ts) VALUES (?, ?, 1, ?)',
  );
  const ts = nowMs();
  db.transaction(() => {
    for (const r of ranked) insert.run(r.symbol, r.base, ts);
    markDone.run(SEED_MARKER, JSON.stringify({ ts, added: ranked.length }));
  })();
  logger.info(
    { added: ranked.length, total: count + ranked.length, top: ranked.slice(0, 5).map((r) => r.base) },
    'watchlist seeded from 24h volume',
  );
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
 * 1m/15m/1h/4h/1d. At the IMPL-6B watchlist size that is 50 × 5 = 250
 * requests ≈ 45 s at 160 ms spacing (weight 2 each → ~750/min, well inside
 * Binance's 1200/min budget). Staged/lazy backfill is therefore unnecessary.
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
