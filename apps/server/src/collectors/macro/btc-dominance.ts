/**
 * BTC dominance collector — CoinGecko /global (no key).
 *
 * Every 30 minutes. Stores `market_cap_percentage.btc` under indicator
 * name `btc_dominance`. Shares the `coingecko` limiter with the ERC-20
 * price lookup path in the Etherscan whale collector so we never exceed
 * the free-tier 30/min ceiling across processes.
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { IndicatorEvent } from '@cockpit/shared';
import { db } from '../../db/client.js';
import { eventBus } from '../../core/event-bus.js';
import { getLimiter } from '../../util/rate-limiter.js';
import { logger } from '../../util/logger.js';
import { nowSec } from '../../util/time.js';

const TICK_CRON = '*/30 * * * *';
const INDICATOR_NAME = 'btc_dominance';
const API_URL = 'https://api.coingecko.com/api/v3/global';

interface GlobalResponse {
  data?: {
    market_cap_percentage?: Record<string, number>;
    total_market_cap?: Record<string, number>;
    updated_at?: number;
  };
}

let task: ScheduledTask | null = null;
let running = false;
let stopping = false;
let eventIdSeq = 1;
let lastEmitted: number | null = null;

const limiter = getLimiter('coingecko', { minTime: 1200, maxConcurrent: 1 });

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

function nextEventId(): number {
  return eventIdSeq++;
}

async function fetchGlobal(): Promise<GlobalResponse | null> {
  return limiter.schedule(async () => {
    try {
      const resp = await fetch(API_URL);
      if (!resp.ok) {
        logger.warn({ status: resp.status }, 'btc-dominance: http error');
        return null;
      }
      return (await resp.json()) as GlobalResponse;
    } catch (err) {
      logger.error({ err }, 'btc-dominance: fetch failed');
      return null;
    }
  });
}

async function tick(): Promise<void> {
  if (stopping) return;
  const resp = await fetchGlobal();
  if (!resp?.data?.market_cap_percentage) return;
  const value = resp.data.market_cap_percentage['btc'];
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  const ts = resp.data.updated_at ?? nowSec();
  const meta = JSON.stringify({
    eth: resp.data.market_cap_percentage['eth'],
  });
  upsertStmt.run(INDICATOR_NAME, ts, value, meta);

  if (lastEmitted === value) return;
  lastEmitted = value;

  const priorRow = priorValueStmt.get(INDICATOR_NAME, ts) as
    | { value: number }
    | undefined;
  const previous = priorRow?.value;
  const delta = previous !== undefined ? value - previous : undefined;

  const evt: IndicatorEvent = {
    id: nextEventId(),
    ts,
    source: 'coingecko',
    kind: 'indicator',
    name: INDICATOR_NAME,
    value,
    ...(previous !== undefined ? { previous } : {}),
    ...(delta !== undefined ? { delta } : {}),
  };
  eventBus.emit(evt);
}

export function startBtcDominance(): void {
  if (running) return;
  running = true;
  stopping = false;
  logger.info('btc-dominance collector enabled');
  task = cron.schedule(TICK_CRON, () => {
    void tick().catch((err: unknown) => {
      logger.error({ err }, 'btc-dominance tick failed');
    });
  });
  void tick().catch((err: unknown) => {
    logger.error({ err }, 'btc-dominance initial tick failed');
  });
}

export function stopBtcDominance(): void {
  stopping = true;
  running = false;
  if (task) {
    try {
      task.stop();
    } catch (err) {
      logger.error({ err }, 'btc-dominance: stop failed');
    }
    task = null;
  }
}

export function isBtcDominanceRunning(): boolean {
  return running;
}
