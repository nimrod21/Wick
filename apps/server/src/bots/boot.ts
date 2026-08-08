/**
 * Boot resume (IMPL-3 §4.5). Called once per boot AFTER `marketWarm`:
 * reload bots, log one line per resumed bot, re-run the busted check
 * (drawdown may have crossed the kill line while the server was down), and
 * start the cadence scheduler + trigger engine so wakes flow again.
 *
 * The protector re-arms itself on marketWarm (Phase 2) and the quota ledger
 * is DB-backed (Phase 3) — nothing to restore here for either.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../util/logger.js';
import { equity, getPositions } from '../paper/engine.js';
import { startTriggerEngine } from '../market/trigger-engine.js';
import { checkBusted, checkBustedAll, listBots, listRunningBots, parseConfig } from './bot-store.js';
import { startBotScheduler } from './scheduler.js';

let bustTask: ScheduledTask | null = null;

/** Hourly busted sweep at :01, just after the equity snapshot cron (PLAN §8). */
function startBustedCron(): void {
  if (bustTask) return;
  bustTask = cron.schedule('1 * * * *', () => {
    try {
      const n = checkBustedAll();
      if (n > 0) logger.warn({ bots: n }, 'hourly busted check halted bots');
    } catch (err) {
      logger.error({ err }, 'busted check cron failed');
    }
  });
}

export function stopBustedCron(): void {
  if (bustTask) {
    bustTask.stop();
    bustTask = null;
  }
}

export function resumeBots(): number {
  const all = listBots();
  logger.info({ bots: all.length, running: all.filter((b) => b.status === 'running').length }, 'bots reloaded');

  for (const bot of listRunningBots()) {
    checkBusted(bot.id); // equity may have collapsed while we were down
    const positions = getPositions(bot.id);
    const cfg = parseConfig(bot);
    logger.info(
      {
        bot: bot.id,
        name: bot.name,
        equity: equity(bot.id),
        cash: bot.cash,
        run: cfg.run,
        cadence: cfg.cadence_tf,
        positions: positions.map((p) => `${p.symbol}:${p.qty}`),
      },
      `resumed, equity $${(equity(bot.id) ?? 0).toFixed(2)}, ${positions.length === 0 ? 'no position' : `position ${positions.map((p) => p.symbol).join(',')}`}`,
    );
  }

  startBotScheduler();
  startTriggerEngine();
  startBustedCron();
  return listRunningBots().length;
}
