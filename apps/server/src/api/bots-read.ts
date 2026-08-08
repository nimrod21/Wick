/**
 * Read-only bot data routes (IMPL-2 §2.5). Bot CRUD/lifecycle is Phase 4.
 *
 *   GET /api/bots/:id/positions  — open positions + live marks
 *   GET /api/bots/:id/fills      — newest first, ?limit (default 100, max 1000)
 *   GET /api/bots/:id/equity     — current equity/drawdown + snapshots (?limit)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { equity, getBot, getDrawdown, getPositions, midPrice } from '../paper/engine.js';

const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
const limitSchema = z.object({ limit: z.coerce.number().int().positive().max(1000).optional() });

export async function registerBotsReadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:id/positions', async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'bad bot id' });
    const bot = getBot(params.data.id);
    if (!bot) return reply.code(404).send({ error: 'bot not found' });

    const positions = getPositions(bot.id).map((p) => {
      const mid = midPrice(p.symbol);
      return {
        symbol: p.symbol,
        qty: p.qty,
        avgEntry: p.avg_entry,
        stopPrice: p.stop_price,
        tpPrice: p.tp_price,
        openedTs: p.opened_ts,
        mid,
        valueUsd: mid !== null ? p.qty * mid : null,
        unrealizedPnl: mid !== null ? (mid - p.avg_entry) * p.qty : null,
      };
    });
    return { botId: bot.id, positions };
  });

  app.get('/:id/fills', async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'bad bot id' });
    const query = limitSchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'bad query' });
    const bot = getBot(params.data.id);
    if (!bot) return reply.code(404).send({ error: 'bot not found' });

    const fills = db
      .prepare('SELECT * FROM fills WHERE bot_id = ? ORDER BY ts DESC LIMIT ?')
      .all(bot.id, query.data.limit ?? 100);
    return { botId: bot.id, fills };
  });

  app.get('/:id/equity', async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'bad bot id' });
    const query = limitSchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'bad query' });
    const bot = getBot(params.data.id);
    if (!bot) return reply.code(404).send({ error: 'bot not found' });

    const snapshots = (
      db
        .prepare('SELECT ts, equity FROM equity_snapshots WHERE bot_id = ? ORDER BY ts DESC LIMIT ?')
        .all(bot.id, query.data.limit ?? 168) as Array<{ ts: number; equity: number }>
    ).reverse(); // oldest-first for charting
    const dd = getDrawdown(bot.id);
    return {
      botId: bot.id,
      cash: bot.cash,
      bankrollStart: bot.bankroll_start,
      equity: equity(bot.id),
      highWaterMark: dd?.highWaterMark ?? null,
      drawdownPct: dd?.drawdownPct ?? null,
      snapshots,
    };
  });
}
