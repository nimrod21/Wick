/**
 * Indicators API — exposes `indicator_readings` as a catalog + per-series
 * time series.
 *
 * GET /api/indicators            → latest row per indicator name
 * GET /api/indicators/:name      → time series with optional from/to/limit
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';

const seriesQuerySchema = z.object({
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

const historyQuerySchema = z.object({
  name: z.string().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});

const historyStmt = db.prepare(
  `SELECT ts, value FROM indicator_readings
    WHERE name = ? ORDER BY ts DESC LIMIT ?`,
);

interface ReadingRow {
  id: number;
  name: string;
  ts: number;
  value: number;
  meta_json: string | null;
}

function parseMeta(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function registerIndicatorsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/indicators/history?name=<string>&limit=<int>
  //   chart-overlay-friendly shape: { points: [{ ts, value }, ...] } ascending.
  app.get('/history', async (req, reply) => {
    const parsed = historyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid query', issues: parsed.error.issues });
    }
    const { name, limit } = parsed.data;
    const rowsDesc = historyStmt.all(name, limit) as Array<{ ts: number; value: number }>;
    const points = rowsDesc.slice().reverse();
    return { points };
  });

  // GET /api/indicators — latest row per name
  app.get('/', async () => {
    const rows = db
      .prepare(
        `SELECT id, name, ts, value, meta_json FROM indicator_readings
          WHERE (name, ts) IN (
            SELECT name, MAX(ts) FROM indicator_readings GROUP BY name
          )
          ORDER BY name`,
      )
      .all() as ReadingRow[];

    const indicators = rows.map((r) => ({
      name: r.name,
      ts: r.ts,
      value: r.value,
      meta: parseMeta(r.meta_json),
    }));
    return { indicators };
  });

  // GET /api/indicators/:name — history
  app.get<{ Params: { name: string } }>('/:name', async (req, reply) => {
    const name = String(req.params.name);
    if (!name || name.length > 100) {
      return reply.code(400).send({ error: 'invalid name' });
    }
    const parsed = seriesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }

    const limit = parsed.data.limit ?? 500;
    const wheres: string[] = ['name = ?'];
    const params: Array<string | number> = [name];
    if (parsed.data.from !== undefined) {
      wheres.push('ts >= ?');
      params.push(parsed.data.from);
    }
    if (parsed.data.to !== undefined) {
      wheres.push('ts <= ?');
      params.push(parsed.data.to);
    }
    const sql =
      `SELECT id, name, ts, value, meta_json FROM indicator_readings
         WHERE ${wheres.join(' AND ')}
         ORDER BY ts DESC
         LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as ReadingRow[];
    // Oldest-first for chart consumers.
    const ordered = rows.slice().reverse();
    const points = ordered.map((r) => ({
      ts: r.ts,
      value: r.value,
      meta: parseMeta(r.meta_json),
    }));
    return { name, points };
  });
}
