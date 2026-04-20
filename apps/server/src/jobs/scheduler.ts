/**
 * Cron-driven scheduler for Phase-3 non-crypto feeds.
 *
 * Each tick is a no-op when its collector isn't enabled (missing API key or
 * `stop*` called). Sub-ticks are ordered so that the primary feed
 * (Twelve Data) runs most frequently; Yahoo is a fallback polled every 5 min;
 * Finnhub news is polled every 15 min.
 *
 * The hourly aggregation rerun overlaps with the crypto collector's own
 * cron — aggregateAll is asset-agnostic and INSERT OR REPLACE is idempotent,
 * so the extra run just ensures non-crypto 1m rows roll up promptly.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../util/logger.js';
import { nowSec } from '../util/time.js';
import { twelveDataTick } from '../collectors/stocks/twelvedata.js';
import { finnhubNewsTick } from '../collectors/stocks/finnhub.js';
import { yahooTick } from '../collectors/stocks/yahoo.js';
import { aggregateAll } from '../collectors/crypto/binance-rest.js';
import { startFearGreed, stopFearGreed } from '../collectors/macro/fear-greed.js';
import { startDxyVix, stopDxyVix } from '../collectors/macro/dxy-vix.js';
import { startFundingOi, stopFundingOi } from '../collectors/macro/funding-oi.js';
import {
  startBtcDominance,
  stopBtcDominance,
} from '../collectors/macro/btc-dominance.js';
import { startFred, stopFred } from '../collectors/macro/fred.js';
import { startRssNews, stopRssNews } from '../collectors/news/rss.js';
import {
  startCryptoPanic,
  stopCryptoPanic,
} from '../collectors/news/cryptopanic.js';
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

  // Twelve Data: every minute. Collector iterates each enabled asset,
  // honouring market hours + its own rate-limit reservoir internally.
  tasks.push(
    cron.schedule('*/1 * * * *', () => {
      safeRun('twelvedata', twelveDataTick);
    }),
  );

  // Finnhub company-news: every 15 minutes, only while US equities are open.
  tasks.push(
    cron.schedule('*/15 * * * *', () => {
      safeRun('finnhub-news', finnhubNewsTick);
    }),
  );

  // Yahoo fallback: every 5 minutes, only fills stale assets.
  tasks.push(
    cron.schedule('*/5 * * * *', () => {
      safeRun('yahoo', yahooTick);
    }),
  );

  // Non-crypto aggregation: hourly, rolling 2-day window. Idempotent across
  // the crypto aggregation cron that runs on the same cadence.
  tasks.push(
    cron.schedule('5 * * * *', () => {
      const lookbackSec = 2 * 24 * 3600;
      safeRun('aggregation-noncrypto', () =>
        aggregateAll(nowSec() - lookbackSec),
      );
    }),
  );

  // Phase-6 macro/indicator collectors. Each is self-driving (own cron inside),
  // but we start/stop them through the scheduler so lifecycle stays unified.
  try {
    startFearGreed();
    startDxyVix();
    startFundingOi();
    startBtcDominance();
    startFred();
    startIndicators();
  } catch (err) {
    logger.error({ err }, 'scheduler: macro collectors failed to start');
  }

  // Phase-5 news collectors. Self-driving (own cron inside); lifecycle
  // hitched to the scheduler so start/stop is unified with other feeds.
  try {
    startRssNews();
    startCryptoPanic();
  } catch (err) {
    logger.error({ err }, 'scheduler: news collectors failed to start');
  }

  logger.info(
    { taskCount: tasks.length },
    'phase-3 scheduler started',
  );
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
    stopDxyVix();
    stopFundingOi();
    stopBtcDominance();
    stopFred();
    stopIndicators();
  } catch (err) {
    logger.error({ err }, 'scheduler: macro stop failed');
  }
  try {
    stopRssNews();
    stopCryptoPanic();
  } catch (err) {
    logger.error({ err }, 'scheduler: news stop failed');
  }
}

export function isSchedulerRunning(): boolean {
  return running;
}
