/**
 * Orders HTTP API — Phase 9 cut-over.
 *
 * Previously (Phase 2) this file contained the full paper-fill logic.
 * It now delegates to `orderManager`, which runs risk guards and routes
 * to the correct broker (paper / ccxt / alpaca). Guard failures surface
 * as 400s carrying the structured reason + detail from `risk-guards.ts`,
 * so the UI can render "BLOCKED: notional $650 exceeds max $500"-style
 * messages without string matching.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client.js';
import { logger } from '../util/logger.js';
import { GuardFailedError, orderManager } from '../execution/order-manager.js';

const STATUSES = [
  'pending',
  'submitted',
  'partial',
  'filled',
  'cancelled',
  'rejected',
  'expired',
] as const;

const listQuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

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

export async function registerOrdersRoutes(app: FastifyInstance): Promise<void> {
  app.post('/', async (req, reply) => {
    try {
      const order = await orderManager.placeOrder(req.body);
      return reply.code(201).send({ ok: true, order });
    } catch (err) {
      if (err instanceof GuardFailedError) {
        return reply.code(400).send({ error: err.reason, detail: err.detail });
      }
      logger.error({ err }, 'placeOrder failed');
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: 'internal_error', detail: { message } });
    }
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
    if (row.status !== 'pending' && row.status !== 'submitted' && row.status !== 'partial') {
      return reply
        .code(409)
        .send({ error: `cannot cancel order in status ${row.status}` });
    }

    try {
      await orderManager.cancelOrder(row.client_order_id, row.broker);
      const updated = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as OrderRow;
      return { ok: true, order: rowToOrder(updated) };
    } catch (err) {
      logger.error({ err, id }, 'cancelOrder failed');
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: 'cancel_failed', detail: { message } });
    }
  });
}
