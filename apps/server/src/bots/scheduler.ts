/**
 * Bot cadence scheduler (IMPL-3 §4.3) — the P3 `scheduled` wake source.
 *
 * On every CLOSED candle of timeframe X, every running bot whose
 * `cadence_tf === X` gets one wake. The seven watchlist symbols each emit a
 * candle event for the same close, so wakes are de-duplicated per
 * (bot, tf, candle ts).
 *
 * Wakes are staggered 0–30s by a hash of the bot id — deterministic, no
 * Math.random anywhere — so N bots don't hit the shared free-tier pool in
 * the same instant. The wake itself goes through the trigger engine's gate
 * (`fireTrigger`) so `scheduled` gets the same trigger_log/budget treatment
 * as every other trigger type.
 */

import type { CandleEvent } from '@wick/shared';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../util/logger.js';
import { TF_MS, type WickTf } from '../collectors/crypto/binance-rest.js';
import { isMarketWarm } from '../market/market-state.js';
import { fireTrigger } from '../market/trigger-engine.js';
import type { BotRow } from '../paper/engine.js';
import { listRunningBots, parseConfig } from './bot-store.js';
import { hashString } from './snapshot.js';

/** Max stagger, ms (IMPL-3 §4.3: 0–30s derived from bot id). */
export const STAGGER_MAX_MS = 30_000;

export function staggerMs(botId: number): number {
  return hashString(`wake:${botId}`) % STAGGER_MAX_MS;
}

/**
 * When this bot is next due to wake: the next close of its cadence timeframe
 * plus its own stagger. Candle boundaries are epoch-aligned (epoch is a UTC
 * midnight), so the next close is pure arithmetic — no candle table lookup.
 *
 * `null` for anything that will not wake on a cadence: a stopped or busted
 * bot, or a cadence timeframe Wick does not store. The UI renders that as "—"
 * rather than inventing a countdown for a bot that is not running.
 */
export function nextWakeTs(bot: BotRow, now = Date.now()): number | null {
  if (bot.status !== 'running') return null;
  const step = TF_MS[parseConfig(bot).cadence_tf as WickTf] as number | undefined;
  if (step === undefined) return null;
  const stagger = staggerMs(bot.id);
  const thisClose = Math.floor(now / step) * step + stagger;
  return thisClose > now ? thisClose : thisClose + step;
}

/** `${botId}:${tf}` → candle ts already scheduled. */
const dispatched = new Map<string, number>();
const timers = new Set<NodeJS.Timeout>();
let unsubscribe: (() => void) | null = null;

function scheduleWake(botId: number, tf: string, candleTs: number, delayMs: number): void {
  const timer = setTimeout(() => {
    timers.delete(timer);
    try {
      fireTrigger({
        type: 'scheduled',
        priority: 3,
        symbol: null,
        detail: `scheduled:${tf} close ${new Date(candleTs).toISOString()}`,
        reason: `Woken by: scheduled ${tf} candle close (${new Date(candleTs).toISOString().slice(5, 16).replace('T', ' ')} UTC) — your regular cadence check.`,
        onlyBotIds: [botId],
        skipTypeCooldown: true,
      });
    } catch (err) {
      logger.error({ err, bot: botId }, 'scheduled wake failed');
    }
  }, delayMs);
  timer.unref();
  timers.add(timer);
}

function onCandle(e: CandleEvent): void {
  if (!e.closed || !isMarketWarm()) return;
  for (const bot of listRunningBots()) {
    const cfg = parseConfig(bot);
    if (cfg.cadence_tf !== e.tf) continue;
    const key = `${bot.id}:${e.tf}`;
    if (dispatched.get(key) === e.ts) continue; // one wake per close, not one per symbol
    dispatched.set(key, e.ts);
    scheduleWake(bot.id, e.tf, e.ts, staggerMs(bot.id));
  }
}

export function startBotScheduler(): void {
  if (unsubscribe) return;
  unsubscribe = eventBus.on('candle', onCandle);
  logger.info('bot scheduler started (candle-close wakes)');
}

export function stopBotScheduler(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  for (const t of timers) clearTimeout(t);
  timers.clear();
  dispatched.clear();
}

/** Test hook: pending stagger timers. */
export function pendingScheduledWakes(): number {
  return timers.size;
}
