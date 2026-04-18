import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { nowSec } from '../util/time.js';
import { logger } from '../util/logger.js';

const SIDES = ['buy', 'sell'] as const;
const TYPES = ['market', 'limit', 'stop'] as const;
const STATUSES = [
  'pending',
  'submitted',
  'partial',
  'filled',
  'cancelled',
  'rejected',
  'expired',
] as const;

const placeSchema = z
  .object({
    assetId: z.coerce.number().int().positive(),
    side: z.enum(SIDES),
    type: z.enum(TYPES),
    qty: z.coerce.number().positive(),
    limitPrice: z.coerce.number().positive().optional(),
    stopPrice: z.coerce.number().positive().optional(),
    confirmed: z.boolean(),
  })
  .refine((o) => o.type !== 'limit' || o.limitPrice !== undefined, {
    message: 'limitPrice required for limit orders',
    path: ['limitPrice'],
  })
  .refine((o) => o.type !== 'stop' || o.stopPrice !== undefined, {
    message: 'stopPrice required for stop orders',
    path: ['stopPrice'],
  });

const listQuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

interface AssetRow {
  id: number;
  symbol: string;
  type: string;
  exchange: string | null;
  tradeable_via: string | null;
  tradeable_symbol: string | null;
}

interface OrderRow {
  id: number;
  client_order_id: string;
  broker: string;
  asset_id: number;
  side: string;
  type: string;
  qty: number;
  limit_price: number | null;
  stop_price: number | null;
  status: string;
  avg_fill_price: number | null;
  filled_qty: number;
  submitted_at: number | null;
  completed_at: number | null;
  created_at: number;
  broker_order_id: string | null;
  error: string | null;
}

interface PositionRow {
  id: number;
  broker: string;
  asset_id: number;
  qty: number;
  avg_entry_price: number;
  realized_pnl: number;
  updated_at: number;
}

function rowToOrder(r: OrderRow): Record<string, unknown> {
  return {
    id: r.id,
    clientOrderId: r.client_order_id,
    broker: r.broker,
    assetId: r.asset_id,
    side: r.side,
    type: r.type,
    qty: r.qty,
    limitPrice: r.limit_price,
    stopPrice: r.stop_price,
    status: r.status,
    avgFillPrice: r.avg_fill_price,
    filledQty: r.filled_qty,
    submittedAt: r.submitted_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    brokerOrderId: r.broker_order_id,
    error: r.error,
  };
}

function lookupAsset(assetId: number): AssetRow | undefined {
  return db
    .prepare(
      `SELECT id, symbol, type, exchange, tradeable_via, tradeable_symbol
         FROM assets WHERE id = ?`,
    )
    .get(assetId) as AssetRow | undefined;
}

/**
 * Resolve the asset we'll actually trade.
 * If the target is display-only but has a `tradeable_symbol`, find that
 * symbol in assets and return that row. Returns null if not tradeable.
 */
function resolveTradeableAsset(asset: AssetRow): AssetRow | null {
  if (asset.tradeable_via) return asset;
  if (asset.tradeable_symbol) {
    const proxy = db
      .prepare(
        `SELECT id, symbol, type, exchange, tradeable_via, tradeable_symbol
           FROM assets WHERE symbol = ? LIMIT 1`,
      )
      .get(asset.tradeable_symbol) as AssetRow | undefined;
    if (proxy && proxy.tradeable_via) return proxy;
  }
  return null;
}

function latestClose(assetId: number): number | null {
  const row = db
    .prepare(
      `SELECT c FROM candles_1m WHERE asset_id = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(assetId) as { c: number } | undefined;
  return row ? row.c : null;
}

/**
 * Update the `positions` row after a buy or sell fill.
 * Weighted avg for adds, realized PnL for reductions.
 */
function applyFillToPosition(params: {
  broker: string;
  assetId: number;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  ts: number;
}): void {
  const { broker, assetId, side, qty, price, ts } = params;
  const existing = db
    .prepare(
      `SELECT id, broker, asset_id, qty, avg_entry_price, realized_pnl, updated_at
         FROM positions WHERE broker = ? AND asset_id = ?`,
    )
    .get(broker, assetId) as PositionRow | undefined;

  const signed = side === 'buy' ? qty : -qty;

  if (!existing) {
    // First time touching this asset. Sells without a position open a short
    // (negative qty); buys open a long (positive qty).
    db.prepare(
      `INSERT INTO positions (broker, asset_id, qty, avg_entry_price, realized_pnl, updated_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    ).run(broker, assetId, signed, price, ts);
    return;
  }

  const prevQty = existing.qty;
  const prevAvg = existing.avg_entry_price;
  const newRawQty = prevQty + signed;
  let realizedDelta = 0;
  let newAvg = prevAvg;
  let newQty = newRawQty;

  const sameDirection = (prevQty >= 0 && signed > 0) || (prevQty <= 0 && signed < 0);

  if (prevQty === 0) {
    // Opening a fresh leg.
    newAvg = price;
  } else if (sameDirection) {
    // Scaling in — weighted average.
    const absPrev = Math.abs(prevQty);
    const absAdd = Math.abs(signed);
    newAvg = (prevAvg * absPrev + price * absAdd) / (absPrev + absAdd);
  } else {
    // Reducing / closing / flipping.
    const closingQty = Math.min(Math.abs(prevQty), Math.abs(signed));
    // Long: realized = (sell price - avg) * qty
    // Short: realized = (avg - buy price) * qty
    if (prevQty > 0) {
      realizedDelta = (price - prevAvg) * closingQty;
    } else {
      realizedDelta = (prevAvg - price) * closingQty;
    }
    if (Math.abs(signed) > Math.abs(prevQty)) {
      // Flipped past zero: remaining portion opens new leg at fill price.
      newAvg = price;
    } else {
      newAvg = prevAvg;
    }
  }

  if (Math.abs(newQty) < 1e-12) {
    newQty = 0;
    newAvg = 0;
  }

  db.prepare(
    `UPDATE positions
        SET qty = ?, avg_entry_price = ?, realized_pnl = realized_pnl + ?, updated_at = ?
      WHERE id = ?`,
  ).run(newQty, newAvg, realizedDelta, ts, existing.id);
}

export async function registerOrdersRoutes(app: FastifyInstance): Promise<void> {
  app.post('/', async (req, reply) => {
    const parsed = placeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad body', issues: parsed.error.issues });
    }
    const b = parsed.data;
    if (!b.confirmed) {
      return reply.code(400).send({ error: 'order not confirmed' });
    }

    const asset = lookupAsset(b.assetId);
    if (!asset) return reply.code(404).send({ error: 'asset not found' });

    const tradeable = resolveTradeableAsset(asset);
    if (!tradeable) {
      return reply.code(400).send({ error: 'display-only asset' });
    }

    const ts = nowSec();
    const clientOrderId = `${b.assetId}-${ts}-${randomBytes(3).toString('hex')}`;

    if (b.type === 'market') {
      const close = latestClose(tradeable.id);
      if (close === null) {
        return reply
          .code(400)
          .send({ error: 'no price available for asset (no 1m candles yet)' });
      }
      const info = db
        .prepare(
          `INSERT INTO orders
             (client_order_id, broker, asset_id, side, type, qty,
              limit_price, stop_price, status, avg_fill_price, filled_qty,
              submitted_at, completed_at, created_at)
           VALUES (?, 'paper', ?, ?, ?, ?, ?, ?, 'filled', ?, ?, ?, ?, ?)`,
        )
        .run(
          clientOrderId,
          tradeable.id,
          b.side,
          b.type,
          b.qty,
          b.limitPrice ?? null,
          b.stopPrice ?? null,
          close,
          b.qty,
          ts,
          ts,
          ts,
        );
      applyFillToPosition({
        broker: 'paper',
        assetId: tradeable.id,
        side: b.side,
        qty: b.qty,
        price: close,
        ts,
      });
      const row = db
        .prepare(`SELECT * FROM orders WHERE id = ?`)
        .get(Number(info.lastInsertRowid)) as OrderRow;
      logger.info(
        { clientOrderId, side: b.side, qty: b.qty, price: close, assetId: tradeable.id },
        'paper market order filled',
      );
      return reply.code(201).send({ ok: true, order: rowToOrder(row) });
    }

    // limit / stop — queued, fills handled by Phase 9 scanner.
    const info = db
      .prepare(
        `INSERT INTO orders
           (client_order_id, broker, asset_id, side, type, qty,
            limit_price, stop_price, status, filled_qty, created_at)
         VALUES (?, 'paper', ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .run(
        clientOrderId,
        tradeable.id,
        b.side,
        b.type,
        b.qty,
        b.limitPrice ?? null,
        b.stopPrice ?? null,
        ts,
      );
    const row = db
      .prepare(`SELECT * FROM orders WHERE id = ?`)
      .get(Number(info.lastInsertRowid)) as OrderRow;
    logger.info(
      { clientOrderId, side: b.side, qty: b.qty, type: b.type, assetId: tradeable.id },
      'paper order queued',
    );
    return reply.code(201).send({ ok: true, order: rowToOrder(row) });
  });

  app.get('/', async (req, reply) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'bad query', issues: parsed.error.issues });
    }
    const limit = parsed.data.limit ?? 100;
    const rows = parsed.data.status
      ? (db
          .prepare(
            `SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
          )
          .all(parsed.data.status, limit) as OrderRow[])
      : (db
          .prepare(`SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`)
          .all(limit) as OrderRow[]);
    return { orders: rows.map(rowToOrder) };
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'invalid id' });
    }
    const row = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as
      | OrderRow
      | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (row.status !== 'pending') {
      return reply.code(409).send({ error: `cannot cancel order in status ${row.status}` });
    }
    const ts = nowSec();
    db.prepare(
      `UPDATE orders SET status = 'cancelled', completed_at = ? WHERE id = ?`,
    ).run(ts, id);
    const updated = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as OrderRow;
    return { ok: true, order: rowToOrder(updated) };
  });
}
