import type { FastifyInstance } from 'fastify';
import { db } from '../db/client.js';

interface PositionRow {
  id: number;
  broker: string;
  asset_id: number;
  qty: number;
  avg_entry_price: number;
  realized_pnl: number;
  updated_at: number;
}

function rowToPosition(r: PositionRow): Record<string, unknown> {
  return {
    id: r.id,
    broker: r.broker,
    assetId: r.asset_id,
    qty: r.qty,
    avgEntryPrice: r.avg_entry_price,
    realizedPnl: r.realized_pnl,
    updatedAt: r.updated_at,
  };
}

export async function registerPositionsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async () => {
    const rows = db
      .prepare(
        `SELECT id, broker, asset_id, qty, avg_entry_price, realized_pnl, updated_at
           FROM positions
          ORDER BY updated_at DESC`,
      )
      .all() as PositionRow[];
    return { positions: rows.map(rowToPosition) };
  });
}
