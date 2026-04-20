/**
 * Probability API — read + write routes backing the dashboard probability
 * cards and the weights editor.
 *
 *   GET    /api/probability?assetId=X&horizon=Y   → latest score row
 *   GET    /api/probability/history?…              → time-series rows
 *   GET    /api/probability/signals?assetId&horiz  → latest signals breakdown
 *   GET    /api/probability/weights                → current weights JSON
 *   PUT    /api/probability/weights                → update + hot-reload
 */

import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import {
  getCurrentWeights,
  reloadWeights,
  weightsFile,
} from '../core/probability-engine.js';
import { logger } from '../util/logger.js';

const HORIZONS = ['1h', '4h', '24h'] as const;
const horizonSchema = z.enum(HORIZONS);

const latestQuerySchema = z.object({
  assetId: z.coerce.number().int().positive(),
  horizon: horizonSchema,
});

const historyQuerySchema = z.object({
  assetId: z.coerce.number().int().positive(),
  horizon: horizonSchema,
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

const signalsQuerySchema = z.object({
  assetId: z.coerce.number().int().positive(),
  horizon: horizonSchema,
});

const SIGNAL_NAMES = [
  'fear_greed_level',
  'fear_greed_delta',
  'dxy_trend',
  'vix_level',
  'funding_rate',
  'open_interest_delta',
  'btc_dominance_trend',
  'whale_netflow_to_exchanges',
  'news_sentiment_aggregate',
  'price_momentum_1h',
  'price_momentum_4h',
  'price_momentum_24h',
  'rsi_14',
  'macd_histogram',
  'macd_line',
  'ema20_slope_4h',
  'ema200_distance',
] as const;

// Non-strict: unknown fields in the body are ignored so older clients
// posting a subset (or newer clients we haven't taught yet) still succeed.
const weightsBodySchema = z
  .object(
    SIGNAL_NAMES.reduce<Record<string, z.ZodOptional<z.ZodNumber>>>((acc, k) => {
      acc[k] = z.number().min(0).max(5).optional();
      return acc;
    }, {}),
  )
  .passthrough();

interface ProbRow {
  id: number;
  ts: number;
  asset_id: number;
  horizon: string;
  bullish_prob: number;
  confidence: number;
  contributing_json: string;
}

interface ContributingSignal {
  name: string;
  valueNormalized: number;
  weight: number;
  asOf: number;
}

function parseContributing(s: string): ContributingSignal[] {
  try {
    const parsed = JSON.parse(s) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is ContributingSignal => {
      if (!x || typeof x !== 'object') return false;
      const o = x as Record<string, unknown>;
      return (
        typeof o.name === 'string' &&
        typeof o.valueNormalized === 'number' &&
        typeof o.weight === 'number' &&
        typeof o.asOf === 'number'
      );
    });
  } catch {
    return [];
  }
}

function rowToScore(r: ProbRow): Record<string, unknown> {
  return {
    id: r.id,
    ts: r.ts,
    assetId: r.asset_id,
    horizon: r.horizon,
    bullishProb: r.bullish_prob,
    confidence: r.confidence,
    contributingSignals: parseContributing(r.contributing_json),
  };
}

export async function registerProbabilityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    const parsed = latestQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const { assetId, horizon } = parsed.data;
    const row = db
      .prepare(
        `SELECT id, ts, asset_id, horizon, bullish_prob, confidence, contributing_json
           FROM probability_history
          WHERE asset_id = ? AND horizon = ?
          ORDER BY ts DESC
          LIMIT 1`,
      )
      .get(assetId, horizon) as ProbRow | undefined;
    if (!row) return { score: null };
    return { score: rowToScore(row) };
  });

  app.get('/history', async (req, reply) => {
    const parsed = historyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const { assetId, horizon } = parsed.data;
    // When the caller supplies `from`/`to` they want a time-series — use the
    // legacy default of 500. Otherwise default to 20 (drawer use case). Cap
    // at 200 for the range-less form, 5000 for range queries.
    const isRangeQuery = parsed.data.from !== undefined || parsed.data.to !== undefined;
    const defaultLimit = isRangeQuery ? 500 : 20;
    const maxLimit = isRangeQuery ? 5000 : 200;
    const rawLimit = parsed.data.limit ?? defaultLimit;
    const limit = Math.min(rawLimit, maxLimit);

    const wheres: string[] = ['asset_id = ?', 'horizon = ?'];
    const params: Array<string | number> = [assetId, horizon];
    if (parsed.data.from !== undefined) {
      wheres.push('ts >= ?');
      params.push(parsed.data.from);
    }
    if (parsed.data.to !== undefined) {
      wheres.push('ts <= ?');
      params.push(parsed.data.to);
    }
    const sql = `SELECT id, ts, asset_id, horizon, bullish_prob, confidence, contributing_json
                   FROM probability_history
                  WHERE ${wheres.join(' AND ')}
                  ORDER BY ts DESC
                  LIMIT ?`;
    params.push(limit);
    const descRows = db.prepare(sql).all(...params) as ProbRow[];
    const rows = descRows.map((r) => ({
      ts: r.ts,
      bullishProb: r.bullish_prob,
      confidence: r.confidence,
      contributing: parseContributing(r.contributing_json),
    }));
    // `points` keeps the legacy ascending chart-friendly shape.
    const ordered = descRows.slice().reverse();
    return {
      rows,
      points: ordered.map((r) => ({
        ts: r.ts,
        bullishProb: r.bullish_prob,
        confidence: r.confidence,
      })),
    };
  });

  app.get('/signals', async (req, reply) => {
    const parsed = signalsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const { assetId, horizon } = parsed.data;
    const row = db
      .prepare(
        `SELECT id, ts, asset_id, horizon, bullish_prob, confidence, contributing_json
           FROM probability_history
          WHERE asset_id = ? AND horizon = ?
          ORDER BY ts DESC
          LIMIT 1`,
      )
      .get(assetId, horizon) as ProbRow | undefined;
    if (!row) return { signals: [], score: null };
    const contributing = parseContributing(row.contributing_json);
    return {
      score: {
        ts: row.ts,
        assetId: row.asset_id,
        horizon: row.horizon,
        bullishProb: row.bullish_prob,
        confidence: row.confidence,
      },
      signals: contributing,
    };
  });

  app.get('/weights', async () => {
    return { weights: getCurrentWeights() };
  });

  app.put('/weights', async (req, reply) => {
    const parsed = weightsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad body', issues: parsed.error.issues });
    }
    // Only keep known signal keys — unknown passthrough fields are dropped so
    // they never hit the on-disk weights file.
    const known: Record<string, number> = {};
    for (const k of SIGNAL_NAMES) {
      const v = parsed.data[k];
      if (typeof v === 'number') known[k] = v;
    }
    const merged = { ...getCurrentWeights(), ...known };
    try {
      await fs.writeFile(weightsFile(), `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    } catch (err) {
      logger.error({ err }, 'probability: failed to persist weights');
      return reply.code(500).send({ error: 'failed to persist weights' });
    }
    // Explicitly reload so the response reflects the new state even if the
    // fs.watch debounce hasn't fired yet.
    const weights = reloadWeights();
    return { weights };
  });
}
