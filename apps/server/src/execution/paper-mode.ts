/**
 * Paper broker — Phase 9.
 *
 * Simulates fills against the freshest `candles_1m` row for each asset.
 * Market orders fill instantly at the latest close. Limit / stop orders
 * queue as 'pending' and are swept by `startFillScanCron` every 5s, which
 * checks the most recent 1m candle's high/low against the order's price
 * and fills when the candle crosses it.
 *
 * Accounting:
 *   - Fees: 0.1% taker for crypto, 0% for stocks/etfs (matches Binance / Alpaca).
 *   - Weighted-avg entry price when scaling in; realized PnL on closing fills.
 *   - Balances for each broker ('paper_balance_crypto' / 'paper_balance_stocks')
 *     live in `kv`; first access seeds $100k. Balances move as: cash -> qty
 *     on buys, qty -> cash on sells, with fees deducted from cash.
 */

import { randomBytes } from 'node:crypto';
import cron from 'node-cron';
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
import { logger } from '../util/logger.js';
import { nowSec } from '../util/time.js';

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

interface AssetTypeRow {
  id: number;
  type: string;
}

const STARTING_BALANCE = 100_000;
const CRYPTO_FEE_RATE = 0.001; // 0.1% taker
const STOCK_FEE_RATE = 0;

let eventSeq = 3_000_000; // synthetic ids for OrderStatusEvent

// ── KV / balance helpers ───────────────────────────────────────────────

function kvGet(key: string): string | null {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as
    | { v: string }
    | undefined;
  return row ? row.v : null;
}

function kvSet(key: string, value: string): void {
  const ts = nowSec();
  db.prepare(
    `INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
  ).run(key, value, ts);
}

function balanceKey(assetType: string): 'paper_balance_crypto' | 'paper_balance_stocks' {
  return assetType === 'crypto' ? 'paper_balance_crypto' : 'paper_balance_stocks';
}

function getPaperBalance(assetType: string): number {
  const key = balanceKey(assetType);
  const raw = kvGet(key);
  if (raw === null) {
    kvSet(key, String(STARTING_BALANCE));
    return STARTING_BALANCE;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : STARTING_BALANCE;
}

function setPaperBalance(assetType: string, value: number): void {
  kvSet(balanceKey(assetType), String(value));
}

function feeRateFor(assetType: string): number {
  return assetType === 'crypto' ? CRYPTO_FEE_RATE : STOCK_FEE_RATE;
}

// ── Row helpers ────────────────────────────────────────────────────────

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

function getAssetType(assetId: number): string {
  const row = db.prepare('SELECT id, type FROM assets WHERE id = ?').get(assetId) as
    | AssetTypeRow
    | undefined;
  return row ? row.type : 'crypto';
}

function latestClose(assetId: number): {
  c: number;
  h: number;
  l: number;
} | null {
  const row = db
    .prepare(
      `SELECT c, h, l FROM candles_1m WHERE asset_id = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(assetId) as { c: number; h: number; l: number } | undefined;
  return row ?? null;
}

// ── Position accounting ────────────────────────────────────────────────

/**
 * Apply a fill to the positions table. Same weighted-avg + realized-PnL
 * rules as the Phase 2 stub, but now lives next to the broker so all
 * execution paths share it. Returns the realized PnL delta produced by
 * this fill (0 when just scaling in).
 */
function applyFillToPosition(params: {
  broker: string;
  assetId: number;
  side: OrderSide;
  qty: number;
  price: number;
  ts: number;
}): number {
  const { broker, assetId, side, qty, price, ts } = params;
  const existing = db
    .prepare(
      `SELECT id, broker, asset_id, qty, avg_entry_price, realized_pnl, updated_at
         FROM positions WHERE broker = ? AND asset_id = ?`,
    )
    .get(broker, assetId) as PositionRow | undefined;

  const signed = side === 'buy' ? qty : -qty;

  if (!existing) {
    db.prepare(
      `INSERT INTO positions (broker, asset_id, qty, avg_entry_price, realized_pnl, updated_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    ).run(broker, assetId, signed, price, ts);
    return 0;
  }

  const prevQty = existing.qty;
  const prevAvg = existing.avg_entry_price;
  const newRawQty = prevQty + signed;
  let realizedDelta = 0;
  let newAvg = prevAvg;
  let newQty = newRawQty;

  const sameDirection =
    (prevQty >= 0 && signed > 0) || (prevQty <= 0 && signed < 0);

  if (prevQty === 0) {
    newAvg = price;
  } else if (sameDirection) {
    const absPrev = Math.abs(prevQty);
    const absAdd = Math.abs(signed);
    newAvg = (prevAvg * absPrev + price * absAdd) / (absPrev + absAdd);
  } else {
    const closingQty = Math.min(Math.abs(prevQty), Math.abs(signed));
    if (prevQty > 0) {
      realizedDelta = (price - prevAvg) * closingQty;
    } else {
      realizedDelta = (prevAvg - price) * closingQty;
    }
    if (Math.abs(signed) > Math.abs(prevQty)) {
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

  return realizedDelta;
}

/**
 * Move cash on a fill. Buys debit cash (notional + fee); sells credit
 * cash (notional - fee). Balance is per asset-type bucket ('crypto' vs
 * everything else). Returns the resulting balance.
 */
function applyFillToBalance(params: {
  assetType: string;
  side: OrderSide;
  qty: number;
  price: number;
}): number {
  const { assetType, side, qty, price } = params;
  const notional = qty * price;
  const fee = notional * feeRateFor(assetType);
  const current = getPaperBalance(assetType);
  const next = side === 'buy' ? current - notional - fee : current + notional - fee;
  setPaperBalance(assetType, next);
  return next;
}

function emitOrderStatusEvent(row: OrderRow): void {
  const ev: OrderStatusEvent = {
    id: eventSeq++,
    ts: nowSec(),
    source: 'paper-broker',
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

function generateClientOrderId(assetId: number): string {
  return `${assetId}-${nowSec()}-${randomBytes(3).toString('hex')}`;
}

// ── Fill routine (shared between placeOrder market-path and cron) ──────

/**
 * Mark an existing 'pending' row as filled and update positions + balance.
 * Used both by the market path in `placeOrder` (row fresh from INSERT) and
 * by the cron sweep for queued limit/stop orders.
 */
function fillPendingRow(
  row: OrderRow,
  fillPrice: number,
  ts: number,
): OrderRow {
  const assetType = getAssetType(row.asset_id);
  db.prepare(
    `UPDATE orders
        SET status = 'filled',
            avg_fill_price = ?,
            filled_qty = ?,
            submitted_at = COALESCE(submitted_at, ?),
            completed_at = ?
      WHERE id = ?`,
  ).run(fillPrice, row.qty, ts, ts, row.id);

  applyFillToPosition({
    broker: 'paper',
    assetId: row.asset_id,
    side: row.side as OrderSide,
    qty: row.qty,
    price: fillPrice,
    ts,
  });
  applyFillToBalance({
    assetType,
    side: row.side as OrderSide,
    qty: row.qty,
    price: fillPrice,
  });

  const updated = db
    .prepare('SELECT * FROM orders WHERE id = ?')
    .get(row.id) as OrderRow;
  emitOrderStatusEvent(updated);
  return updated;
}

// ── PaperBroker class ──────────────────────────────────────────────────

class PaperBroker implements Broker {
  async placeOrder(req: PlaceOrderRequest): Promise<Order> {
    const ts = nowSec();
    const clientOrderId = generateClientOrderId(req.assetId);

    // Market orders fill immediately at the freshest candle close.
    if (req.type === 'market') {
      const candle = latestClose(req.assetId);
      if (!candle) {
        throw new Error('no price available for asset (no 1m candles yet)');
      }
      const info = db
        .prepare(
          `INSERT INTO orders
             (client_order_id, broker, asset_id, side, type, qty,
              limit_price, stop_price, status, filled_qty, submitted_at, created_at)
           VALUES (?, 'paper', ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(
          clientOrderId,
          req.assetId,
          req.side,
          req.type,
          req.qty,
          req.limitPrice ?? null,
          req.stopPrice ?? null,
          ts,
          ts,
        );
      const row = db
        .prepare('SELECT * FROM orders WHERE id = ?')
        .get(Number(info.lastInsertRowid)) as OrderRow;
      const filled = fillPendingRow(row, candle.c, ts);
      logger.info(
        {
          clientOrderId,
          assetId: req.assetId,
          side: req.side,
          qty: req.qty,
          price: candle.c,
        },
        'paper market order filled',
      );
      return rowToOrder(filled);
    }

    // Limit / stop queued — fill-scan cron handles crossings.
    const info = db
      .prepare(
        `INSERT INTO orders
           (client_order_id, broker, asset_id, side, type, qty,
            limit_price, stop_price, status, filled_qty, created_at)
         VALUES (?, 'paper', ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .run(
        clientOrderId,
        req.assetId,
        req.side,
        req.type,
        req.qty,
        req.limitPrice ?? null,
        req.stopPrice ?? null,
        ts,
      );
    const row = db
      .prepare('SELECT * FROM orders WHERE id = ?')
      .get(Number(info.lastInsertRowid)) as OrderRow;
    logger.info(
      {
        clientOrderId,
        assetId: req.assetId,
        side: req.side,
        qty: req.qty,
        type: req.type,
      },
      'paper order queued',
    );
    emitOrderStatusEvent(row);
    return rowToOrder(row);
  }

  async cancelOrder(clientOrderId: string): Promise<void> {
    const row = db
      .prepare(`SELECT * FROM orders WHERE client_order_id = ? AND broker = 'paper'`)
      .get(clientOrderId) as OrderRow | undefined;
    if (!row) throw new Error('order not found');
    if (row.status !== 'pending') {
      throw new Error(`cannot cancel order in status ${row.status}`);
    }
    const ts = nowSec();
    db.prepare(
      `UPDATE orders SET status = 'cancelled', completed_at = ? WHERE id = ?`,
    ).run(ts, row.id);
    const updated = db
      .prepare('SELECT * FROM orders WHERE id = ?')
      .get(row.id) as OrderRow;
    emitOrderStatusEvent(updated);
  }

  async getOrder(clientOrderId: string): Promise<Order> {
    const row = db
      .prepare(`SELECT * FROM orders WHERE client_order_id = ? AND broker = 'paper'`)
      .get(clientOrderId) as OrderRow | undefined;
    if (!row) throw new Error('order not found');
    return rowToOrder(row);
  }

  async listOpenOrders(): Promise<Order[]> {
    const rows = db
      .prepare(
        `SELECT * FROM orders
           WHERE broker = 'paper' AND status IN ('pending','submitted','partial')
           ORDER BY created_at DESC`,
      )
      .all() as OrderRow[];
    return rows.map(rowToOrder);
  }

  async getPositions(): Promise<Position[]> {
    const rows = db
      .prepare(
        `SELECT id, broker, asset_id, qty, avg_entry_price, realized_pnl, updated_at
           FROM positions WHERE broker = 'paper' ORDER BY updated_at DESC`,
      )
      .all() as PositionRow[];
    return rows.map(rowToPosition);
  }

  async getAccountBalance(): Promise<AccountBalance> {
    // "Paper" is bucketed per asset type; the balance API returns the
    // combined cash across buckets. Per-bucket detail is surfaced via the
    // dedicated paper-balance kv endpoints in `api/runtime.ts`.
    const crypto = getPaperBalance('crypto');
    const stocks = getPaperBalance('stock');
    const cash = crypto + stocks;
    return {
      broker: 'paper',
      cash,
      equity: cash,
      buyingPower: cash,
      currency: 'USD',
    };
  }
}

export const paperBroker = new PaperBroker();

// ── Fill-scan cron ─────────────────────────────────────────────────────

let fillTask: cron.ScheduledTask | null = null;

/**
 * Sweep all pending paper limit/stop orders. Crossings are evaluated
 * against the latest closed 1m candle. Stop orders trigger as market
 * fills at `candle.c` once the stop price is breached.
 */
export function scanPendingOrders(): void {
  const rows = db
    .prepare(
      `SELECT * FROM orders WHERE broker = 'paper' AND status = 'pending'
         AND type IN ('limit','stop')`,
    )
    .all() as OrderRow[];
  if (rows.length === 0) return;

  const ts = nowSec();
  for (const row of rows) {
    const candle = latestClose(row.asset_id);
    if (!candle) continue;
    let fillPrice: number | null = null;

    if (row.type === 'limit') {
      const limit = row.limit_price;
      if (limit === null) continue;
      if (row.side === 'buy' && candle.l <= limit) {
        fillPrice = Math.min(limit, candle.l);
      } else if (row.side === 'sell' && candle.h >= limit) {
        fillPrice = Math.max(limit, candle.h);
      }
    } else if (row.type === 'stop') {
      const stop = row.stop_price;
      if (stop === null) continue;
      if (row.side === 'buy' && candle.h >= stop) {
        fillPrice = candle.c;
      } else if (row.side === 'sell' && candle.l <= stop) {
        fillPrice = candle.c;
      }
    }

    if (fillPrice !== null && Number.isFinite(fillPrice)) {
      try {
        fillPendingRow(row, fillPrice, ts);
        logger.info(
          {
            clientOrderId: row.client_order_id,
            assetId: row.asset_id,
            side: row.side,
            type: row.type,
            price: fillPrice,
          },
          'paper pending order filled by scanner',
        );
      } catch (err) {
        logger.error({ err, orderId: row.id }, 'fill-scan error');
      }
    }
  }
}

export function startFillScanCron(): void {
  if (fillTask) return;
  fillTask = cron.schedule('*/5 * * * * *', () => {
    try {
      scanPendingOrders();
    } catch (err) {
      logger.error({ err }, 'fill-scan cron tick failed');
    }
  });
  logger.info('paper fill-scan cron started (every 5s)');
}

export function stopFillScanCron(): void {
  if (fillTask) {
    fillTask.stop();
    fillTask = null;
  }
}

// ── Internal helpers re-exported for siblings ──────────────────────────

export const _paperInternals = {
  applyFillToPosition,
  applyFillToBalance,
  getPaperBalance,
  setPaperBalance,
  emitOrderStatusEvent,
  generateClientOrderId,
  rowToOrder,
  rowToPosition,
};
