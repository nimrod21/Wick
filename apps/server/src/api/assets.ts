import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { nowSec } from '../util/time.js';

const ASSET_TYPES = ['crypto', 'stock', 'etf', 'forex', 'commodity', 'index'] as const;
const TRADEABLE_VIA = ['ccxt', 'alpaca'] as const;

const typeSchema = z.enum(ASSET_TYPES);

const listQuerySchema = z.object({
  type: typeSchema.optional(),
});

const postBodySchema = z.object({
  symbol: z.string().min(1),
  display_name: z.string().min(1),
  type: typeSchema,
  exchange: z.string().min(1).nullable().optional(),
  tradeable_via: z.enum(TRADEABLE_VIA).nullable().optional(),
  tradeable_symbol: z.string().min(1).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
  enabled: z.boolean().optional(),
});

const patchBodySchema = z
  .object({
    display_name: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
    metadata: z.record(z.unknown()).nullable().optional(),
    tradeable_via: z.enum(TRADEABLE_VIA).nullable().optional(),
    tradeable_symbol: z.string().min(1).nullable().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'at least one field required',
  });

interface AssetRow {
  id: number;
  symbol: string;
  display_name: string;
  type: (typeof ASSET_TYPES)[number];
  exchange: string | null;
  tradeable_via: string | null;
  tradeable_symbol: string | null;
  metadata_json: string | null;
  enabled: number;
  created_at: number;
}

function rowToAsset(r: AssetRow): Record<string, unknown> {
  return {
    id: r.id,
    symbol: r.symbol,
    displayName: r.display_name,
    type: r.type,
    exchange: r.exchange,
    tradeableVia: r.tradeable_via,
    tradeableSymbol: r.tradeable_symbol,
    metadata: r.metadata_json ? JSON.parse(r.metadata_json) : null,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
  };
}

export async function registerAssetsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const { type } = parsed.data;
    const rows = type
      ? (db
          .prepare('SELECT * FROM assets WHERE type = ? ORDER BY symbol')
          .all(type) as AssetRow[])
      : (db.prepare('SELECT * FROM assets ORDER BY type, symbol').all() as AssetRow[]);
    return { assets: rows.map(rowToAsset) };
  });

  app.post('/', async (req, reply) => {
    const parsed = postBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad body', issues: parsed.error.issues });
    }
    const b = parsed.data;
    const info = db
      .prepare(
        `INSERT INTO assets
           (symbol, display_name, type, exchange, tradeable_via, tradeable_symbol,
            metadata_json, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol, exchange) DO UPDATE SET
           display_name     = excluded.display_name,
           type             = excluded.type,
           tradeable_via    = excluded.tradeable_via,
           tradeable_symbol = excluded.tradeable_symbol,
           metadata_json    = excluded.metadata_json,
           enabled          = excluded.enabled`,
      )
      .run(
        b.symbol,
        b.display_name,
        b.type,
        b.exchange ?? null,
        b.tradeable_via ?? null,
        b.tradeable_symbol ?? null,
        b.metadata ? JSON.stringify(b.metadata) : null,
        b.enabled === false ? 0 : 1,
        nowSec(),
      );
    const row = db
      .prepare('SELECT * FROM assets WHERE symbol = ? AND IFNULL(exchange,"") = IFNULL(?,"")')
      .get(b.symbol, b.exchange ?? null) as AssetRow | undefined;
    return reply.code(201).send({ ok: true, id: info.lastInsertRowid, asset: row ? rowToAsset(row) : null });
  });

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const parsed = patchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad body', issues: parsed.error.issues });
    }
    const existing = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as
      | AssetRow
      | undefined;
    if (!existing) return reply.code(404).send({ error: 'not found' });

    const next = {
      display_name: parsed.data.display_name ?? existing.display_name,
      enabled:
        parsed.data.enabled === undefined
          ? existing.enabled
          : parsed.data.enabled
            ? 1
            : 0,
      metadata_json:
        parsed.data.metadata === undefined
          ? existing.metadata_json
          : parsed.data.metadata === null
            ? null
            : JSON.stringify(parsed.data.metadata),
      tradeable_via:
        parsed.data.tradeable_via === undefined
          ? existing.tradeable_via
          : parsed.data.tradeable_via,
      tradeable_symbol:
        parsed.data.tradeable_symbol === undefined
          ? existing.tradeable_symbol
          : parsed.data.tradeable_symbol,
    };

    db.prepare(
      `UPDATE assets
         SET display_name = ?, enabled = ?, metadata_json = ?,
             tradeable_via = ?, tradeable_symbol = ?
         WHERE id = ?`,
    ).run(
      next.display_name,
      next.enabled,
      next.metadata_json,
      next.tradeable_via,
      next.tradeable_symbol,
      id,
    );

    const updated = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow;
    return { ok: true, asset: rowToAsset(updated) };
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const info = db.prepare('DELETE FROM assets WHERE id = ?').run(id);
    return { ok: true, removed: info.changes };
  });
}
