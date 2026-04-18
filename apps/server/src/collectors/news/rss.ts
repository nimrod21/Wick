/**
 * RSS news collector.
 *
 * Every 5 minutes we fetch each feed from `seed/rss_feeds.json` using a
 * desktop browser UA (some outlets reject bare `node-fetch`-style UAs),
 * parse via `rss-parser`'s `parseString`, and normalise each item into a
 * `NewsEvent` on the shared bus.
 *
 * Deduplication is canonical-URL based: lowercase host, drop query params
 * (utm_*, fbclid, etc.), strip fragments, strip trailing slashes. Stored
 * in `events.dedup_key` (UNIQUE), so re-publishing the same URL across
 * feed runs is a no-op.
 *
 * Per item: `tagTickers` derives symbol mentions, `scoreSentiment` grades
 * the title+summary on `[-1, 1]`, and severity is `30` when any ticker
 * matched (brain-ready) vs `10` otherwise. When `|sentiment| >= 0.3` AND
 * at least one mention maps to a known asset we schedule forward-price
 * snapshots against that asset, so high-signal news builds up labelled
 * data for future bots (PLAN.md §12).
 *
 * Failures are isolated per-feed: a broken TLS or 5xx from one outlet
 * never kills the cron.
 */

import cron, { type ScheduledTask } from 'node-cron';
import Parser from 'rss-parser';
import type { NewsEvent } from '@cockpit/shared';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { logger } from '../../util/logger.js';
import { nowSec } from '../../util/time.js';
import { scheduleSnapshot, latestClose } from '../../core/snapshot-job.js';
import { tagTickers } from './ticker-tagger.js';
import { scoreSentiment } from './sentiment.js';
import feedSeed from '../../seed/rss_feeds.json' with { type: 'json' };

const TICK_CRON = '*/5 * * * *'; // every 5 minutes
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 10_000;
const SIGNIFICANT_SENT = 0.3;

interface FeedSeed {
  source: string;
  url: string;
  category: string;
}

const FEEDS: FeedSeed[] = (feedSeed as FeedSeed[]).filter(
  (f) => typeof f.url === 'string' && f.url.length > 0,
);

const parser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  headers: { 'User-Agent': BROWSER_UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
});

const insertEventStmt = db.prepare(
  `INSERT OR IGNORE INTO events
     (kind, source, ts, asset_id, severity, payload_json, dedup_key)
   VALUES ('news', ?, ?, ?, ?, ?, ?)`,
);

const assetBySymbolStmt = db.prepare(
  `SELECT id FROM assets WHERE symbol = ? LIMIT 1`,
);

let task: ScheduledTask | null = null;
let stopping = false;
let eventIdSeq = 1;
let currentTick: Promise<void> | null = null;

const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_name',
  'utm_id',
  'utm_reader',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'ref_url',
  '__source',
];

/**
 * Return a canonical form of `url` suitable for use as a dedup key across
 * RSS feeds that re-syndicate each other's stories.
 *
 * - host lowercased
 * - fragment removed
 * - `utm_*`, `fbclid`, etc. stripped
 * - trailing slash stripped (except root)
 *
 * If the URL fails to parse we return the trimmed original so it can
 * still serve as a less-ideal dedup key.
 */
export function canonicalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    for (const p of TRACKING_PARAMS) u.searchParams.delete(p);
    // Remove remaining query keys starting with utm_ (defensive).
    const toDelete: string[] = [];
    u.searchParams.forEach((_, key) => {
      if (key.toLowerCase().startsWith('utm_')) toDelete.push(key);
    });
    for (const k of toDelete) u.searchParams.delete(k);
    let out = u.toString();
    // Drop trailing slash unless the path is exactly "/".
    if (u.pathname !== '/' && out.endsWith('/')) out = out.slice(0, -1);
    return out;
  } catch {
    return trimmed;
  }
}

function nextEventId(): number {
  return eventIdSeq++;
}

function parseDateToSec(value: string | undefined, fallbackSec: number): number {
  if (!value) return fallbackSec;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return fallbackSec;
  return Math.floor(t / 1000);
}

/**
 * Best-effort mapping from a news ticker to an asset id in our DB.
 * Crypto tickers are stored as `${TICKER}USDT` via the Binance seed list;
 * stock tickers are stored as the raw symbol. Returns `null` if neither
 * form matches — in that case the caller skips snapshot scheduling.
 */
function resolveAssetIdForTicker(ticker: string): number | null {
  const cryptoRow = assetBySymbolStmt.get(`${ticker}USDT`) as
    | { id: number }
    | undefined;
  if (cryptoRow) return cryptoRow.id;
  const stockRow = assetBySymbolStmt.get(ticker) as { id: number } | undefined;
  return stockRow?.id ?? null;
}

async function fetchFeedXml(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept:
          'application/rss+xml, application/xml, text/xml, text/html;q=0.9, */*;q=0.1',
      },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      logger.warn({ url, status: resp.status }, 'rss fetch http error');
      return null;
    }
    return await resp.text();
  } catch (err) {
    logger.warn({ err, url }, 'rss fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface ProcessedItem {
  eventId: number;
  tickers: string[];
  sentiment: number | null;
}

function processItem(
  feed: FeedSeed,
  item: { title?: string; link?: string; pubDate?: string; isoDate?: string; summary?: string; contentSnippet?: string; content?: string },
): ProcessedItem | null {
  const title = (item.title ?? '').trim();
  const rawUrl = (item.link ?? '').trim();
  if (!title || !rawUrl) return null;

  const dedupKey = canonicalizeUrl(rawUrl);
  const summary = (item.contentSnippet ?? item.summary ?? '').trim() || undefined;
  const tickers = tagTickers(title, summary);
  const sentiment = scoreSentiment(title, summary);
  const severity = tickers.length > 0 ? 30 : 10;
  const ts = parseDateToSec(item.isoDate ?? item.pubDate, nowSec());

  const payload = {
    title,
    url: rawUrl,
    summary: summary ?? null,
    tickers,
    sentiment,
    category: feed.category,
    source: feed.source,
  };

  let info: { changes: number; lastInsertRowid: number | bigint };
  try {
    info = insertEventStmt.run(
      feed.source,
      ts,
      null,
      severity,
      JSON.stringify(payload),
      dedupKey,
    );
  } catch (err) {
    logger.error({ err, url: rawUrl }, 'rss insert failed');
    return null;
  }
  if (info.changes === 0) return null;

  const eventId = Number(info.lastInsertRowid);
  const evt: NewsEvent = {
    id: nextEventId(),
    ts,
    source: feed.source,
    severity,
    kind: 'news',
    title,
    url: rawUrl,
    tickers,
    ...(summary ? { summary } : {}),
    ...(sentiment !== null ? { sentiment } : {}),
  };
  eventBus.emit(evt);

  return { eventId, tickers, sentiment };
}

function maybeScheduleSnapshots(
  eventId: number,
  tickers: string[],
  sentiment: number | null,
): void {
  if (sentiment === null) return;
  if (Math.abs(sentiment) < SIGNIFICANT_SENT) return;
  if (tickers.length === 0) return;
  for (const ticker of tickers) {
    const assetId = resolveAssetIdForTicker(ticker);
    if (assetId === null) continue;
    const price = latestClose(assetId);
    if (price === null) continue;
    scheduleSnapshot(eventId, assetId, price);
  }
}

async function pollFeed(feed: FeedSeed): Promise<number> {
  const xml = await fetchFeedXml(feed.url);
  if (!xml) return 0;
  let parsed: Awaited<ReturnType<typeof parser.parseString>>;
  try {
    parsed = await parser.parseString(xml);
  } catch (err) {
    logger.warn({ err, source: feed.source }, 'rss parse failed');
    return 0;
  }
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  let inserted = 0;
  for (const it of items) {
    if (stopping) return inserted;
    const res = processItem(feed, it);
    if (!res) continue;
    inserted += 1;
    maybeScheduleSnapshots(res.eventId, res.tickers, res.sentiment);
  }
  return inserted;
}

export async function rssTick(): Promise<void> {
  if (stopping) return;
  if (FEEDS.length === 0) return;
  let total = 0;
  for (const feed of FEEDS) {
    if (stopping) return;
    try {
      const n = await pollFeed(feed);
      if (n > 0) {
        logger.info({ source: feed.source, inserted: n }, 'rss tick: new items');
        total += n;
      }
    } catch (err) {
      logger.warn({ err, source: feed.source }, 'rss tick: feed failed');
    }
  }
  if (total > 0) logger.info({ total }, 'rss tick complete');
}

export function startRssNews(): void {
  stopping = false;
  if (task) return;
  task = cron.schedule(TICK_CRON, () => {
    if (currentTick) return;
    currentTick = rssTick().finally(() => {
      currentTick = null;
    });
  });
  // Kick once at boot so we don't wait a full interval for first items.
  currentTick = rssTick().finally(() => {
    currentTick = null;
  });
  logger.info({ feeds: FEEDS.length }, 'rss news collector started');
}

export function stopRssNews(): void {
  stopping = true;
  if (task) {
    try {
      task.stop();
    } catch (err) {
      logger.error({ err }, 'rss: stop failed');
    }
    task = null;
  }
}
