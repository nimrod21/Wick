/**
 * Manual trading API (IMPL-4 trade) — Luka's own paper account.
 *
 *   GET   /api/trade/account   — balance, equity, positions, fill history
 *   POST  /api/trade/order     — buy/sell, $ or % size, optional SL/TP
 *   PATCH /api/trade/position  — edit SL/TP on an open position
 *   POST  /api/trade/deposit   — give yourself more fake money
 *   POST  /api/trade/reset     — flatten + restore starting capital
 *
 * The account is a `bots` row with `kind:'human'` (see `bot-store`), so every
 * order goes through the SAME paper engine the bots use: fills, positions,
 * fees/slippage, the SL/TP protector, hourly equity snapshots and the model
 * scoreboard all work with no special-casing.
 *
 * GUARDS ARE SKIPPED ON PURPOSE (IMPL-4): `risk-guards` (confidence floor,
 * cooldown, min hold, max position %, trades/day) exists to keep an LLM
 * disciplined — the human may microtrade if he wants. Only the engine's own
 * hard limits apply: $10 min notional, enough cash, an actual position to
 * sell. Those come back as typed rejections and are surfaced as 400s.
 *
 * Decision rows: every FILLED order writes a `decisions` row with
 * provider 'human' / status 'executed', which is all the existing evaluator
 * needs to score it at 1h/4h/24h like any bot decision — that is what puts
 * "you" on `/api/stats/models` (grouped by provider, so the human is simply
 * provider `human`, model NULL; no aggregation change was needed).
 * Unlike `bot-runner`, the row is written AFTER a successful fill: a rejected
 * manual order is a form error, not a decision, and must not land in the
 * audit trail (bot-runner writes first because an LLM really did decide).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  buy,
  equity,
  getDrawdown,
  getPosition,
  midPrice,
  sell,
  MIN_NOTIONAL_USD,
  type TradeResult,
} from '../paper/engine.js';
import { ensureHumanAccount, resetBot, updateBot } from '../bots/bot-store.js';
import { positionViews } from './bots-read.js';
import { logger } from '../util/logger.js';
import { nowMs } from '../util/time.js';

const limitSchema = z.object({ limit: z.coerce.number().int().positive().max(1000).optional() });

const orderSchema = z
  .object({
    symbol: z.string().min(3).max(20),
    side: z.enum(['buy', 'sell']),
    /** Dollar size. buy: notional to spend. sell: dollar value to close. */
    notional: z.number().positive().max(10_000_000).optional(),
    /** Percent size. buy: % of cash. sell: % of the position. */
    pct: z.number().positive().max(100).optional(),
    sl_pct: z.number().min(0).max(99).nullish(),
    tp_pct: z.number().min(0).max(1000).nullish(),
    note: z.string().max(500).optional(),
  })
  .refine((b) => b.notional !== undefined || b.pct !== undefined, {
    message: 'notional or pct required',
  });

const positionSchema = z.object({
  symbol: z.string().min(3).max(20),
  /** null clears the level; omitted leaves it untouched. */
  sl_pct: z.number().min(0).max(99).nullish(),
  tp_pct: z.number().min(0).max(1000).nullish(),
});

const depositSchema = z.object({ amount: z.number().positive().max(10_000_000) });

const resetSchema = z.object({
  /** Re-base starting capital as well (default: keep what has been paid in). */
  bankroll: z.number().positive().max(10_000_000).optional(),
});

/** HTTP status for an engine rejection: 400 for anything the user can fix. */
function rejection(result: Extract<TradeResult, { ok: false }>): {
  error: string;
  reason: string;
  detail?: string;
} {
  return { error: 'order rejected', reason: result.reason, detail: result.detail };
}

function writeHumanDecision(input: {
  botId: number;
  action: 'buy' | 'sell';
  symbol: string;
  sizePct: number | null;
  slPct: number | null;
  tpPct: number | null;
  note: string | null;
}): number {
  const info = db
    .prepare(
      `INSERT INTO decisions
         (bot_id, ts, trigger_type, trigger_detail, action, symbol, size_pct,
          confidence, reasoning, sl_pct, tp_pct, provider, status)
       VALUES (?, ?, 'manual', 'manual order from /trade', ?, ?, ?, 100, ?, ?, ?, 'human', 'executed')`,
    )
    .run(
      input.botId,
      nowMs(),
      input.action,
      input.symbol,
      input.sizePct,
      input.note ?? `manual ${input.action} ${input.symbol}`,
      input.slPct,
      input.tpPct,
    );
  return Number(info.lastInsertRowid);
}

export async function registerTradeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/account', async (req, reply) => {
    const query = limitSchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'bad query' });
    const human = ensureHumanAccount();
    const dd = getDrawdown(human.id);
    // The fill rows plus WHY they happened: a protector exit carries its
    // decision's trigger type/detail, which is what marks SL/TP on the chart
    // and in the history table (fills themselves store no reason).
    const fills = db
      .prepare(
        `SELECT f.*, d.trigger_type, d.trigger_detail
           FROM fills f LEFT JOIN decisions d ON d.id = f.decision_id
          WHERE f.bot_id = ? ORDER BY f.ts DESC, f.id DESC LIMIT ?`,
      )
      .all(human.id, query.data.limit ?? 200);
    return {
      botId: human.id,
      name: human.name,
      cash: human.cash,
      bankrollStart: human.bankroll_start,
      equity: dd?.equity ?? equity(human.id),
      drawdownPct: dd?.drawdownPct ?? null,
      minNotional: MIN_NOTIONAL_USD,
      positions: positionViews(human.id),
      fills,
    };
  });

  app.post('/order', async (req, reply) => {
    const body = orderSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'bad body', issues: body.error.issues });
    }
    const { side, note } = body.data;
    const symbol = body.data.symbol.toUpperCase();
    const human = ensureHumanAccount();
    const slPct = body.data.sl_pct ?? null;
    const tpPct = body.data.tp_pct ?? null;

    let result: TradeResult;
    let sizePct: number | null = null;

    if (side === 'buy') {
      const notional = body.data.notional ?? (human.cash * (body.data.pct as number)) / 100;
      const eq = equity(human.id) ?? 0;
      sizePct = eq > 0 ? (notional / eq) * 100 : null;
      result = buy(human.id, symbol, notional, { slPct, tpPct });
    } else {
      const position = getPosition(human.id, symbol);
      if (!position) {
        return reply.code(400).send({ error: 'order rejected', reason: 'no_position', detail: symbol });
      }
      const value = position.qty * (midPrice(symbol) ?? position.avg_entry);
      const raw =
        body.data.pct ?? (value > 0 ? ((body.data.notional as number) / value) * 100 : 100);
      sizePct = Math.min(raw, 100);
      result = sell(human.id, symbol, sizePct);
    }

    if (!result.ok) return reply.code(400).send(rejection(result));

    const decisionId = writeHumanDecision({
      botId: human.id,
      action: side,
      symbol,
      sizePct,
      slPct,
      tpPct,
      note: note ?? null,
    });
    db.prepare('UPDATE fills SET decision_id = ? WHERE id = ?').run(decisionId, result.fill.id);
    logger.info(
      { bot: human.id, symbol, side, decision: decisionId, fill: result.fill.id },
      'manual order filled',
    );

    return {
      ok: true,
      decisionId,
      fill: result.fill,
      position: result.position,
      cash: result.cash,
      equity: equity(human.id),
    };
  });

  /**
   * Edit SL/TP on an open position. Levels are stored as absolute prices
   * derived from the average entry, exactly like the engine computes them on a
   * buy. The protector re-reads `positions` every 5s, so an edit arms within
   * that window without any new wiring.
   */
  app.patch('/position', async (req, reply) => {
    const body = positionSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'bad body', issues: body.error.issues });
    }
    const symbol = body.data.symbol.toUpperCase();
    const human = ensureHumanAccount();
    const position = getPosition(human.id, symbol);
    if (!position) return reply.code(404).send({ error: 'no position', symbol });

    const stop =
      body.data.sl_pct === undefined
        ? position.stop_price
        : body.data.sl_pct === null || body.data.sl_pct === 0
          ? null
          : position.avg_entry * (1 - Math.abs(body.data.sl_pct) / 100);
    const tp =
      body.data.tp_pct === undefined
        ? position.tp_price
        : body.data.tp_pct === null || body.data.tp_pct === 0
          ? null
          : position.avg_entry * (1 + Math.abs(body.data.tp_pct) / 100);

    db.prepare('UPDATE positions SET stop_price = ?, tp_price = ? WHERE bot_id = ? AND symbol = ?').run(
      stop,
      tp,
      human.id,
      symbol,
    );
    logger.info({ bot: human.id, symbol, stop, tp }, 'manual SL/TP updated');
    return { ok: true, positions: positionViews(human.id) };
  });

  app.post('/deposit', async (req, reply) => {
    const body = depositSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'bad body', issues: body.error.issues });
    }
    const human = ensureHumanAccount();
    // Credited to cash AND bankroll_start, so a deposit never reads as profit.
    const updated = updateBot(human.id, { addFunds: body.data.amount });
    if (!updated) return reply.code(404).send({ error: 'account missing' });
    return { ok: true, cash: updated.cash, bankrollStart: updated.bankroll_start };
  });

  app.post('/reset', async (req, reply) => {
    const body = resetSchema.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'bad body', issues: body.error.issues });
    }
    const human = ensureHumanAccount();
    if (body.data.bankroll !== undefined) {
      db.prepare('UPDATE bots SET bankroll_start = ? WHERE id = ?').run(body.data.bankroll, human.id);
    }
    // Liquidates at mid, restores cash = bankroll_start, clears the equity
    // snapshots the drawdown high-water mark is derived from. Fills and
    // decisions keep their rows — that history is real and stays honest.
    const updated = resetBot(human.id);
    if (!updated) return reply.code(404).send({ error: 'account missing' });
    return { ok: true, cash: updated.cash, bankrollStart: updated.bankroll_start };
  });
}
