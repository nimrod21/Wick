import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { nowSec } from '../util/time.js';

const EVENT_KINDS = [
  'candle',
  'whale_tx',
  'news',
  'indicator',
  'alert',
  'trade_tick',
  'orderbook',
] as const;

const querySchema = z.object({
  kind: z.enum(EVENT_KINDS).optional(),
  assetId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
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
    payload = r.payload_json;
  }
  const payloadObj =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  return {
    // The payload stores the full typed Event; top-level wrapper columns win
    // so callers get consistent fields even if the payload was shortened.
    ...payloadObj,
    id: r.id,
    kind: r.kind,
    source: r.source,
    ts: r.ts,
    severity: r.severity,
    ...(r.asset_id !== null ? { assetId: r.asset_id } : {}),
  };
}

export async function registerEventsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const limit = parsed.data.limit ?? 100;
    const before = parsed.data.before ?? nowSec();

    const wheres: string[] = ['ts <= ?'];
    const params: Array<string | number> = [before];
    if (parsed.data.kind) {
      wheres.push('kind = ?');
      params.push(parsed.data.kind);
    }
    if (parsed.data.assetId !== undefined) {
      wheres.push('asset_id = ?');
      params.push(parsed.data.assetId);
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
}
