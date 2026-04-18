/**
 * FRED macro-series collector — St Louis Fed (API key required).
 *
 * Polls the five tracked series once per day at 05:00 UTC (after most US
 * data releases). Missing key → collector no-ops.
 *
 * Observations are stored against the series_id as the indicator name
 * (`CPIAUCSL`, `DGS10`, etc.). FRED's ISO date becomes UTC midnight unix
 * seconds. FRED occasionally reports `"."` for unreleased days — those are
 * skipped rather than stored as NaN.
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { IndicatorEvent } from '@cockpit/shared';
import { getApiKey } from '../../config.js';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { logger } from '../../util/logger.js';
import { nowSec } from '../../util/time.js';

const TICK_CRON = '0 5 * * *';
const BASE_URL = 'https://api.stlouisfed.org/fred/series/observations';

const SERIES: readonly string[] = [
  'CPIAUCSL',
  'DGS10',
  'DFF',
  'UNRATE',
  'DCOILWTICO',
];

interface ObservationsResponse {
  observations?: Array<{
    realtime_start?: string;
    realtime_end?: string;
    date: string; // YYYY-MM-DD
    value: string;
  }>;
  error_message?: string;
}

let apiKey: string | null = null;
let task: ScheduledTask | null = null;
let running = false;
let stopping = false;
let eventIdSeq = 1;
const lastEmittedTs = new Map<string, number>();

const upsertStmt = db.prepare(
  `INSERT INTO indicator_readings (name, ts, value, meta_json)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(name, ts) DO UPDATE SET value = excluded.value`,
);

const priorValueStmt = db.prepare(
  `SELECT value FROM indicator_readings
    WHERE name = ? AND ts < ?
    ORDER BY ts DESC
    LIMIT 1`,
);

function nextEventId(): number {
  return eventIdSeq++;
}

function dateToUnixUtcMidnight(iso: string): number | null {
  // FRED's date field is always YYYY-MM-DD UTC midnight.
  const parts = iso.split('-');
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return Math.floor(Date.UTC(y, m - 1, d) / 1000);
}

async function fetchLatest(seriesId: string): Promise<{ ts: number; value: number } | null> {
  if (!apiKey) return null;
  const url = new URL(BASE_URL);
  url.searchParams.set('series_id', seriesId);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('sort_order', 'desc');
  url.searchParams.set('limit', '1');
  url.searchParams.set('file_type', 'json');
  try {
    const resp = await fetch(url.toString());
    if (!resp.ok) {
      logger.warn({ status: resp.status, seriesId }, 'fred: http error');
      return null;
    }
    const json = (await resp.json()) as ObservationsResponse;
    if (json.error_message) {
      logger.warn({ err: json.error_message, seriesId }, 'fred: api error');
      return null;
    }
    const obs = json.observations?.[0];
    if (!obs) return null;
    if (obs.value === '.' || obs.value === '' || obs.value === null) return null;
    const value = Number(obs.value);
    if (!Number.isFinite(value)) return null;
    const ts = dateToUnixUtcMidnight(obs.date);
    if (ts === null) return null;
    return { ts, value };
  } catch (err) {
    logger.error({ err, seriesId }, 'fred: fetch failed');
    return null;
  }
}

async function pollSeries(seriesId: string): Promise<void> {
  const latest = await fetchLatest(seriesId);
  if (!latest) return;
  upsertStmt.run(seriesId, latest.ts, latest.value, null);

  if (lastEmittedTs.get(seriesId) === latest.ts) return;
  lastEmittedTs.set(seriesId, latest.ts);

  const priorRow = priorValueStmt.get(seriesId, latest.ts) as
    | { value: number }
    | undefined;
  const previous = priorRow?.value;
  const delta = previous !== undefined ? latest.value - previous : undefined;

  const evt: IndicatorEvent = {
    id: nextEventId(),
    ts: latest.ts,
    source: 'fred',
    kind: 'indicator',
    name: seriesId,
    value: latest.value,
    ...(previous !== undefined ? { previous } : {}),
    ...(delta !== undefined ? { delta } : {}),
  };
  eventBus.emit(evt);
}

async function tick(): Promise<void> {
  if (stopping || !apiKey) return;
  for (const seriesId of SERIES) {
    if (stopping) return;
    try {
      await pollSeries(seriesId);
    } catch (err) {
      logger.error({ err, seriesId }, 'fred: poll failed');
    }
  }
}

export function startFred(): void {
  if (running) return;
  const creds = getApiKey('fred');
  if (!creds || !creds.key) {
    logger.warn('fred: no API key configured — macro series disabled');
    apiKey = null;
    return;
  }
  apiKey = creds.key;
  running = true;
  stopping = false;
  logger.info('fred collector enabled');
  task = cron.schedule(TICK_CRON, () => {
    void tick().catch((err: unknown) => {
      logger.error({ err }, 'fred tick failed');
    });
  });
  // Kick once at boot so first-run populates immediately instead of waiting
  // for the next 05:00 UTC window.
  void tick().catch((err: unknown) => {
    logger.error({ err }, 'fred initial tick failed');
  });
  // Unused but referenced by parent module for clarity.
  void nowSec;
}

export function stopFred(): void {
  stopping = true;
  running = false;
  if (task) {
    try {
      task.stop();
    } catch (err) {
      logger.error({ err }, 'fred: stop failed');
    }
    task = null;
  }
  apiKey = null;
}

export function isFredRunning(): boolean {
  return running;
}
