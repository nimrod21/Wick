import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { nowSec } from '../util/time.js';

const TIMEFRAMES = ['1m', '3m', '15m', '1h', '4h', '1d', '1w'] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '3m': 180,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
  '1w': 604800,
};

const TIMEFRAME_TABLE: Record<Timeframe, string> = {
  '1m': 'candles_1m',
  '3m': 'candles_3m',
  '15m': 'candles_15m',
  '1h': 'candles_1h',
  '4h': 'candles_4h',
  '1d': 'candles_1d',
  '1w': 'candles_1w',
};

const querySchema = z.object({
  assetId: z.coerce.number().int().positive(),
  timeframe: z.enum(TIMEFRAMES),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

interface CandleRow {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export async function registerCandlesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const { assetId, timeframe } = parsed.data;
    const limit = parsed.data.limit ?? 500;
    const to = parsed.data.to ?? nowSec();
    const from = parsed.data.from ?? to - limit * TIMEFRAME_SECONDS[timeframe];

    const table = TIMEFRAME_TABLE[timeframe];
    // Safe: `table` is selected from a fixed lookup, not user input.
    const sql =
      `SELECT ts, o, h, l, c, v FROM ${table}
        WHERE asset_id = ? AND ts >= ? AND ts <= ?
        ORDER BY ts ASC
        LIMIT ?`;
    const rows = db.prepare(sql).all(assetId, from, to, limit) as CandleRow[];
    return { candles: rows };
  });
}
