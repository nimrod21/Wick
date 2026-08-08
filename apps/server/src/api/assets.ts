import type { FastifyInstance } from 'fastify';
import { request as undiciRequest } from 'undici';
import { z } from 'zod';
import { db } from '../db/client.js';
import { nowMs } from '../util/time.js';
import { logger } from '../util/logger.js';

/**
 * Binance exchangeInfo gate for the Phase-6 watchlist editor: a symbol only
 * enters the watchlist if Binance spot trades it. Cached 1h — the list is
 * ~2500 symbols and changes rarely. On a network failure the add is REJECTED
 * (better a retry than a symbol the collectors can never fill).
 */
let symbolCache: { ts: number; symbols: Set<string> } | null = null;
const SYMBOL_CACHE_TTL_MS = 60 * 60_000;

async function tradableSymbols(): Promise<Set<string> | null> {
  if (symbolCache && nowMs() - symbolCache.ts < SYMBOL_CACHE_TTL_MS) return symbolCache.symbols;
  try {
    const res = await undiciRequest('https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT', {
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
    });
    if (res.statusCode !== 200) return null;
    const body = (await res.body.json()) as { symbols?: Array<{ symbol?: string; status?: string }> };
    if (!Array.isArray(body.symbols)) return null;
    const set = new Set<string>();
    for (const s of body.symbols) {
      if (typeof s.symbol === 'string' && s.status === 'TRADING') set.add(s.symbol.toUpperCase());
    }
    if (set.size === 0) return null;
    symbolCache = { ts: nowMs(), symbols: set };
    return set;
  } catch (err) {
    logger.warn({ err }, 'exchangeInfo fetch failed');
    return null;
  }
}

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
    const symbol = b.symbol.toUpperCase();
    const known = await tradableSymbols();
    if (known === null) {
      return reply.code(503).send({ error: 'could not reach Binance exchangeInfo — try again' });
    }
    if (!known.has(symbol)) {
      return reply.code(400).send({ error: `${symbol} is not a tradable Binance spot symbol` });
    }
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
