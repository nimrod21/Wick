/**
 * Alpaca paper adapter — Phase 9.
 *
 * Alpaca has no "live stocks" mode in this cockpit; it's always paper,
 * pointed at `paper-api.alpaca.markets`. If the user has no `alpaca`
 * key stored, every method rejects with a clear error — callers should
 * refuse to route stock/etf orders here until the user adds one.
 *
 * WebSocket trade_updates are intentionally skipped in Phase 9. The
 * order-manager's 2s poll watcher reconciles `submitted` / `partial`
 * orders via `listOrders`, which is good enough for paper.
 */

import type {
  AccountBalance,
  Broker,
  Order,
  OrderSide,
  OrderStatus,
  OrderStatusEvent,
  OrderType,
  PlaceOrderRequest,
  Position,
} from '@cockpit/shared';
import { db } from '../db/client.js';
import { eventBus } from '../core/event-bus.js';
import { getApiKey } from '../config.js';
import { logger } from '../util/logger.js';
import { nowSec } from '../util/time.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AlpacaClient = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let alpacaModule: any = null;
let client: AlpacaClient | null = null;
let keyUsed: string | null = null;
let alpacaLoadFailed = false;

let eventSeq = 4_000_000;

async function loadAlpaca(): Promise<unknown> {
  if (alpacaModule) return alpacaModule;
  if (alpacaLoadFailed) throw new Error('alpaca package not installed');
  try {
    // Alpaca ships as CJS default export
    const mod = (await import('@alpacahq/alpaca-trade-api')) as {
      default?: unknown;
    } & Record<string, unknown>;
    alpacaModule = mod.default ?? mod;
  } catch (err) {
    alpacaLoadFailed = true;
    logger.warn({ err }, '@alpacahq/alpaca-trade-api not installed');
    throw new Error('alpaca package not installed');
  }
  return alpacaModule;
}

async function ensureClient(): Promise<AlpacaClient> {
  const creds = getApiKey('alpaca');
  if (!creds) throw new Error('alpaca key not configured');
  if (client && keyUsed === creds.key) return client;
  const Alpaca = (await loadAlpaca()) as new (opts: Record<string, unknown>) => AlpacaClient;
  client = new Alpaca({
    keyId: creds.key,
    secretKey: creds.secret ?? '',
    paper: true,
    baseUrl: 'https://paper-api.alpaca.markets',
  });
  keyUsed = creds.key;
  return client;
}

interface AlpacaOrder {
  id: string;
  client_order_id?: string;
  symbol: string;
  qty: string | number;
  side: 'buy' | 'sell';
  type: string;
  status: string;
  filled_qty?: string | number;
  filled_avg_price?: string | number | null;
  submitted_at?: string;
  filled_at?: string | null;
  canceled_at?: string | null;
  limit_price?: string | number | null;
  stop_price?: string | number | null;
}

function parseNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function alpacaTsToSec(iso?: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function mapStatus(status: string): OrderStatus {
  switch (status) {
    case 'new':
    case 'accepted':
    case 'pending_new':
      return 'submitted';
    case 'partially_filled':
      return 'partial';
    case 'filled':
      return 'filled';
    case 'canceled':
    case 'pending_cancel':
      return 'cancelled';
    case 'rejected':
      return 'rejected';
    case 'expired':
      return 'expired';
    default:
      return 'submitted';
  }
}

function resolveAssetIdBySymbol(symbol: string): number | null {
  const row = db
    .prepare(
      `SELECT id FROM assets WHERE symbol = ? AND tradeable_via = 'alpaca' LIMIT 1`,
    )
    .get(symbol) as { id: number } | undefined;
  return row?.id ?? null;
}

function upsertOrderRow(
  a: AlpacaOrder,
  localClientOrderId: string,
  localAssetId: number,
  localType: OrderType,
): number {
  const status = mapStatus(a.status);
  const qty = parseNum(a.qty);
  const filledQty = parseNum(a.filled_qty);
  const avgFill = a.filled_avg_price != null ? parseNum(a.filled_avg_price) : null;
  const submittedAt = alpacaTsToSec(a.submitted_at);
  const completedAt = alpacaTsToSec(a.filled_at ?? a.canceled_at ?? null);
  const limitPrice = a.limit_price != null ? parseNum(a.limit_price) : null;
  const stopPrice = a.stop_price != null ? parseNum(a.stop_price) : null;
  const side = a.side;

  const existing = db
    .prepare(`SELECT id FROM orders WHERE client_order_id = ?`)
    .get(localClientOrderId) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE orders
          SET status = ?, avg_fill_price = ?, filled_qty = ?,
              submitted_at = COALESCE(?, submitted_at),
              completed_at = COALESCE(?, completed_at),
              broker_order_id = ?
        WHERE id = ?`,
    ).run(status, avgFill, filledQty, submittedAt, completedAt, a.id, existing.id);
    return existing.id;
  }

  const createdAt = submittedAt ?? nowSec();
  const info = db
    .prepare(
      `INSERT INTO orders
         (client_order_id, broker, asset_id, side, type, qty,
          limit_price, stop_price, status, avg_fill_price, filled_qty,
          submitted_at, completed_at, created_at, broker_order_id)
       VALUES (?, 'alpaca', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      localClientOrderId,
      localAssetId,
      side,
      localType,
      qty,
      limitPrice,
      stopPrice,
      status,
      avgFill,
      filledQty,
      submittedAt,
      completedAt,
      createdAt,
      a.id,
    );
  return Number(info.lastInsertRowid);
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

function rowToOrder(r: OrderRow): Order {
  return {
    id: r.id,
    clientOrderId: r.client_order_id,
    broker: r.broker as Order['broker'],
    assetId: r.asset_id,
    side: r.side as OrderSide,
    type: r.type as OrderType,
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

function emitStatusForRow(row: OrderRow): void {
  const ev: OrderStatusEvent = {
    id: eventSeq++,
    ts: nowSec(),
    source: 'alpaca-broker',
    kind: 'order_status',
    orderId: row.id,
    clientOrderId: row.client_order_id,
    assetId: row.asset_id,
    status: row.status as OrderStatus,
    filledQty: row.filled_qty,
    avgFillPrice: row.avg_fill_price,
  };
  eventBus.emit(ev);
}

class StocksAlpacaBroker implements Broker {
  async placeOrder(req: PlaceOrderRequest): Promise<Order> {
    const creds = getApiKey('alpaca');
    if (!creds) throw new Error('alpaca key not configured');
    const c = await ensureClient();

    const asset = db
      .prepare(
        `SELECT id, symbol FROM assets WHERE id = ? AND tradeable_via = 'alpaca'`,
      )
      .get(req.assetId) as { id: number; symbol: string } | undefined;
    if (!asset) throw new Error('asset not tradeable via alpaca');

    const ts = nowSec();
    const localClientOrderId = `${req.assetId}-${ts}-alp-${Math.floor(
      Math.random() * 0xffff,
    )
      .toString(16)
      .padStart(4, '0')}`;

    const payload: Record<string, unknown> = {
      symbol: asset.symbol,
      qty: req.qty,
      side: req.side,
      type: req.type,
      time_in_force: 'day',
      client_order_id: localClientOrderId,
    };
    if (req.type === 'limit' && req.limitPrice != null) payload.limit_price = req.limitPrice;
    if (req.type === 'stop' && req.stopPrice != null) payload.stop_price = req.stopPrice;

    let resp: AlpacaOrder;
    try {
      resp = (await c.createOrder(payload)) as AlpacaOrder;
    } catch (err) {
      logger.error({ err, payload }, 'alpaca createOrder failed');
      throw err instanceof Error ? err : new Error(String(err));
    }

    const id = upsertOrderRow(resp, localClientOrderId, asset.id, req.type);
    const row = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as OrderRow;
    emitStatusForRow(row);
    logger.info(
      { clientOrderId: localClientOrderId, brokerOrderId: resp.id, status: row.status },
      'alpaca order placed',
    );
    return rowToOrder(row);
  }

  async cancelOrder(clientOrderId: string): Promise<void> {
    const creds = getApiKey('alpaca');
    if (!creds) throw new Error('alpaca key not configured');
    const c = await ensureClient();
    const row = db
      .prepare(`SELECT * FROM orders WHERE client_order_id = ? AND broker = 'alpaca'`)
      .get(clientOrderId) as OrderRow | undefined;
    if (!row) throw new Error('order not found');
    if (!row.broker_order_id) throw new Error('no broker_order_id for cancel');
    await c.cancelOrder(row.broker_order_id);
    const ts = nowSec();
    db.prepare(
      `UPDATE orders SET status = 'cancelled', completed_at = ? WHERE id = ?`,
    ).run(ts, row.id);
    const updated = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(row.id) as OrderRow;
    emitStatusForRow(updated);
  }

  async getOrder(clientOrderId: string): Promise<Order> {
    const creds = getApiKey('alpaca');
    if (!creds) throw new Error('alpaca key not configured');
    const c = await ensureClient();
    const row = db
      .prepare(`SELECT * FROM orders WHERE client_order_id = ? AND broker = 'alpaca'`)
      .get(clientOrderId) as OrderRow | undefined;
    if (!row) throw new Error('order not found');
    if (!row.broker_order_id) return rowToOrder(row);
    try {
      const resp = (await c.getOrder(row.broker_order_id)) as AlpacaOrder;
      upsertOrderRow(resp, row.client_order_id, row.asset_id, row.type as OrderType);
      const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id) as OrderRow;
      if (updated.status !== row.status) emitStatusForRow(updated);
      return rowToOrder(updated);
    } catch (err) {
      logger.warn({ err, clientOrderId }, 'alpaca getOrder failed; returning local row');
      return rowToOrder(row);
    }
  }

  async listOpenOrders(): Promise<Order[]> {
    const creds = getApiKey('alpaca');
    if (!creds) throw new Error('alpaca key not configured');
    const c = await ensureClient();
    const list = (await c.getOrders({ status: 'open' })) as AlpacaOrder[];
    const results: Order[] = [];
    for (const a of list) {
      const localCid =
        a.client_order_id && a.client_order_id.length > 0 ? a.client_order_id : a.id;
      const assetId = resolveAssetIdBySymbol(a.symbol);
      if (assetId === null) continue;
      const type = (a.type as OrderType) ?? 'market';
      const id = upsertOrderRow(a, localCid, assetId, type);
      const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow;
      results.push(rowToOrder(row));
    }
    return results;
  }

  async getPositions(): Promise<Position[]> {
    const creds = getApiKey('alpaca');
    if (!creds) throw new Error('alpaca key not configured');
    const c = await ensureClient();
    const list = (await c.getPositions()) as Array<{
      symbol: string;
      qty: string | number;
      avg_entry_price: string | number;
    }>;
    const results: Position[] = [];
    const ts = nowSec();
    for (const p of list) {
      const assetId = resolveAssetIdBySymbol(p.symbol);
      if (assetId === null) continue;
      results.push({
        id: 0,
        broker: 'alpaca',
        assetId,
        qty: parseNum(p.qty),
        avgEntryPrice: parseNum(p.avg_entry_price),
        realizedPnl: 0,
        updatedAt: ts,
      });
    }
    return results;
  }

  async getAccountBalance(): Promise<AccountBalance> {
    const creds = getApiKey('alpaca');
    if (!creds) throw new Error('alpaca key not configured');
    const c = await ensureClient();
    const acct = (await c.getAccount()) as {
      cash?: string | number;
      equity?: string | number;
      buying_power?: string | number;
    };
    return {
      broker: 'alpaca',
      cash: parseNum(acct.cash),
      equity: parseNum(acct.equity),
      buyingPower: parseNum(acct.buying_power),
      currency: 'USD',
    };
  }
}

export const stocksAlpacaBroker = new StocksAlpacaBroker();
