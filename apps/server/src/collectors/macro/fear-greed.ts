/**
 * Crypto Fear & Greed Index collector — alternative.me (no key).
 *
 * Polls every 30 minutes. On first run backfills the last 30 entries so the
 * mini-history chart renders immediately. Each insert is upserted against
 * `(name='fng_crypto', ts)` — the unique constraint in `indicator_readings`
 * makes repeat fetches idempotent. Emits an `IndicatorEvent` with previous
 * value + delta when the latest reading actually changes.
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { IndicatorEvent } from '@cockpit/shared';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { logger } from '../../util/logger.js';
import { nowSec } from '../../util/time.js';

const TICK_CRON = '*/30 * * * *';
const INDICATOR_NAME = 'fng_crypto';
const API_URL = 'https://api.alternative.me/fng/';

interface FngEntry {
  value: string;
  value_classification: string;
  timestamp: string; // unix seconds as string
  time_until_update?: string;
}

interface FngResponse {
  name?: string;
  data?: FngEntry[];
  metadata?: { error?: string | null };
}

let task: ScheduledTask | null = null;
let running = false;
let stopping = false;
let backfilled = false;
let eventIdSeq = 1;
let lastEmittedTs = 0;

const upsertStmt = db.prepare(
  `INSERT INTO indicator_readings (name, ts, value, meta_json)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(name, ts) DO UPDATE SET
     value = excluded.value,
     meta_json = excluded.meta_json`,
);

const priorValueStmt = db.prepare(
  `SELECT value FROM indicator_readings
    WHERE name = ? AND ts < ?
    ORDER BY ts DESC
    LIMIT 1`,
);

const latestStmt = db.prepare(
  `SELECT ts, value FROM indicator_readings
    WHERE name = ?
    ORDER BY ts DESC
    LIMIT 1`,
);

function nextEventId(): number {
  return eventIdSeq++;
}

async function fetchFng(limit: number): Promise<FngEntry[]> {
  const url = `${API_URL}?limit=${limit}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      logger.warn({ status: resp.status }, 'fear-greed: http error');
      return [];
    }
    const json = (await resp.json()) as FngResponse;
    if (json.metadata?.error) {
      logger.warn({ err: json.metadata.error }, 'fear-greed: api error');
      return [];
    }
    return Array.isArray(json.data) ? json.data : [];
  } catch (err) {
    logger.error({ err }, 'fear-greed: fetch failed');
    return [];
  }
}

function persistEntry(entry: FngEntry): { ts: number; value: number } | null {
  const value = Number(entry.value);
  const ts = Number(entry.timestamp);
  if (!Number.isFinite(value) || !Number.isFinite(ts)) return null;
  const meta = JSON.stringify({ classification: entry.value_classification });
  upsertStmt.run(INDICATOR_NAME, ts, value, meta);
  return { ts, value };
}

async function tick(): Promise<void> {
  if (stopping) return;

  const limit = backfilled ? 1 : 30;
  const entries = await fetchFng(limit);
  if (entries.length === 0) return;

  // API returns newest-first; persist oldest-first so prior-value lookup works.
  const ordered = [...entries].sort(
    (a, b) => Number(a.timestamp) - Number(b.timestamp),
  );

  let emittedForRun = false;
  for (const entry of ordered) {
    const stored = persistEntry(entry);
    if (!stored) continue;

    // Only emit an event for the newest entry (no event spam during backfill).
    const isNewest = stored.ts === Number(ordered[ordered.length - 1]?.timestamp);
    if (!isNewest || emittedForRun) continue;
    if (stored.ts <= lastEmittedTs) continue;

    const priorRow = priorValueStmt.get(INDICATOR_NAME, stored.ts) as
      | { value: number }
      | undefined;
    const previous = priorRow?.value;
    const delta = previous !== undefined ? stored.value - previous : undefined;

    const evt: IndicatorEvent = {
      id: nextEventId(),
      ts: stored.ts,
      source: 'alternative.me',
      kind: 'indicator',
      name: INDICATOR_NAME,
      value: stored.value,
      ...(previous !== undefined ? { previous } : {}),
      ...(delta !== undefined ? { delta } : {}),
    };
    eventBus.emit(evt);
    lastEmittedTs = stored.ts;
    emittedForRun = true;
  }

  backfilled = true;
}

export function startFearGreed(): void {
  if (running) return;
  running = true;
  stopping = false;

  const latest = latestStmt.get(INDICATOR_NAME) as
    | { ts: number; value: number }
    | undefined;
  if (latest) {
    lastEmittedTs = latest.ts;
    // If we already have at least 5 historic rows, skip backfill — treat
    // existing data as sufficient.
    const { count } = db
      .prepare('SELECT COUNT(*) AS count FROM indicator_readings WHERE name = ?')
      .get(INDICATOR_NAME) as { count: number };
    if (count >= 5) backfilled = true;
  }

  logger.info('fear-greed collector enabled');
  task = cron.schedule(TICK_CRON, () => {
    void tick().catch((err: unknown) => {
      logger.error({ err }, 'fear-greed tick failed');
    });
  });
  // Kick immediately so first-run backfill happens at boot, not 30 min later.
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

export function isFearGreedRunning(): boolean {
  return running;
}
