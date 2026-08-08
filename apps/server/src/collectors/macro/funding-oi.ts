/**
 * Binance Futures funding-rate collector (no key).
 *
 * Every 15 minutes (plus once at start), fetch `premiumIndex` from
 * fapi.binance.com for every active watchlist symbol. The latest rate per
 * symbol is cached in memory and queryable via `getLatestFunding()` — the
 * indicator engine reads it on every 1h close. A `funding` bus event is
 * published when the rate changes.
 *
 * Funding is stored as a fraction (0.0001 = 0.01%). Staleness is tolerated
 * silently: consumers get the last cached value, however old (PLAN §16).
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { FundingEvent } from '@wick/shared';
import { eventBus } from '../../core/event-bus.js';
import { getLimiter } from '../../util/rate-limiter.js';
import { logger } from '../../util/logger.js';
import { nowMs } from '../../util/time.js';
import { getActiveSymbols } from '../crypto/binance-rest.js';

const TICK_CRON = '*/15 * * * *';
const BASE_FAPI = 'https://fapi.binance.com';

interface PremiumIndexResponse {
  symbol: string;
  markPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
}

export interface FundingSnapshot {
  rate: number;
  nextFundingTime: number;
  ts: number;
}

let task: ScheduledTask | null = null;
let running = false;
let stopping = false;
let eventIdSeq = 1;

const latestBySymbol = new Map<string, FundingSnapshot>();

const limiter = getLimiter('binance-futures', { minTime: 100, maxConcurrent: 2 });

function nextEventId(): number {
  return eventIdSeq++;
}

async function pollFunding(symbol: string): Promise<void> {
  const url = `${BASE_FAPI}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`;
  const resp = await limiter.schedule(async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) {
        logger.warn({ status: r.status, symbol }, 'funding: http error');
        return null;
      }
      return (await r.json()) as PremiumIndexResponse;
    } catch (err) {
      logger.error({ err, symbol }, 'funding: fetch failed');
      return null;
    }
  });
  if (!resp) return;

  const rate = Number(resp.lastFundingRate);
  if (!Number.isFinite(rate)) return;
  const ts = resp.time || nowMs();
  const prev = latestBySymbol.get(symbol);
  latestBySymbol.set(symbol, { rate, nextFundingTime: resp.nextFundingTime, ts });

  if (prev?.rate === rate) return;
  const evt: FundingEvent = {
    id: nextEventId(),
    ts,
    source: 'binance-futures',
    kind: 'funding',
    symbol,
    rate,
    nextFundingTime: resp.nextFundingTime,
  };
  eventBus.emit(evt);
}

async function tick(): Promise<void> {
  if (stopping) return;
  for (const symbol of getActiveSymbols()) {
    if (stopping) return;
    try {
      await pollFunding(symbol);
    } catch (err) {
      logger.error({ err, symbol }, 'funding: poll failed');
    }
  }
}

export function startFundingOi(): void {
  if (running) return;
  running = true;
  stopping = false;
  logger.info('funding collector enabled (15m poll)');
  task = cron.schedule(TICK_CRON, () => {
    void tick().catch((err: unknown) => {
      logger.error({ err }, 'funding tick failed');
    });
  });
  // Kick immediately so the indicator engine has a value right after boot.
  void tick().catch((err: unknown) => {
    logger.error({ err }, 'funding initial tick failed');
  });
}

export function stopFundingOi(): void {
  stopping = true;
  running = false;
  if (task) {
    try {
      task.stop();
    } catch (err) {
      logger.error({ err }, 'funding: stop failed');
    }
    task = null;
  }
}

/** Latest cached funding snapshot for a symbol; null before the first
 *  successful poll. May be stale — callers tolerate that silently. */
export function getLatestFunding(symbol: string): FundingSnapshot | null {
  return latestBySymbol.get(symbol) ?? null;
}

export function isFundingOiRunning(): boolean {
  return running;
}
