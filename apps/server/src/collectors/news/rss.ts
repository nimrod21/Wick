/**
 * News collector — RSS poller for the three keyless crypto feeds verified in
 * RESEARCH.md (CoinDesk, Cointelegraph, Decrypt). 5-minute cycle, browser UA
 * (some outlets 403 a bare node UA), per-feed failure isolation.
 *
 * Pattern is fear-greed's: poll on a cron, tolerate every network failure
 * silently (warn + keep the last-known DB contents), never let one broken
 * feed take the cycle down.
 *
 * XML is extracted by hand rather than adding a parser dependency: these are
 * three known RSS 2.0 feeds, and all we need per item is title / link / guid
 * / pubDate / description. `extractItems` is exported so the shape stays
 * testable without a network call.
 *
 * Dedupe is on the CANONICAL url (tracking params stripped, fragment gone,
 * trailing slash dropped) which is the UNIQUE column on `news_items`; feeds
 * that re-syndicate each other collapse to one row. Items whose <link> is
 * missing fall back to their <guid> when that is a permalink.
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { NewsEvent } from '@wick/shared';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { logger } from '../../util/logger.js';
import { nowMs } from '../../util/time.js';
import { tagTickers, baseTicker } from './ticker-tagger.js';
import { scoreSentiment } from './sentiment.js';

const TICK_CRON = '*/5 * * * *';
const FETCH_TIMEOUT_MS = 12_000;
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Verified live 2026-08-10 (RESEARCH.md §News). Keyless. */
export const FEEDS: Array<{ source: string; url: string }> = [
  { source: 'coindesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { source: 'cointelegraph', url: 'https://cointelegraph.com/rss' },
  { source: 'decrypt', url: 'https://decrypt.co/feed' },
];

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Items older than this at insert time are stored but not broadcast. */
const EVENT_MAX_AGE_MS = 6 * HOUR_MS;

// ── minimal XML extraction ─────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'",
};

/** Decode CDATA + the handful of entities that actually appear in RSS text. */
export function decodeXmlText(raw: string): string {
  let out = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  out = out.replace(/<[^>]+>/g, ' '); // strip nested markup (description HTML)
  out = out.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name: string) => {
    const key = name.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
  return out.replace(/\s+/g, ' ').trim();
}

/** First `<tag>…</tag>` inside `block`, decoded. Null when absent/empty. */
function tagValue(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = re.exec(block);
  if (!m || m[1] === undefined) return null;
  const value = decodeXmlText(m[1]);
  return value.length > 0 ? value : null;
}

export interface RawItem {
  title: string | null;
  link: string | null;
  guid: string | null;
  pubDate: string | null;
  description: string | null;
}

/** Split an RSS/Atom document into its `<item>` (or `<entry>`) records. */
export function extractItems(xml: string): RawItem[] {
  const blocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ];
  return blocks.map((m) => {
    const block = m[1] ?? '';
    // Atom puts the url in <link href="…"/>; RSS in <link>…</link>.
    const atomHref = /<link[^>]*\bhref=["']([^"']+)["']/i.exec(block)?.[1] ?? null;
    return {
      title: tagValue(block, 'title'),
      link: atomHref ?? tagValue(block, 'link'),
      guid: tagValue(block, 'guid') ?? tagValue(block, 'id'),
      pubDate: tagValue(block, 'pubDate') ?? tagValue(block, 'published') ?? tagValue(block, 'dc:date'),
      description: tagValue(block, 'description') ?? tagValue(block, 'summary'),
    };
  });
}

const TRACKING_PARAM_PREFIXES = ['utm_'];
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', 'ref_url', '__source', 'source',
]);

/** Canonical dedupe key: lowercase host, no fragment, no tracking params. */
export function canonicalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    const drop: string[] = [];
    u.searchParams.forEach((_, key) => {
      const k = key.toLowerCase();
      if (TRACKING_PARAMS.has(k) || TRACKING_PARAM_PREFIXES.some((p) => k.startsWith(p))) {
        drop.push(key);
      }
    });
    for (const k of drop) u.searchParams.delete(k);
    let out = u.toString();
    if (u.pathname !== '/' && out.endsWith('/')) out = out.slice(0, -1);
    return out;
  } catch {
    return trimmed;
  }
}

// ── collector ──────────────────────────────────────────────────────────

let task: ScheduledTask | null = null;
let stopping = false;
let currentTick: Promise<void> | null = null;
let eventIdSeq = 1;
let lastTickTs: number | null = null;

const insertStmt = db.prepare(
  `INSERT OR IGNORE INTO news_items (ts, source, title, url, assets_json, sentiment)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

function parseTs(value: string | null): number {
  if (!value) return nowMs();
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : nowMs();
}

async function fetchFeed(url: string): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/rss+xml, application/xml, text/xml, */*;q=0.1',
      },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      logger.warn({ url, status: resp.status }, 'rss: http error');
      return null;
    }
    return await resp.text();
  } catch (err) {
    logger.warn({ err, url }, 'rss: fetch failed (keeping stored items)');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function pollFeedXml(source: string, xml: string): number {
  const items = extractItems(xml);
  const now = nowMs();
  let inserted = 0;
  const pending: NewsEvent[] = [];

  const tx = db.transaction(() => {
    for (const item of items) {
      const title = item.title;
      const rawUrl = item.link ?? (item.guid?.startsWith('http') ? item.guid : null);
      if (!title || !rawUrl) continue;
      const url = canonicalizeUrl(rawUrl);
      const summary = item.description ?? undefined;
      const assets = tagTickers(title, summary);
      const sentiment = scoreSentiment(title, summary);
      const ts = parseTs(item.pubDate);

      const info = insertStmt.run(ts, source, title, url, JSON.stringify(assets), sentiment);
      if (info.changes === 0) continue; // already stored under this canonical url
      inserted++;
      if (now - ts <= EVENT_MAX_AGE_MS) {
        pending.push({
          id: eventIdSeq++,
          ts,
          source,
          kind: 'news',
          title,
          url,
          assets,
          sentiment,
          severity: assets.length > 0 ? 30 : 10,
        });
      }
    }
  });
  tx();

  for (const evt of pending) eventBus.emit(evt);
  return inserted;
}

export async function rssTick(): Promise<void> {
  if (stopping) return;
  let total = 0;
  for (const feed of FEEDS) {
    if (stopping) return;
    try {
      const xml = await fetchFeed(feed.url);
      if (!xml) continue;
      const n = pollFeedXml(feed.source, xml);
      total += n;
    } catch (err) {
      logger.warn({ err, source: feed.source }, 'rss: feed cycle failed (continuing)');
    }
  }
  lastTickTs = nowMs();
  if (total > 0) logger.info({ inserted: total }, 'rss: new headlines');
}

export function startRssNews(): void {
  if (task) return;
  stopping = false;
  task = cron.schedule(TICK_CRON, () => {
    if (currentTick) return; // a slow cycle must not overlap the next one
    currentTick = rssTick().finally(() => {
      currentTick = null;
    });
  });
  currentTick = rssTick().finally(() => {
    currentTick = null;
  });
  logger.info({ feeds: FEEDS.length }, 'rss news collector started (5-min poll)');
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

export function getRssLastTick(): number | null {
  return lastTickTs;
}

// ── indicator inputs ───────────────────────────────────────────────────

/**
 * Mean lexicon sentiment of the last 24h of headlines tagged with `symbol`'s
 * base ticker. Null when nothing was tagged (or nothing scored) — the
 * indicator then votes neutral rather than inventing a 0.
 *
 * The LIKE on assets_json is a substring match on a JSON array of 3–5 char
 * tickers; quoting the needle ("BTC" incl. the quotes) keeps it exact.
 */
export function newsSentimentFor(symbol: string, ts: number = nowMs()): number | null {
  const needle = `%"${baseTicker(symbol)}"%`;
  const row = db
    .prepare(
      `SELECT AVG(sentiment) AS avg FROM news_items
        WHERE ts >= ? AND sentiment IS NOT NULL AND assets_json LIKE ?`,
    )
    .get(ts - DAY_MS, needle) as { avg: number | null };
  return row.avg !== null && Number.isFinite(row.avg) ? row.avg : null;
}

/**
 * Headline-rate ratio: items in the last hour vs the average hour over the
 * preceding 7 days. 1.0 = normal news flow, 3.0 = three times the usual
 * chatter. Null until at least 6h of baseline exists.
 */
export function newsBurstRatio(ts: number = nowMs()): number | null {
  const lastHour = db
    .prepare('SELECT COUNT(*) AS n FROM news_items WHERE ts >= ?')
    .get(ts - HOUR_MS) as { n: number };
  const baseRow = db
    .prepare('SELECT COUNT(*) AS n, MIN(ts) AS first FROM news_items WHERE ts >= ? AND ts < ?')
    .get(ts - 7 * DAY_MS, ts - HOUR_MS) as { n: number; first: number | null };
  if (baseRow.first === null) return null;
  const hours = (ts - HOUR_MS - baseRow.first) / HOUR_MS;
  if (hours < 6 || baseRow.n === 0) return null;
  const perHour = baseRow.n / hours;
  if (perHour <= 0) return null;
  return lastHour.n / perHour;
}
