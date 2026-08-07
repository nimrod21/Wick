/**
 * Cron-driven scheduler.
 *
 * Phase 0: present but not started from index.ts (Phase 1 re-enables it).
 * Owns the lifecycle of the self-driving macro collectors (fear & greed,
 * funding/OI) and the hourly candle aggregation rerun.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../util/logger.js';
import { nowSec } from '../util/time.js';
import { aggregateAll } from '../collectors/crypto/binance-rest.js';
import { startFearGreed, stopFearGreed } from '../collectors/macro/fear-greed.js';
import { startFundingOi, stopFundingOi } from '../collectors/macro/funding-oi.js';
import { startIndicators, stopIndicators } from '../core/indicators.js';

const tasks: ScheduledTask[] = [];
let running = false;

function safeRun(name: string, fn: () => Promise<void>): void {
  fn().catch((err: unknown) => {
    logger.error({ err }, `${name} tick failed`);
  });
}

export function startScheduler(): void {
  if (running) return;
  running = true;

  // Aggregation: hourly, rolling 2-day window. Idempotent across the
  // crypto collector's own aggregation cron.
  tasks.push(
    cron.schedule('5 * * * *', () => {
      const lookbackSec = 2 * 24 * 3600;
      safeRun('aggregation', () => aggregateAll(nowSec() - lookbackSec));
    }),
  );

  // Macro collectors (self-driving, own cron inside). Lifecycle hitched to
  // the scheduler so start/stop stays unified.
  try {
    startFearGreed();
    startFundingOi();
    startIndicators();
  } catch (err) {
    logger.error({ err }, 'scheduler: macro collectors failed to start');
  }

  logger.info({ taskCount: tasks.length }, 'scheduler started');
}

export function stopScheduler(): void {
  if (!running) return;
  running = false;
  for (const t of tasks) {
    try {
      t.stop();
    } catch (err) {
      logger.error({ err }, 'scheduler: stop failed');
    }
  }
  tasks.length = 0;
  try {
    stopFearGreed();
    stopFundingOi();
    stopIndicators();
  } catch (err) {
    logger.error({ err }, 'scheduler: macro stop failed');
  }
}

export function isSchedulerRunning(): boolean {
  return running;
}
