/**
 * SL/TP protector (IMPL-2 §2.2) — pure code, never waits for an LLM.
 *
 * Subscribes to live bus ticks and holds an in-memory index of every open
 * position's stop/tp price, keyed symbol → botId. On breach it executes a
 * same-tick 100% market exit through the paper engine, writing a synthetic
 * decision row (action 'sell', trigger_type 'protector', provider 'code')
 * so the audit trail stays complete; the engine publishes the fill event.
 *
 * Boot: the index is rebuilt from the `positions` table, but ticks are
 * only armed after `marketWarm` (PLAN §16.9 / IMPL-2 pitfalls) so a
 * half-filled candle store can never trigger exits. The index self-heals
 * on every `fill` event (buys arm/update levels, sells disarm).
 */

import type { FillEvent, TickEvent } from '@wick/shared';
import { db } from '../db/client.js';
import { eventBus } from '../core/event-bus.js';
import { isMarketWarm } from '../market/market-state.js';
import { logger } from '../util/logger.js';
import { nowMs } from '../util/time.js';
import { sell } from './engine.js';

interface Levels {
  stop: number | null;
  tp: number | null;
}

// symbol → (botId → levels)
const index = new Map<string, Map<number, Levels>>();

let started = false;
let armed = false;
const unsubs: Array<() => void> = [];
let reconcileTimer: NodeJS.Timeout | null = null;
/** Index reconcile cadence — catches positions written by OTHER processes
 * (dev CLI) that never hit this process's event bus. Exit detection itself
 * is tick-driven; this only maintains the armed index. */
const RECONCILE_MS = 5_000;

function setLevels(symbol: string, botId: number, levels: Levels | null): void {
  let bots = index.get(symbol);
  if (levels === null || (levels.stop === null && levels.tp === null)) {
    if (bots) {
      bots.delete(botId);
      if (bots.size === 0) index.delete(symbol);
    }
    return;
  }
  if (!bots) {
    bots = new Map();
    index.set(symbol, bots);
  }
  bots.set(botId, levels);
}

/** Re-read one (bot, symbol) position from DB and sync the index. */
function refresh(botId: number, symbol: string): void {
  const row = db
    .prepare('SELECT qty, stop_price, tp_price FROM positions WHERE bot_id = ? AND symbol = ?')
    .get(botId, symbol) as { qty: number; stop_price: number | null; tp_price: number | null } | undefined;
  if (!row || row.qty <= 1e-12) {
    setLevels(symbol, botId, null);
  } else {
    setLevels(symbol, botId, { stop: row.stop_price, tp: row.tp_price });
  }
}

function rebuildFromDb(): number {
  index.clear();
  const rows = db
    .prepare('SELECT bot_id, symbol, stop_price, tp_price FROM positions WHERE qty > 1e-12')
    .all() as Array<{ bot_id: number; symbol: string; stop_price: number | null; tp_price: number | null }>;
  for (const r of rows) {
    setLevels(r.symbol, r.bot_id, { stop: r.stop_price, tp: r.tp_price });
  }
  return rows.length;
}

function fire(botId: number, symbol: string, reason: 'sl' | 'tp', price: number, level: number): void {
  // Disarm first — burst ticks must not double-fire while we execute.
  setLevels(symbol, botId, null);

  const ts = nowMs();
  const info = db
    .prepare(
      `INSERT INTO decisions
         (bot_id, ts, trigger_type, trigger_detail, action, symbol, size_pct,
          reasoning, provider, status)
       VALUES (?, ?, 'protector', ?, 'sell', ?, 100, ?, 'code', 'executed')`,
    )
    .run(
      botId,
      ts,
      `${reason}:${symbol}@${price} level=${level}`,
      symbol,
      `code protector: ${reason === 'sl' ? 'stop-loss' : 'take-profit'} ${level} breached by tick ${price}`,
    );
  const decisionId = Number(info.lastInsertRowid);

  const res = sell(botId, symbol, 100, { decisionId, reason });
  if (!res.ok) {
    logger.error({ bot: botId, symbol, reason, res }, 'protector exit failed');
    if (res.reason !== 'no_position') refresh(botId, symbol); // re-arm, retry next tick
    return;
  }
  logger.info(
    { bot: botId, symbol, reason, tick: price, level, price: res.fill.price },
    'protector fired',
  );
}

function onTick(e: TickEvent): void {
  const bots = index.get(e.symbol);
  if (!bots || bots.size === 0) return;
  // Copy — fire() mutates the index synchronously.
  for (const [botId, levels] of [...bots]) {
    if (levels.stop !== null && e.price <= levels.stop) {
      fire(botId, e.symbol, 'sl', e.price, levels.stop);
    } else if (levels.tp !== null && e.price >= levels.tp) {
      fire(botId, e.symbol, 'tp', e.price, levels.tp);
    }
  }
}

function onFill(e: FillEvent): void {
  if (!armed) return;
  refresh(e.botId, e.symbol);
}

function arm(): void {
  if (armed) return;
  const n = rebuildFromDb();
  armed = true;
  unsubs.push(eventBus.on('tick', onTick));
  reconcileTimer = setInterval(() => {
    try {
      rebuildFromDb();
    } catch (err) {
      logger.error({ err }, 'protector reconcile failed');
    }
  }, RECONCILE_MS);
  reconcileTimer.unref();
  logger.info({ positions: n }, 'protector armed');
}

export function startProtector(): void {
  if (started) return;
  started = true;
  unsubs.push(eventBus.on('fill', onFill));
  if (isMarketWarm()) {
    arm();
  } else {
    unsubs.push(
      eventBus.on('market_warm', () => {
        arm();
      }),
    );
  }
}

export function stopProtector(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  for (const u of unsubs.splice(0)) u();
  index.clear();
  armed = false;
  started = false;
}

/** Test/debug view of the armed levels. */
export function protectorIndexSnapshot(): Record<string, Record<number, Levels>> {
  const out: Record<string, Record<number, Levels>> = {};
  for (const [sym, bots] of index) {
    out[sym] = Object.fromEntries(bots);
  }
  return out;
}
