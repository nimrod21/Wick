import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { nowMs } from '../util/time.js';

const TIMEFRAMES = ['1m', '15m', '1h', '4h', '1d'] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

const querySchema = z.object({
  symbol: z.string().min(1),
  tf: z.enum(TIMEFRAMES),
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
    const { symbol, tf } = parsed.data;
    const limit = parsed.data.limit ?? 500;
    const to = parsed.data.to ?? nowMs();
    const from = parsed.data.from ?? to - limit * TIMEFRAME_MS[tf];

    const rows = db
      .prepare(
        `SELECT ts, o, h, l, c, v FROM candles
          WHERE symbol = ? AND tf = ? AND ts >= ? AND ts <= ?
          ORDER BY ts ASC
          LIMIT ?`,
      )
      .all(symbol.toUpperCase(), tf, from, to, limit) as CandleRow[];
    return { candles: rows };
  });
}
