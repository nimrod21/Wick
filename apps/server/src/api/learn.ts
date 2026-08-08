/**
 * Learning APIs (IMPL-3 §5.5) — everything the Phase-6 UI needs to show what
 * the bots have learned.
 *
 *   GET /api/bots/:id/stats           — indicator table (weight, hit-rate, samples, enabled)
 *   GET /api/bots/:id/journal?kind=   — reflections and/or lessons + current lessons
 *   GET /api/bots/:id/outcomes        — decisions joined with their 1h/4h/24h scores
 *   GET /api/stats/models             — model-vs-model scoreboard across bots
 *
 * Registered under two prefixes (see api/server.ts): the first three under
 * `/api/bots`, the scoreboard under `/api/stats`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { getBot } from '../paper/engine.js';
import { listIndicatorStats } from '../learn/indicator-stats.js';
import { getLessons } from '../learn/journal.js';

const paramsSchema = z.object({ id: z.coerce.number().int().positive() });
const limitSchema = z.object({ limit: z.coerce.number().int().positive().max(1000).optional() });
const journalQuerySchema = limitSchema.extend({
  kind: z.enum(['reflection', 'lesson']).optional(),
});

interface OutcomeJoinRow {
  id: number;
  ts: number;
  trigger_type: string | null;
  trigger_detail: string | null;
  action: string;
  symbol: string | null;
  size_pct: number | null;
  confidence: number | null;
  reasoning: string | null;
  provider: string | null;
  model: string | null;
  status: string;
  veto_reason: string | null;
  horizon: string | null;
  fwd_ret_pct: number | null;
  score: number | null;
  evaluated_ts: number | null;
}

export async function registerLearnBotRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:id/stats', async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'bad bot id' });
    const bot = getBot(params.data.id);
    if (!bot) return reply.code(404).send({ error: 'bot not found' });
    return { botId: bot.id, stats: listIndicatorStats(bot.id) };
  });

  app.get('/:id/journal', async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'bad bot id' });
    const query = journalQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'bad query' });
    const bot = getBot(params.data.id);
    if (!bot) return reply.code(404).send({ error: 'bot not found' });

    const limit = query.data.limit ?? 100;
    const entries =
      query.data.kind === undefined
        ? db
            .prepare('SELECT id, ts, kind, text FROM journal WHERE bot_id = ? ORDER BY ts DESC, id DESC LIMIT ?')
            .all(bot.id, limit)
        : db
            .prepare(
              'SELECT id, ts, kind, text FROM journal WHERE bot_id = ? AND kind = ? ORDER BY ts DESC, id DESC LIMIT ?',
            )
            .all(bot.id, query.data.kind, limit);

    return { botId: bot.id, entries, lessons: getLessons(bot.id) };
  });

  /** Decision log for the UI: one row per decision, its horizons nested. */
  app.get('/:id/outcomes', async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'bad bot id' });
    const query = limitSchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'bad query' });
    const bot = getBot(params.data.id);
    if (!bot) return reply.code(404).send({ error: 'bot not found' });

    const limit = query.data.limit ?? 50;
    const rows = db
      .prepare(
        `SELECT d.id, d.ts, d.trigger_type, d.trigger_detail, d.action, d.symbol, d.size_pct,
                d.confidence, d.reasoning, d.provider, d.model, d.status, d.veto_reason,
                o.horizon, o.fwd_ret_pct, o.score, o.evaluated_ts
           FROM (SELECT * FROM decisions WHERE bot_id = ? ORDER BY ts DESC, id DESC LIMIT ?) d
           LEFT JOIN outcomes o ON o.decision_id = d.id
          ORDER BY d.ts DESC, d.id DESC, o.horizon`,
      )
      .all(bot.id, limit) as OutcomeJoinRow[];

    const byDecision = new Map<number, Record<string, unknown>>();
    for (const r of rows) {
      let entry = byDecision.get(r.id);
      if (!entry) {
        entry = {
          id: r.id,
          ts: r.ts,
          triggerType: r.trigger_type,
          triggerDetail: r.trigger_detail,
          action: r.action,
          symbol: r.symbol,
          sizePct: r.size_pct,
          confidence: r.confidence,
          reasoning: r.reasoning,
          provider: r.provider,
          model: r.model,
          status: r.status,
          vetoReason: r.veto_reason,
          outcomes: {} as Record<string, unknown>,
        };
        byDecision.set(r.id, entry);
      }
      if (r.horizon !== null) {
        (entry.outcomes as Record<string, unknown>)[r.horizon] = {
          fwdRetPct: r.fwd_ret_pct,
          score: r.score,
          evaluatedTs: r.evaluated_ts,
        };
      }
    }
    return { botId: bot.id, decisions: [...byDecision.values()] };
  });
}

interface ModelAggRow {
  provider: string | null;
  model: string | null;
  decisions: number;
  evaluated: number;
  wins: number;
  losses: number;
  mean_score: number | null;
  trades: number;
  bots: string;
}

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Model-vs-model scoreboard (PLAN §2.10): mean 4h score and W/L per
   * provider+model across every bot. `wins`/`losses` count evaluated
   * decisions with a positive/negative score; zero-score waits are neither.
   */
  app.get('/models', async () => {
    const rows = db
      .prepare(
        `SELECT d.provider AS provider,
                d.model    AS model,
                COUNT(*)                                          AS decisions,
                SUM(CASE WHEN o.score IS NOT NULL THEN 1 ELSE 0 END) AS evaluated,
                SUM(CASE WHEN o.score > 0 THEN 1 ELSE 0 END)      AS wins,
                SUM(CASE WHEN o.score < 0 THEN 1 ELSE 0 END)      AS losses,
                AVG(o.score)                                      AS mean_score,
                SUM(CASE WHEN d.action IN ('buy','sell') AND d.status = 'executed' THEN 1 ELSE 0 END) AS trades,
                GROUP_CONCAT(DISTINCT d.bot_id)                   AS bots
           FROM decisions d
           LEFT JOIN outcomes o ON o.decision_id = d.id AND o.horizon = '4h'
          WHERE d.provider IS NOT NULL
          GROUP BY d.provider, d.model
          ORDER BY (mean_score IS NULL), mean_score DESC, decisions DESC`,
      )
      .all() as ModelAggRow[];

    return {
      horizon: '4h',
      models: rows.map((r) => ({
        provider: r.provider,
        model: r.model,
        decisions: r.decisions,
        evaluated: r.evaluated,
        trades: r.trades,
        wins: r.wins,
        losses: r.losses,
        winRate: r.wins + r.losses > 0 ? r.wins / (r.wins + r.losses) : null,
        meanScore: r.mean_score,
        botIds: (r.bots ?? '')
          .split(',')
          .filter(Boolean)
          .map((s) => Number(s))
          .sort((a, b) => a - b),
      })),
    };
  });
}
