/**
 * News API — paginated read over `events` rows where `kind = 'news'`.
 *
 * Filters:
 * - `tickers=BTC,ETH` → keep rows whose payload.tickers intersects the list
 * - `sources=CoinDesk,Bloomberg Markets` → exact match on payload.source
 *   (or the top-level `events.source` column)
 * - `minSentiment` / `maxSentiment` → inclusive range on payload.sentiment.
 *   Null sentiment rows are kept only when no explicit range was passed.
 * - `limit` (default 50, max 500), `before` (ts cursor, default now)
 *
 * We use `json_extract` for the ticker/sentiment filters so the heavy
 * lifting happens inside SQLite rather than hydrating thousands of rows
 * into JS just to drop most of them.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { nowSec } from '../util/time.js';

const csvList = (max = 50) =>
  z
    .string()
    .optional()
    .transform((s) =>
      s === undefined || s.length === 0
        ? undefined
        : s
            .split(',')
            .map((p) => p.trim())
            .filter((p) => p.length > 0)
            .slice(0, max),
    );

const listQuerySchema = z.object({
  tickers: csvList(50),
  sources: csvList(50),
  minSentiment: z.coerce.number().min(-1).max(1).optional(),
  maxSentiment: z.coerce.number().min(-1).max(1).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  before: z.coerce.number().int().nonnegative().optional(),
});

interface EventRow {
  id: number;
  kind: string;
  source: string;
  ts: number;
  asset_id: number | null;
  severity: number;
  payload_json: string;
}

function rowToEvent(r: EventRow): Record<string, unknown> {
  let payload: unknown = null;
  try {
    payload = JSON.parse(r.payload_json);
  } catch {
    payload = null;
  }
  const obj =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  return {
    ...obj,
    id: r.id,
    kind: r.kind,
    source: (obj.source as string | undefined) ?? r.source,
    ts: r.ts,
    severity: r.severity,
    ...(r.asset_id !== null ? { assetId: r.asset_id } : {}),
  };
}

export async function registerNewsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/news
  app.get('/', async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const limit = parsed.data.limit ?? 50;
    const before = parsed.data.before ?? nowSec();
    const tickers = parsed.data.tickers;
    const sources = parsed.data.sources;
    const hasMin = parsed.data.minSentiment !== undefined;
    const hasMax = parsed.data.maxSentiment !== undefined;
    const min = hasMin ? (parsed.data.minSentiment as number) : -1;
    const max = hasMax ? (parsed.data.maxSentiment as number) : 1;

    const wheres: string[] = ["kind = 'news'", 'ts <= ?'];
    const params: Array<string | number> = [before];

    if (sources && sources.length > 0) {
      const placeholders = sources.map(() => '?').join(',');
      wheres.push(
        `(source IN (${placeholders}) OR json_extract(payload_json, '$.source') IN (${placeholders}))`,
      );
      params.push(...sources, ...sources);
    }

    if (tickers && tickers.length > 0) {
      const orClauses: string[] = [];
      for (const t of tickers) {
        orClauses.push(
          `EXISTS (SELECT 1 FROM json_each(json_extract(payload_json, '$.tickers')) WHERE value = ?)`,
        );
        params.push(t);
      }
      wheres.push(`(${orClauses.join(' OR ')})`);
    }

    if (hasMin || hasMax) {
      // When the user constrains sentiment, drop rows without a sentiment
      // value — they can't satisfy the range.
      wheres.push(
        `(json_extract(payload_json, '$.sentiment') IS NOT NULL
          AND json_extract(payload_json, '$.sentiment') BETWEEN ? AND ?)`,
      );
      params.push(min, max);
    }

    const sql =
      `SELECT id, kind, source, ts, asset_id, severity, payload_json
         FROM events
        WHERE ${wheres.join(' AND ')}
        ORDER BY ts DESC
        LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as EventRow[];
    return { events: rows.map(rowToEvent) };
  });

  // GET /api/news/:id
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const row = db
      .prepare(
        `SELECT id, kind, source, ts, asset_id, severity, payload_json
           FROM events
          WHERE id = ? AND kind = 'news'
          LIMIT 1`,
      )
      .get(id) as EventRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    return { event: rowToEvent(row) };
  });
}
