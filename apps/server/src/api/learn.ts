/**
 * Learning APIs (IMPL-3 §5.5) — everything the Phase-6 UI needs to show what
 * the bots have learned.
 *
 *   GET /api/bots/:id/stats           — indicator table (weight, hit-rate, samples, enabled)
 *   GET /api/bots/:id/journal?kind=   — reflections and/or lessons + current lessons
 *   GET /api/bots/:id/outcomes        — decisions joined with their 1h/4h/24h scores
 *   GET /api/stats/models             — model-vs-model scoreboard across bots
 *   GET /api/stats/indicators         — indicator track record across bots (IMPL-2)
 *
 * Registered under two prefixes (see api/server.ts): the first three under
 * `/api/bots`, the rollups under `/api/stats`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { getBot } from '../paper/engine.js';
import {
  DISABLE_FLOOR,
  SAMPLE_FLOOR,
  laplaceHitRate,
  listIndicatorStats,
} from '../learn/indicator-stats.js';
import { listIndicatorDefs } from '../market/indicator-engine.js';
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

interface IndicatorStatJoinRow {
  bot_id: number;
  indicator: string;
  samples: number;
  hits: number;
  weight: number;
  enabled: number;
  updated_ts: number;
  bot_name: string | null;
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

  /**
   * Indicator track record across the whole fleet (IMPL-2). Driven by
   * `INDICATOR_DEFS`, NOT by whatever happens to be in `indicator_stats`, so
   * an indicator that has never been scored still gets a row with its
   * "collecting samples: n/30" progress instead of vanishing from the page.
   */
  app.get('/indicators', async () => {
    const statRows = db
      .prepare(
        `SELECT s.bot_id, s.indicator, s.samples, s.hits, s.weight, s.enabled, s.updated_ts,
                b.name AS bot_name
           FROM indicator_stats s
           LEFT JOIN bots b ON b.id = s.bot_id
          ORDER BY s.indicator, s.bot_id`,
      )
      .all() as Array<IndicatorStatJoinRow>;

    const historyRows = db
      .prepare(
        `SELECT indicator, ts, AVG(weight) AS weight
           FROM indicator_weight_history
          GROUP BY indicator, ts
          ORDER BY indicator, ts`,
      )
      .all() as Array<{ indicator: string; ts: number; weight: number }>;

    const byIndicator = new Map<string, IndicatorStatJoinRow[]>();
    for (const r of statRows) {
      const list = byIndicator.get(r.indicator);
      if (list) list.push(r);
      else byIndicator.set(r.indicator, [r]);
    }
    const historyBy = new Map<string, Array<{ ts: number; weight: number }>>();
    for (const h of historyRows) {
      const list = historyBy.get(h.indicator);
      const point = { ts: h.ts, weight: h.weight };
      if (list) list.push(point);
      else historyBy.set(h.indicator, [point]);
    }

    // Registered indicators first (in registry order), then any orphan stats
    // rows left behind by a renamed/removed indicator — never silently lost.
    const defs = listIndicatorDefs();
    const known = new Set(defs.map((d) => d.name));
    const extra = [...byIndicator.keys()]
      .filter((name) => !known.has(name))
      .sort()
      .map((name) => ({ name, rule: '', scope: 'symbol' as const, registered: false }));

    const indicators = [...defs.map((d) => ({ ...d, registered: true })), ...extra].map((def) => {
      const rows = byIndicator.get(def.name) ?? [];
      const samples = rows.reduce((a, r) => a + r.samples, 0);
      const hits = rows.reduce((a, r) => a + r.hits, 0);
      // Sample-weighted so a bot with 5 samples cannot drag the fleet weight.
      const weightNum = rows.reduce((a, r) => a + r.weight * Math.max(r.samples, 1), 0);
      const weightDen = rows.reduce((a, r) => a + Math.max(r.samples, 1), 0);
      return {
        indicator: def.name,
        rule: def.rule,
        scope: def.scope,
        registered: def.registered,
        samples,
        hits,
        hitRate: samples > 0 ? laplaceHitRate(hits, samples) : null,
        /** Fleet weight: null until any bot has a stats row at all. */
        weight: weightDen > 0 ? weightNum / weightDen : null,
        botCount: rows.length,
        enabledBots: rows.filter((r) => r.enabled === 1).length,
        updatedTs: rows.reduce<number | null>(
          (a, r) => (a === null || r.updated_ts > a ? r.updated_ts : a),
          null,
        ),
        bots: rows.map((r) => ({
          botId: r.bot_id,
          botName: r.bot_name,
          samples: r.samples,
          hits: r.hits,
          hitRate: r.samples > 0 ? laplaceHitRate(r.hits, r.samples) : null,
          weight: r.weight,
          enabled: r.enabled === 1,
          updatedTs: r.updated_ts,
        })),
        history: historyBy.get(def.name) ?? [],
      };
    });

    return { sampleFloor: SAMPLE_FLOOR, disableFloor: DISABLE_FLOOR, indicators };
  });
}
