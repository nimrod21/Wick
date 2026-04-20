/**
 * Finnhub news collector.
 *
 * Phase 3 scope: per-ticker company news only. Stock-coverage fallback is
 * deferred. Polled every 15 minutes during US equities hours; articles are
 * deduplicated by URL via the `events.dedup_key` UNIQUE index and re-emitted
 * on the event bus.
 *
 * Endpoint: GET /api/v1/company-news?symbol=X&from=YYYY-MM-DD&to=YYYY-MM-DD&token=K
 */

import type { NewsEvent } from '@cockpit/shared';
import { getApiKey } from '../../config.js';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { getLimiter } from '../../util/rate-limiter.js';
import { logger } from '../../util/logger.js';
import { nowSec } from '../../util/time.js';
import { isMarketOpen } from '../../util/market-hours.js';

const BASE_URL = 'https://finnhub.io/api/v1';

interface StockRow {
  id: number;
  symbol: string;
}

interface FinnhubNewsItem {
  category: string;
  datetime: number; // unix seconds
  headline: string;
  id: number;
  image?: string;
  related: string;
  source: string;
  summary?: string;
  url: string;
}

let apiKey: string | null = null;
let stopping = false;
let eventIdSeq = 1;

const limiter = getLimiter('finnhub', { minTime: 1100, maxConcurrent: 1 });

const insertEventStmt = db.prepare(
  `INSERT OR IGNORE INTO events
     (kind, source, ts, asset_id, severity, payload_json, dedup_key)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

function nextEventId(): number {
  return eventIdSeq++;
}

function getEnabledStocks(): StockRow[] {
  return db
    .prepare(
      `SELECT id, symbol FROM assets
        WHERE type = 'stock' AND enabled = 1
        ORDER BY id`,
    )
    .all() as StockRow[];
}

function ymdUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${y}-${p(m)}-${p(day)}`;
}

async function fetchCompanyNews(
  ticker: string,
): Promise<FinnhubNewsItem[] | null> {
  if (!apiKey) return null;
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const from = ymdUtc(yesterday);
  const to = ymdUtc(today);
  const url =
    `${BASE_URL}/company-news` +
    `?symbol=${encodeURIComponent(ticker)}` +
    `&from=${from}` +
    `&to=${to}` +
    `&token=${encodeURIComponent(apiKey)}`;
  return limiter.schedule(async () => {
    const resp = await fetch(url);
    if (resp.status === 429) {
      logger.warn({ ticker }, 'finnhub 429: rate limited');
      return null;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      logger.error(
        { ticker, status: resp.status, body: text.slice(0, 200) },
        'finnhub http error',
      );
      return null;
    }
    try {
      const data = (await resp.json()) as FinnhubNewsItem[];
      return Array.isArray(data) ? data : [];
    } catch (err) {
      logger.error({ err, ticker }, 'finnhub bad json');
      return null;
    }
  });
}

function persistAndEmit(
  asset: StockRow,
  articles: FinnhubNewsItem[],
): number {
  let emitted = 0;
  for (const a of articles) {
    if (!a.url || !a.headline) continue;
    const ts = Number.isFinite(a.datetime) ? a.datetime : nowSec();
    const payload = {
      title: a.headline,
      url: a.url,
      source: `finnhub:${asset.symbol}`,
      summary: a.summary ?? a.headline,
      tickers: [asset.symbol],
      sentiment: null as number | null,
    };
    let inserted: { changes: number };
    try {
      inserted = insertEventStmt.run(
        'news',
        `finnhub:${asset.symbol}`,
        ts,
        asset.id,
        0,
        JSON.stringify(payload),
        a.url,
      );
    } catch (err) {
      logger.error({ err, ticker: asset.symbol, url: a.url }, 'finnhub insert failed');
      continue;
    }
    // Only emit when this article is genuinely new (dedup not triggered).
    if (inserted.changes > 0) {
      const evt: NewsEvent = {
        id: nextEventId(),
        ts,
        source: `finnhub:${asset.symbol}`,
        kind: 'news',
        title: payload.title,
        url: payload.url,
        summary: payload.summary,
        tickers: payload.tickers,
      };
      eventBus.emit(evt);
      emitted += 1;
    }
  }
  return emitted;
}

/**
 * Cron-driven tick. Fetches company-news for every enabled stock if the US
 * equity market is currently open. Silently skips when disabled. Re-reads
 * the API key each run so Settings-paste takes effect without a restart.
 */
export async function finnhubNewsTick(): Promise<void> {
  if (stopping) return;
  // Hot-reload: re-read the key every tick.
  const creds = getApiKey('finnhub');
  apiKey = creds?.key ?? null;
  if (!apiKey) return; // silently skip this tick
  if (!isMarketOpen('us_equities')) return;
  const stocks = getEnabledStocks();
  for (const s of stocks) {
    if (stopping) return;
    try {
      const items = await fetchCompanyNews(s.symbol);
      if (!items) continue;
      const emitted = persistAndEmit(s, items);
      if (emitted > 0) {
        logger.info(
          { ticker: s.symbol, fetched: items.length, emitted },
          'finnhub news tick: new articles',
        );
      }
    } catch (err) {
      logger.error(
        { err, ticker: s.symbol },
        'finnhub news tick: ticker failed (continuing)',
      );
    }
  }
}

export function startFinnhubNews(): void {
  stopping = false;
  // Tick re-reads the key each run; just cache the current value for
  // isFinnhubEnabled() visibility.
  const creds = getApiKey('finnhub');
  apiKey = creds?.key ?? null;
  if (apiKey) {
    logger.info('finnhub news collector enabled');
  } else {
    logger.info('finnhub: no API key yet — scheduler will activate on Settings save');
  }
}

export function stopFinnhubNews(): void {
  stopping = true;
  apiKey = null;
}

export function isFinnhubEnabled(): boolean {
  return apiKey !== null;
}
