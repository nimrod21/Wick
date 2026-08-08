import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';

const TIMEFRAMES = ['1m', '15m', '1h', '4h', '1d'] as const;

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

/** GET /api/market/candles?symbol&tf&limit[&from&to] — newest last. */
export async function registerCandlesRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const { symbol, tf, from, to } = parsed.data;
    const limit = parsed.data.limit ?? 500;
    const sym = symbol.toUpperCase();

    let rows: CandleRow[];
    if (from !== undefined || to !== undefined) {
      rows = db
        .prepare(
          `SELECT ts, o, h, l, c, v FROM candles
            WHERE symbol = ? AND tf = ? AND ts >= ? AND ts <= ?
            ORDER BY ts ASC
            LIMIT ?`,
        )
        .all(sym, tf, from ?? 0, to ?? Number.MAX_SAFE_INTEGER, limit) as CandleRow[];
    } else {
      // Newest `limit` candles regardless of gaps, oldest-first in the response.
      rows = (
        db
          .prepare(
            `SELECT ts, o, h, l, c, v FROM candles
              WHERE symbol = ? AND tf = ?
              ORDER BY ts DESC
              LIMIT ?`,
          )
          .all(sym, tf, limit) as CandleRow[]
      ).reverse();
    }
    return { symbol: sym, tf, candles: rows };
  });
}
