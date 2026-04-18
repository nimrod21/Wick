/**
 * Whale tracker API — CRUD over `whale_addresses` + `ignore_addresses`,
 * plus a recent-events query filtered to `kind = 'whale_tx'`.
 *
 * ETH addresses are normalised to lowercase at storage time; chain
 * values are validated against the union `eth|sol|btc`. Tags are stored
 * as JSON-encoded string arrays.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { nowSec } from '../util/time.js';

const CHAINS = ['eth', 'sol', 'btc'] as const;
type Chain = (typeof CHAINS)[number];
const chainSchema = z.enum(CHAINS);

const listQuerySchema = z.object({
  chain: chainSchema.optional(),
});

const postBodySchema = z.object({
  chain: chainSchema,
  address: z.string().min(4),
  label: z.string().min(1).max(100).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
});

const patchBodySchema = z
  .object({
    label: z.string().min(1).max(100).nullable().optional(),
    tags: z.array(z.string().min(1).max(50)).max(20).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, {
    message: 'at least one field required',
  });

const ignorePostBodySchema = z.object({
  chain: chainSchema,
  address: z.string().min(4),
  label: z.string().min(1).max(100).optional(),
});

const eventsQuerySchema = z.object({
  chain: chainSchema.optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  before: z.coerce.number().int().nonnegative().optional(),
});

interface WhaleRow {
  id: number;
  chain: string;
  address: string;
  label: string | null;
  tags_json: string | null;
  added_at: number;
  last_checked_block: number | null;
  last_checked_ts: number | null;
  last_checked_cursor: string | null;
  enabled: number;
}

interface IgnoreRow {
  chain: string;
  address: string;
  label: string | null;
}

interface EventRow {
  id: number;
  kind: string;
  source: string;
  ts: number;
  asset_id: number | null;
  severity: number;
  payload_json: string;
}

function normaliseAddress(chain: Chain, address: string): string {
  const trimmed = address.trim();
  if (chain === 'eth') return trimmed.toLowerCase();
  // BTC/SOL are case-sensitive; preserve user input.
  return trimmed;
}

function rowToWhale(r: WhaleRow): Record<string, unknown> {
  let tags: string[] = [];
  if (r.tags_json) {
    try {
      const parsed = JSON.parse(r.tags_json);
      if (Array.isArray(parsed)) tags = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      tags = [];
    }
  }
  return {
    id: r.id,
    chain: r.chain,
    address: r.address,
    label: r.label,
    tags,
    addedAt: r.added_at,
    lastCheckedBlock: r.last_checked_block,
    lastCheckedTs: r.last_checked_ts,
    lastCheckedCursor: r.last_checked_cursor,
    enabled: r.enabled === 1,
  };
}

function rowToEvent(r: EventRow): Record<string, unknown> {
  let payload: unknown = null;
  try {
    payload = JSON.parse(r.payload_json);
  } catch {
    payload = r.payload_json;
  }
  const obj =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  return {
    ...obj,
    id: r.id,
    kind: r.kind,
    source: r.source,
    ts: r.ts,
    severity: r.severity,
    ...(r.asset_id !== null ? { assetId: r.asset_id } : {}),
  };
}

export async function registerWhalesRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/whales — list
  app.get('/', async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const { chain } = parsed.data;
    const rows = chain
      ? (db
          .prepare('SELECT * FROM whale_addresses WHERE chain = ? ORDER BY id')
          .all(chain) as WhaleRow[])
      : (db
          .prepare('SELECT * FROM whale_addresses ORDER BY chain, id')
          .all() as WhaleRow[]);
    return { whales: rows.map(rowToWhale) };
  });

  // POST /api/whales — add / upsert
  app.post('/', async (req, reply) => {
    const parsed = postBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad body', issues: parsed.error.issues });
    }
    const b = parsed.data;
    const address = normaliseAddress(b.chain, b.address);
    const tagsJson = b.tags ? JSON.stringify(b.tags) : null;
    db.prepare(
      `INSERT INTO whale_addresses
         (chain, address, label, tags_json, added_at, enabled)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(chain, address) DO UPDATE SET
         label = excluded.label,
         tags_json = excluded.tags_json,
         enabled = 1`,
    ).run(b.chain, address, b.label ?? null, tagsJson, nowSec());

    const row = db
      .prepare('SELECT * FROM whale_addresses WHERE chain = ? AND address = ?')
      .get(b.chain, address) as WhaleRow | undefined;
    return reply.code(201).send({ ok: true, whale: row ? rowToWhale(row) : null });
  });

  // PATCH /api/whales/:id
  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const parsed = patchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad body', issues: parsed.error.issues });
    }
    const existing = db
      .prepare('SELECT * FROM whale_addresses WHERE id = ?')
      .get(id) as WhaleRow | undefined;
    if (!existing) return reply.code(404).send({ error: 'not found' });

    const next = {
      label:
        parsed.data.label === undefined
          ? existing.label
          : parsed.data.label === null
            ? null
            : parsed.data.label,
      tags_json:
        parsed.data.tags === undefined
          ? existing.tags_json
          : parsed.data.tags === null
            ? null
            : JSON.stringify(parsed.data.tags),
      enabled:
        parsed.data.enabled === undefined
          ? existing.enabled
          : parsed.data.enabled
            ? 1
            : 0,
    };

    db.prepare(
      `UPDATE whale_addresses SET label = ?, tags_json = ?, enabled = ? WHERE id = ?`,
    ).run(next.label, next.tags_json, next.enabled, id);

    const updated = db
      .prepare('SELECT * FROM whale_addresses WHERE id = ?')
      .get(id) as WhaleRow;
    return { ok: true, whale: rowToWhale(updated) };
  });

  // DELETE /api/whales/:id
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const info = db.prepare('DELETE FROM whale_addresses WHERE id = ?').run(id);
    return { ok: true, removed: info.changes };
  });

  // GET /api/whales/ignore
  app.get('/ignore', async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const { chain } = parsed.data;
    const rows = chain
      ? (db
          .prepare('SELECT * FROM ignore_addresses WHERE chain = ? ORDER BY address')
          .all(chain) as IgnoreRow[])
      : (db
          .prepare('SELECT * FROM ignore_addresses ORDER BY chain, address')
          .all() as IgnoreRow[]);
    return { ignore: rows };
  });

  // POST /api/whales/ignore
  app.post('/ignore', async (req, reply) => {
    const parsed = ignorePostBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad body', issues: parsed.error.issues });
    }
    const b = parsed.data;
    const address = normaliseAddress(b.chain, b.address);
    db.prepare(
      `INSERT INTO ignore_addresses (chain, address, label)
       VALUES (?, ?, ?)
       ON CONFLICT(chain, address) DO UPDATE SET label = excluded.label`,
    ).run(b.chain, address, b.label ?? null);
    return reply.code(201).send({ ok: true, chain: b.chain, address });
  });

  // DELETE /api/whales/ignore/:chain/:address
  app.delete<{ Params: { chain: string; address: string } }>(
    '/ignore/:chain/:address',
    async (req, reply) => {
      const c = chainSchema.safeParse(req.params.chain);
      if (!c.success) return reply.code(400).send({ error: 'invalid chain' });
      const addr = normaliseAddress(c.data, String(req.params.address));
      const info = db
        .prepare('DELETE FROM ignore_addresses WHERE chain = ? AND address = ?')
        .run(c.data, addr);
      return { ok: true, removed: info.changes };
    },
  );

  // GET /api/whales/events — recent whale_tx events
  app.get('/events', async (req, reply) => {
    const parsed = eventsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const limit = parsed.data.limit ?? 100;
    const before = parsed.data.before ?? nowSec();
    const chain = parsed.data.chain;

    const rows = db
      .prepare(
        `SELECT id, kind, source, ts, asset_id, severity, payload_json
           FROM events
          WHERE kind = 'whale_tx' AND ts <= ?
          ORDER BY ts DESC
          LIMIT ?`,
      )
      .all(before, limit * (chain ? 4 : 1)) as EventRow[];

    const events = rows.map(rowToEvent);
    const filtered = chain
      ? events.filter((e) => (e as { chain?: string }).chain === chain)
      : events;
    return { events: filtered.slice(0, limit) };
  });
}
