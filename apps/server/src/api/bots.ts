/**
 * Bot CRUD + lifecycle API (IMPL-3 §4.1).
 *
 *   GET    /api/bots                 — list (with equity/drawdown)
 *   POST   /api/bots                 — create {name, bankroll, config?}
 *   GET    /api/bots/:id             — one bot
 *   PATCH  /api/bots/:id             — rename / merge config / add_funds top-up
 *   DELETE /api/bots/:id             — hard delete, refused while running (409)
 *   POST   /api/bots/:id/start|stop|reset
 *   GET    /api/bots/:id/decisions   — newest first (?limit, default 50)
 *   GET    /api/bots/:id/triggers    — trigger_log incl. gated rows (?limit)
 *
 * Read-only position/fill/equity routes live in `bots-read.ts` (same prefix).
 *
 * DELETE is a hard delete, not an archive: it removes the bot row plus its
 * decisions (+ their outcomes), fills, positions, equity_snapshots, journal,
 * lessons_current, indicator_stats and trigger_log rows in one transaction.
 * Rationale in `bot-store.deleteBot` — no soft-delete column exists, every read
 * path would need a corpse filter, and orphaned outcomes/trigger rows would be
 * inherited by a recycled bot id. `reset` remains the non-destructive option.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  botView,
  createBot,
  getBot,
  listBots,
  deleteBot,
  resetBot,
  startBot,
  stopBot,
  updateBot,
} from '../bots/bot-store.js';

const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
const limitSchema = z.object({ limit: z.coerce.number().int().positive().max(1000).optional() });

const configSchema = z
  .object({
    cadence_tf: z.enum(['1m', '15m', '1h', '4h', '1d']).optional(),
    symbols: z.array(z.string().min(1)).min(1).optional(),
    provider_order: z.array(z.string().min(1)).optional(),
    model_prefs: z.array(z.string()).optional(),
    personality: z.string().max(500).optional(),
    min_confidence: z.number().min(0).max(100).optional(),
    max_trades_day: z.number().int().min(0).max(100).optional(),
    cooldown_min: z.number().min(0).optional(),
    min_hold_min: z.number().min(0).optional(),
    max_pos_pct: z.number().min(1).max(100).optional(),
    drawdown_kill_pct: z.number().min(1).max(100).optional(),
    default_sl_pct: z.number().optional(),
    default_tp_pct: z.number().optional(),
  })
  .strict();

const createSchema = z.object({
  name: z.string().min(1).max(60),
  bankroll: z.number().positive().max(10_000_000),
  status: z.enum(['running', 'stopped']).optional(),
  config: configSchema.optional(),
});

const patchSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  config: configSchema.optional(),
  /** Bankroll top-up in USD — credited to cash and bankroll_start alike. */
  add_funds: z.number().positive().max(10_000_000).optional(),
});

export async function registerBotsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async () => ({ bots: listBots().map(botView) }));

  app.post('/', async (req, reply) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'bad body', issues: body.error.issues });
    }
    const bot = createBot({
      name: body.data.name,
      bankroll: body.data.bankroll,
      status: body.data.status,
      config: body.data.config,
    });
    return reply.code(201).send({ bot: botView(bot) });
  });

  app.get('/:id', async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'bad bot id' });
    const bot = getBot(params.data.id);
    if (!bot) return reply.code(404).send({ error: 'bot not found' });
    return { bot: botView(bot) };
  });

  app.patch('/:id', async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'bad bot id' });
    const body = patchSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'bad body', issues: body.error.issues });
    }
    const bot = updateBot(params.data.id, {
      name: body.data.name,
      config: body.data.config,
      addFunds: body.data.add_funds,
    });
    if (!bot) return reply.code(404).send({ error: 'bot not found' });
    return { bot: botView(bot) };
  });

  app.delete('/:id', async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'bad bot id' });
    const result = deleteBot(params.data.id);
    if (result === 'not_found') return reply.code(404).send({ error: 'bot not found' });
    if (result === 'running') {
      return reply.code(409).send({ error: 'bot is running — stop it before deleting' });
    }
    return { ok: true, deleted: params.data.id };
  });

  const action = (
    path: string,
    fn: (id: number) => ReturnType<typeof startBot>,
  ): void => {
    app.post(path, async (req, reply) => {
      const params = paramsSchema.safeParse(req.params);
      if (!params.success) return reply.code(400).send({ error: 'bad bot id' });
      const bot = fn(params.data.id);
      if (!bot) return reply.code(404).send({ error: 'bot not found' });
      return { bot: botView(bot) };
    });
  };

  action('/:id/start', startBot);
  action('/:id/stop', stopBot);
  action('/:id/reset', resetBot);

  app.get('/:id/decisions', async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'bad bot id' });
    const query = limitSchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'bad query' });
    const bot = getBot(params.data.id);
    if (!bot) return reply.code(404).send({ error: 'bot not found' });

    const decisions = db
      .prepare(
        `SELECT id, bot_id, ts, trigger_type, trigger_detail, action, symbol, size_pct,
                confidence, reasoning, sl_pct, tp_pct, provider, model, latency_ms,
                status, veto_reason
           FROM decisions WHERE bot_id = ? ORDER BY ts DESC, id DESC LIMIT ?`,
      )
      .all(bot.id, query.data.limit ?? 50);
    return { botId: bot.id, decisions };
  });

  app.get('/:id/triggers', async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'bad bot id' });
    const query = limitSchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'bad query' });
    const bot = getBot(params.data.id);
    if (!bot) return reply.code(404).send({ error: 'bot not found' });

    const triggers = db
      .prepare('SELECT * FROM trigger_log WHERE bot_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
      .all(bot.id, query.data.limit ?? 100);
    return { botId: bot.id, triggers };
  });
}
