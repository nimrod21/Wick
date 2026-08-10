/**
 * Cron-driven scheduler (IMPL-1 §1.5). Owns:
 *   - funding poll lifecycle   (collector self-drives a 15-min cron)
 *   - fear & greed lifecycle   (collector self-drives a daily cron)
 *   - news / whale / macro lifecycle (IMPL-3a — each self-drives its own
 *     cron: 5-min RSS, 5-min BTC whale sweep, 10-min Yahoo macro)
 *   - 5-min higher-timeframe REST refresh (15m/4h/1d — see STATUS.md)
 *   - hourly candle-gap self-heal (detect missing candles, REST backfill)
 *
 * Every intel collector tolerates network failure silently and keeps
 * serving its last-known-good value, so a dead upstream degrades the
 * affected indicators to `neutral` instead of taking the server down.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../util/logger.js';
import {
  refreshHigherTimeframes,
  selfHealGaps,
} from '../collectors/crypto/binance-rest.js';
import { startFearGreed, stopFearGreed } from '../collectors/macro/fear-greed.js';
import { startFundingOi, stopFundingOi } from '../collectors/macro/funding-oi.js';
import { startMacro, stopMacro } from '../collectors/macro/yahoo-macro.js';
import { startRssNews, stopRssNews } from '../collectors/news/rss.js';
import { startBtcWhales, stopBtcWhales } from '../collectors/onchain/btc-whales.js';
import { refreshOpenRouterModels } from '../llm/model-discovery.js';

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

  // Higher-timeframe refresh: every 5 minutes, last 2 klines per (symbol × 15m/4h/1d).
  tasks.push(
    cron.schedule('*/5 * * * *', () => {
      safeRun('htf-refresh', refreshHigherTimeframes);
    }),
  );

  // Candle-gap self-heal: hourly at :07 (off the hour-close rush).
  tasks.push(
    cron.schedule('7 * * * *', () => {
      safeRun('self-heal', selfHealGaps);
    }),
  );

  // OpenRouter free-model catalogue: daily at 04:17, plus one boot call that
  // no-ops while the cached list is under a day old (model-discovery.ts).
  tasks.push(
    cron.schedule('17 4 * * *', () => {
      safeRun('openrouter-models', async () => {
        await refreshOpenRouterModels();
      });
    }),
  );
  safeRun('openrouter-models', async () => {
    await refreshOpenRouterModels();
  });

  // Macro collectors (self-driving, own cron inside). Lifecycle hitched to
  // the scheduler so start/stop stays unified.
  try {
    startFundingOi();
    startFearGreed();
    startMacro();
    startRssNews();
    startBtcWhales();
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
    stopMacro();
    stopRssNews();
    stopBtcWhales();
  } catch (err) {
    logger.error({ err }, 'scheduler: macro stop failed');
  }
}

export function isSchedulerRunning(): boolean {
  return running;
}
