import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { nowMs } from '../util/time.js';

const postBodySchema = z.object({
  symbol: z.string().min(1),
  display_name: z.string().min(1),
  active: z.boolean().optional(),
});

const patchBodySchema = z
  .object({
    display_name: z.string().min(1).optional(),
    active: z.boolean().optional(),
  })
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'at least one field required',
  });

interface AssetRow {
  symbol: string;
  display_name: string;
  active: number;
  added_ts: number;
}

function rowToAsset(r: AssetRow): Record<string, unknown> {
  return {
    symbol: r.symbol,
    displayName: r.display_name,
    active: r.active === 1,
    addedTs: r.added_ts,
  };
}

export async function registerAssetsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async () => {
    const rows = db
      .prepare('SELECT * FROM assets ORDER BY symbol')
      .all() as AssetRow[];
    return { assets: rows.map(rowToAsset) };
  });

  app.post('/', async (req, reply) => {
    const parsed = postBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad body', issues: parsed.error.issues });
    }
    const b = parsed.data;
    db.prepare(
      `INSERT INTO assets (symbol, display_name, active, added_ts)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET
         display_name = excluded.display_name,
         active       = excluded.active`,
    ).run(b.symbol.toUpperCase(), b.display_name, b.active === false ? 0 : 1, nowMs());
    const row = db
      .prepare('SELECT * FROM assets WHERE symbol = ?')
      .get(b.symbol.toUpperCase()) as AssetRow;
    return reply.code(201).send({ ok: true, asset: rowToAsset(row) });
  });

  app.patch<{ Params: { symbol: string } }>('/:symbol', async (req, reply) => {
    const symbol = req.params.symbol.toUpperCase();
    const parsed = patchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad body', issues: parsed.error.issues });
    }
    const existing = db.prepare('SELECT * FROM assets WHERE symbol = ?').get(symbol) as
      | AssetRow
      | undefined;
    if (!existing) return reply.code(404).send({ error: 'not found' });

    db.prepare(
      'UPDATE assets SET display_name = ?, active = ? WHERE symbol = ?',
    ).run(
      parsed.data.display_name ?? existing.display_name,
      parsed.data.active === undefined
        ? existing.active
        : parsed.data.active
          ? 1
          : 0,
      symbol,
    );

    const updated = db.prepare('SELECT * FROM assets WHERE symbol = ?').get(symbol) as AssetRow;
    return { ok: true, asset: rowToAsset(updated) };
  });

  app.delete<{ Params: { symbol: string } }>('/:symbol', async (req) => {
    const info = db
      .prepare('DELETE FROM assets WHERE symbol = ?')
      .run(req.params.symbol.toUpperCase());
    return { ok: true, removed: info.changes };
  });
}
