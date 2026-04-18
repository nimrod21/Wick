/**
 * CryptoPanic news collector.
 *
 * Fetches the public `posts` feed every 5 minutes, normalises each post
 * into a `NewsEvent`, deduplicates by `cryptopanic:${post.id}`, and emits
 * on the shared bus.
 *
 * Sentiment is computed from CryptoPanic's community vote counts when
 * present (`(pos - neg) / (pos + neg)`) else falls back to the shared
 * lexicon scorer. Ticker tags come straight from CryptoPanic's
 * `currencies` array (we trust them) rather than re-running the keyword
 * matcher.
 *
 * No-op when no API key is configured.
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { NewsEvent } from '@cockpit/shared';
import { getApiKey } from '../../config.js';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { getLimiter } from '../../util/rate-limiter.js';
import { logger } from '../../util/logger.js';
import { nowSec } from '../../util/time.js';
import { scheduleSnapshot, latestClose } from '../../core/snapshot-job.js';
import { scoreSentiment } from './sentiment.js';

const TICK_CRON = '*/5 * * * *';
const BASE_URL = 'https://cryptopanic.com/api/v1/posts/';
const SIGNIFICANT_SENT = 0.3;

interface CryptoPanicCurrency {
  code?: string;
  title?: string;
  slug?: string;
  url?: string;
}

interface CryptoPanicVotes {
  positive?: number;
  negative?: number;
  important?: number;
  liked?: number;
  disliked?: number;
  lol?: number;
  toxic?: number;
  saved?: number;
}

interface CryptoPanicPost {
  id: number;
  kind?: string;
  domain?: string;
  title?: string;
  published_at?: string;
  url?: string;
  source?: { title?: string; domain?: string };
  currencies?: CryptoPanicCurrency[];
  votes?: CryptoPanicVotes;
}

interface CryptoPanicResponse {
  count?: number;
  next?: string | null;
  previous?: string | null;
  results?: CryptoPanicPost[];
}

let apiKey: string | null = null;
let task: ScheduledTask | null = null;
let stopping = false;
let eventIdSeq = 1;
let currentTick: Promise<void> | null = null;

const limiter = getLimiter('cryptopanic', { minTime: 2000, maxConcurrent: 1 });

const insertEventStmt = db.prepare(
  `INSERT OR IGNORE INTO events
     (kind, source, ts, asset_id, severity, payload_json, dedup_key)
   VALUES ('news', ?, ?, ?, ?, ?, ?)`,
);

const assetBySymbolStmt = db.prepare(
  `SELECT id FROM assets WHERE symbol = ? LIMIT 1`,
);

function nextEventId(): number {
  return eventIdSeq++;
}

function parseDateToSec(value: string | undefined, fallbackSec: number): number {
  if (!value) return fallbackSec;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return fallbackSec;
  return Math.floor(t / 1000);
}

function resolveAssetIdForTicker(ticker: string): number | null {
  const cryptoRow = assetBySymbolStmt.get(`${ticker}USDT`) as
    | { id: number }
    | undefined;
  if (cryptoRow) return cryptoRow.id;
  const stockRow = assetBySymbolStmt.get(ticker) as { id: number } | undefined;
  return stockRow?.id ?? null;
}

async function fetchPosts(): Promise<CryptoPanicPost[] | null> {
  if (!apiKey) return null;
  const url =
    `${BASE_URL}?auth_token=${encodeURIComponent(apiKey)}&public=true&kind=news`;
  return limiter.schedule(async () => {
    try {
      const resp = await fetch(url);
      if (resp.status === 429) {
        logger.warn('cryptopanic 429: rate limited');
        return null;
      }
      if (!resp.ok) {
        logger.warn({ status: resp.status }, 'cryptopanic http error');
        return null;
      }
      const data = (await resp.json()) as CryptoPanicResponse;
      return Array.isArray(data.results) ? data.results : [];
    } catch (err) {
      logger.warn({ err }, 'cryptopanic fetch failed');
      return null;
    }
  });
}

function extractTickers(post: CryptoPanicPost): string[] {
  const list = Array.isArray(post.currencies) ? post.currencies : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    const code = (c.code ?? '').trim().toUpperCase();
    if (!code) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

function deriveSentiment(
  post: CryptoPanicPost,
  title: string,
): number | null {
  const votes = post.votes;
  const pos = Number(votes?.positive ?? 0);
  const neg = Number(votes?.negative ?? 0);
  if (Number.isFinite(pos) && Number.isFinite(neg) && pos + neg > 0) {
    const score = (pos - neg) / (pos + neg);
    if (score > 1) return 1;
    if (score < -1) return -1;
    return score;
  }
  return scoreSentiment(title);
}

interface ProcessedPost {
  eventId: number;
  tickers: string[];
  sentiment: number | null;
}

function processPost(post: CryptoPanicPost): ProcessedPost | null {
  const title = (post.title ?? '').trim();
  const rawUrl = (post.url ?? '').trim();
  if (!title || !rawUrl) return null;
  if (typeof post.id !== 'number') return null;

  const dedupKey = `cryptopanic:${post.id}`;
  const tickers = extractTickers(post);
  const sentiment = deriveSentiment(post, title);
  const severity = tickers.length > 0 ? 30 : 10;
  const ts = parseDateToSec(post.published_at, nowSec());
  const sourceLabel =
    post.source?.title ?? post.source?.domain ?? post.domain ?? 'CryptoPanic';

  const payload = {
    title,
    url: rawUrl,
    summary: null as string | null,
    tickers,
    sentiment,
    category: 'crypto',
    source: sourceLabel,
    cryptopanicId: post.id,
  };

  let info: { changes: number; lastInsertRowid: number | bigint };
  try {
    info = insertEventStmt.run(
      `cryptopanic:${sourceLabel}`,
      ts,
      null,
      severity,
      JSON.stringify(payload),
      dedupKey,
    );
  } catch (err) {
    logger.error({ err, id: post.id }, 'cryptopanic insert failed');
    return null;
  }
  if (info.changes === 0) return null;

  const eventId = Number(info.lastInsertRowid);
  const evt: NewsEvent = {
    id: nextEventId(),
    ts,
    source: `cryptopanic:${sourceLabel}`,
    severity,
    kind: 'news',
    title,
    url: rawUrl,
    tickers,
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

export async function cryptoPanicTick(): Promise<void> {
  if (stopping || !apiKey) return;
  const posts = await fetchPosts();
  if (!posts) return;
  let inserted = 0;
  for (const p of posts) {
    if (stopping) return;
    const res = processPost(p);
    if (!res) continue;
    inserted += 1;
    maybeScheduleSnapshots(res.eventId, res.tickers, res.sentiment);
  }
  if (inserted > 0) {
    logger.info({ inserted, fetched: posts.length }, 'cryptopanic tick: new items');
  }
}

export function startCryptoPanic(): void {
  stopping = false;
  const creds = getApiKey('cryptopanic');
  if (!creds || !creds.key) {
    logger.warn('cryptopanic: no API key configured — collector disabled');
    apiKey = null;
    return;
  }
  apiKey = creds.key;
  if (task) return;
  task = cron.schedule(TICK_CRON, () => {
    if (currentTick) return;
    currentTick = cryptoPanicTick().finally(() => {
      currentTick = null;
    });
  });
  currentTick = cryptoPanicTick().finally(() => {
    currentTick = null;
  });
  logger.info('cryptopanic news collector enabled');
}

export function stopCryptoPanic(): void {
  stopping = true;
  if (task) {
    try {
      task.stop();
    } catch (err) {
      logger.error({ err }, 'cryptopanic: stop failed');
    }
    task = null;
  }
  apiKey = null;
}

export function isCryptoPanicEnabled(): boolean {
  return apiKey !== null;
}
