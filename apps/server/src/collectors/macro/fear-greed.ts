/**
 * Crypto Fear & Greed Index collector — alternative.me (no key).
 *
 * Polls once a day (the index updates daily) plus once at start. The latest
 * value is cached in memory and queryable via `getLatestFearGreed()` — the
 * indicator engine reads it on every 1h close. A `fear_greed` bus event is
 * published when the value changes.
 *
 * alternative.me has no SLA — failures are logged and the last cached value
 * keeps serving, however stale (PLAN §16 / IMPL-1 pitfalls).
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { FearGreedEvent } from '@wick/shared';
import { eventBus } from '../../core/event-bus.js';
import { logger } from '../../util/logger.js';

const TICK_CRON = '10 0 * * *'; // daily at 00:10 UTC-ish (server local); index updates daily
const API_URL = 'https://api.alternative.me/fng/';

interface FngEntry {
  value: string;
  value_classification: string;
  timestamp: string; // unix seconds as string
}

interface FngResponse {
  data?: FngEntry[];
  metadata?: { error?: string | null };
}

export interface FearGreedSnapshot {
  value: number;
  classification: string;
  ts: number; // ms
}

let task: ScheduledTask | null = null;
let running = false;
let stopping = false;
let eventIdSeq = 1;
let latest: FearGreedSnapshot | null = null;

function nextEventId(): number {
  return eventIdSeq++;
}

async function tick(): Promise<void> {
  if (stopping) return;
  let json: FngResponse;
  try {
    const resp = await fetch(`${API_URL}?limit=1`);
    if (!resp.ok) {
      logger.warn({ status: resp.status }, 'fear-greed: http error');
      return;
    }
    json = (await resp.json()) as FngResponse;
  } catch (err) {
    logger.error({ err }, 'fear-greed: fetch failed');
    return;
  }
  if (json.metadata?.error) {
    logger.warn({ err: json.metadata.error }, 'fear-greed: api error');
    return;
  }
  const entry = json.data?.[0];
  if (!entry) return;
  const value = Number(entry.value);
  const tsSec = Number(entry.timestamp);
  if (!Number.isFinite(value) || !Number.isFinite(tsSec)) return;

  const changed = latest?.value !== value;
  latest = { value, classification: entry.value_classification, ts: tsSec * 1000 };
  if (!changed) return;

  const evt: FearGreedEvent = {
    id: nextEventId(),
    ts: latest.ts,
    source: 'alternative.me',
    kind: 'fear_greed',
    value,
    classification: latest.classification,
  };
  eventBus.emit(evt);
}

export function startFearGreed(): void {
  if (running) return;
  running = true;
  stopping = false;
  logger.info('fear-greed collector enabled (daily poll)');
  task = cron.schedule(TICK_CRON, () => {
    void tick().catch((err: unknown) => {
      logger.error({ err }, 'fear-greed tick failed');
    });
  });
  // Kick immediately so the indicator engine has a value right after boot.
  void tick().catch((err: unknown) => {
    logger.error({ err }, 'fear-greed initial tick failed');
  });
}

export function stopFearGreed(): void {
  stopping = true;
  running = false;
  if (task) {
    try {
      task.stop();
    } catch (err) {
      logger.error({ err }, 'fear-greed: stop failed');
    }
    task = null;
  }
}

/** Latest cached F&G snapshot; null before the first successful poll.
 *  May be up to a day stale — callers tolerate that silently. */
export function getLatestFearGreed(): FearGreedSnapshot | null {
  return latest;
}

export function isFearGreedRunning(): boolean {
  return running;
}
