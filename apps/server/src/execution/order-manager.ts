/**
 * Order manager — Phase 9.
 *
 * The single entry point for all order flow. It:
 *   1. Validates the request with Zod.
 *   2. Resolves the tradeable asset (following `tradeable_symbol` proxies
 *      like XAU/USD -> GLD so display-only rows can still route to a
 *      real broker).
 *   3. Runs the risk guards centrally — every broker inherits the same
 *      policy.
 *   4. Dispatches to the correct broker (ccxt for crypto, alpaca for
 *      stocks/etfs; paper is routed through ccxt in paper-shim mode).
 *   5. Emits `order_status` events on the bus so the UI + future bots
 *      get a consistent stream.
 *
 * The background watcher polls every 2s for non-paper orders still in
 * `submitted`/`partial` and reconciles their status by calling back into
 * the broker. Paper orders are swept by `paper-mode.ts` on its own cron.
 */

import { z } from 'zod';
import type {
  Broker,
  Order,
  OrderStatus,
  PlaceOrderRequest,
  Position,
} from '@cockpit/shared';
import { db } from '../db/client.js';
import { logger } from '../util/logger.js';
import { guard } from './risk-guards.js';
import { paperBroker } from './paper-mode.js';
import { cryptoCcxtBroker } from './crypto-ccxt.js';
import { stocksAlpacaBroker } from './stocks-alpaca.js';

const SIDES = ['buy', 'sell'] as const;
const TYPES = ['market', 'limit', 'stop'] as const;

const placeOrderSchema = z
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

export class GuardFailedError extends Error {
  readonly reason: string;
  readonly detail?: Record<string, unknown>;
  constructor(reason: string, detail?: Record<string, unknown>) {
    super(reason);
    this.name = 'GuardFailedError';
    this.reason = reason;
    this.detail = detail;
  }
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
 * Find the asset we'll actually trade. If `tradeable_via` is set, that
 * row is already a real market; otherwise follow `tradeable_symbol` to
 * a proxy (XAU/USD -> GLD). Returns null if nothing tradeable exists.
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

function brokerFor(asset: AssetRow): Broker | null {
  if (asset.tradeable_via === 'ccxt') return cryptoCcxtBroker;
  if (asset.tradeable_via === 'alpaca') return stocksAlpacaBroker;
  return null;
}

function brokerNameFor(asset: AssetRow): string {
  return asset.tradeable_via ?? 'paper';
}

function rowToOrder(r: OrderRow): Order {
  return {
    id: r.id,
    clientOrderId: r.client_order_id,
    broker: r.broker as Order['broker'],
    assetId: r.asset_id,
    side: r.side as Order['side'],
    type: r.type as Order['type'],
    qty: r.qty,
    limitPrice: r.limit_price,
    stopPrice: r.stop_price,
    status: r.status as OrderStatus,
    avgFillPrice: r.avg_fill_price,
    filledQty: r.filled_qty,
    submittedAt: r.submitted_at,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    brokerOrderId: r.broker_order_id,
    error: r.error,
  };
}

function rowToPosition(r: PositionRow): Position {
  return {
    id: r.id,
    broker: r.broker as Position['broker'],
    assetId: r.asset_id,
    qty: r.qty,
    avgEntryPrice: r.avg_entry_price,
    realizedPnl: r.realized_pnl,
    updatedAt: r.updated_at,
  };
}

class OrderManager {
  private watcher: NodeJS.Timeout | null = null;

  async placeOrder(raw: unknown): Promise<Order> {
    const parsed = placeOrderSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GuardFailedError('bad_request', { issues: parsed.error.issues });
    }
    const req = parsed.data as PlaceOrderRequest;

    const asset = lookupAsset(req.assetId);
    if (!asset) throw new GuardFailedError('asset_not_found', { assetId: req.assetId });

    const tradeable = resolveTradeableAsset(asset);
    if (!tradeable) throw new GuardFailedError('display_only_asset');

    // Build the request we'll hand to the broker — swap asset id to the
    // tradeable proxy so the broker deals with the real market.
    const effectiveReq: PlaceOrderRequest = { ...req, assetId: tradeable.id };

    const verdict = await guard(effectiveReq);
    if (!verdict.ok) throw new GuardFailedError(verdict.reason, verdict.detail);

    const broker = brokerFor(tradeable);
    if (!broker) throw new GuardFailedError('display_only_asset');

    const order = await broker.placeOrder(effectiveReq);
    logger.info(
      {
        clientOrderId: order.clientOrderId,
        broker: brokerNameFor(tradeable),
        assetId: tradeable.id,
        side: order.side,
        qty: order.qty,
        status: order.status,
      },
      'order-manager placeOrder dispatched',
    );
    return order;
  }

  async cancelOrder(clientOrderId: string, brokerHint?: string): Promise<void> {
    const row = db
      .prepare(`SELECT broker FROM orders WHERE client_order_id = ?`)
      .get(clientOrderId) as { broker: string } | undefined;
    const brokerName = brokerHint ?? row?.broker;
    if (!brokerName) throw new Error('cannot determine broker for cancel');
    const broker = this.brokerByName(brokerName);
    if (!broker) throw new Error(`unknown broker: ${brokerName}`);
    await broker.cancelOrder(clientOrderId);
  }

  async getOrder(clientOrderId: string): Promise<Order> {
    const row = db
      .prepare(`SELECT * FROM orders WHERE client_order_id = ?`)
      .get(clientOrderId) as OrderRow | undefined;
    if (!row) throw new Error('order not found');
    // Local row is authoritative for paper; for live brokers we prefer a
    // fresh read because the status may have transitioned between watcher
    // ticks.
    if (row.broker === 'paper') return rowToOrder(row);
    const broker = this.brokerByName(row.broker);
    if (!broker) return rowToOrder(row);
    try {
      return await broker.getOrder(clientOrderId);
    } catch {
      return rowToOrder(row);
    }
  }

  async listOpenOrders(): Promise<Order[]> {
    const rows = db
      .prepare(
        `SELECT * FROM orders WHERE status IN ('pending','submitted','partial')
           ORDER BY created_at DESC`,
      )
      .all() as OrderRow[];
    return rows.map(rowToOrder);
  }

  async getPositions(): Promise<Position[]> {
    const rows = db
      .prepare(
        `SELECT id, broker, asset_id, qty, avg_entry_price, realized_pnl, updated_at
           FROM positions ORDER BY updated_at DESC`,
      )
      .all() as PositionRow[];
    return rows.map(rowToPosition);
  }

  /**
   * Background watcher — every 2s reconcile live orders that are still
   * open with their broker of record. Paper orders are skipped; they're
   * swept by the fill-scan cron.
   */
  start(): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      this.tickWatcher().catch((err) => {
        logger.error({ err }, 'order-manager watcher tick failed');
      });
    }, 2000);
    logger.info('order-manager watcher started (every 2s)');
  }

  stop(): void {
    if (this.watcher) {
      clearInterval(this.watcher);
      this.watcher = null;
    }
  }

  private async tickWatcher(): Promise<void> {
    const rows = db
      .prepare(
        `SELECT * FROM orders
           WHERE broker IN ('ccxt','alpaca')
             AND status IN ('submitted','partial')
           ORDER BY created_at DESC
           LIMIT 100`,
      )
      .all() as OrderRow[];
    for (const row of rows) {
      const broker = this.brokerByName(row.broker);
      if (!broker) continue;
      try {
        await broker.getOrder(row.client_order_id);
      } catch (err) {
        logger.debug({ err, clientOrderId: row.client_order_id }, 'watcher getOrder failed');
      }
    }
  }

  private brokerByName(name: string): Broker | null {
    if (name === 'paper') return paperBroker;
    if (name === 'ccxt') return cryptoCcxtBroker;
    if (name === 'alpaca') return stocksAlpacaBroker;
    return null;
  }
}

export const orderManager = new OrderManager();
