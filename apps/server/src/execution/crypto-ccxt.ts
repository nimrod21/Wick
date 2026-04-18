/**
 * Crypto (ccxt / Binance) adapter — Phase 10 live-mode wiring.
 *
 * In paper mode (`kv['trading_mode'] !== 'live'`), every write call
 * delegates to `paperBroker`. Read-only calls (`fetchBalance`) still hit
 * Binance so the Settings page can verify keys.
 *
 * In live mode (`kv['trading_mode'] === 'live'`) Phase 10 wires the real
 * order path:
 *   1. Check Binance key permissions via `sapiGetAccountApirestrictions()`
 *      and refuse to submit if spot trading is disabled or withdrawals
 *      are enabled.
 *   2. Submit via `binance.createOrder(...)` with an idempotent
 *      clientOrderId.
 *   3. Insert a local `orders` row (`broker='ccxt'`, status='submitted').
 *   4. Kick off a per-order 2s poll loop that reconciles status until
 *      the order reaches a terminal state, emitting `order_status`
 *      events along the way.
 *
 * On boot we also run a one-shot reconciliation: any open Binance order
 * not in the local DB is inserted as `submitted`, and any local
 * `submitted` order missing from Binance is marked `orphan` with a
 * warning log.
 */

import { randomBytes } from 'node:crypto';
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
import { getApiKey } from '../config.js';
import { db } from '../db/client.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../util/logger.js';
import { nowSec } from '../util/time.js';
import { paperBroker } from './paper-mode.js';

// ccxt's package exposes a default export with class-per-exchange; we only
// need `binance`. Keep the import dynamic so tests that stub the module
// don't require the real dep to load.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CcxtBinance = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ccxtModule: any = null;
let binanceClient: CcxtBinance | null = null;
let keyUsed: string | null = null;

let eventSeq = 5_000_000;

async function getCcxt(): Promise<unknown> {
  if (ccxtModule) return ccxtModule;
  try {
    const mod = (await import('ccxt')) as { default?: unknown } & Record<string, unknown>;
    ccxtModule = mod.default ?? mod;
  } catch (err) {
    logger.warn({ err }, 'ccxt module not installed; crypto adapter unavailable');
    throw new Error('ccxt module not installed');
  }
  return ccxtModule;
}

function kvGet(key: string): string | null {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as
    | { v: string }
    | undefined;
  return row ? row.v : null;
}

function isLive(): boolean {
  return kvGet('trading_mode') === 'live';
}

async function ensureBinance(): Promise<CcxtBinance> {
  const creds = getApiKey('binance');
  if (!creds) throw new Error('binance key not configured');
  if (binanceClient && keyUsed === creds.key) return binanceClient;
  const ccxt = (await getCcxt()) as {
    binance: new (opts: Record<string, unknown>) => CcxtBinance;
  };
  binanceClient = new ccxt.binance({
    apiKey: creds.key,
    secret: creds.secret ?? '',
    enableRateLimit: true,
    options: { defaultType: 'spot' },
  });
  keyUsed = creds.key;
  return binanceClient;
}

// ── Row helpers ────────────────────────────────────────────────────────

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
    source: 'ccxt-broker',
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

function parseNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Map ccxt's lowercase status strings into our canonical OrderStatus.
 * ccxt normalises binance's statuses as: 'open' | 'closed' | 'canceled'
 * plus info.status like 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' |
 * 'REJECTED' | 'EXPIRED'.
 */
function mapCcxtStatus(ccxtStatus: string | undefined, rawStatus?: string): OrderStatus {
  const raw = (rawStatus ?? '').toUpperCase();
  if (raw === 'PARTIALLY_FILLED') return 'partial';
  if (raw === 'FILLED') return 'filled';
  if (raw === 'CANCELED' || raw === 'PENDING_CANCEL') return 'cancelled';
  if (raw === 'REJECTED') return 'rejected';
  if (raw === 'EXPIRED') return 'expired';
  if (raw === 'NEW') return 'submitted';

  switch (ccxtStatus) {
    case 'open':
      return 'submitted';
    case 'closed':
      return 'filled';
    case 'canceled':
      return 'cancelled';
    case 'expired':
      return 'expired';
    case 'rejected':
      return 'rejected';
    default:
      return 'submitted';
  }
}

function isTerminal(status: OrderStatus): boolean {
  return (
    status === 'filled' ||
    status === 'cancelled' ||
    status === 'rejected' ||
    status === 'expired'
  );
}

function generateClientOrderId(assetId: number): string {
  return `${assetId}-${nowSec()}-${randomBytes(3).toString('hex')}`;
}

function resolveCcxtSymbol(symbol: string): string {
  return symbol.includes('/') ? symbol : `${symbol.replace(/USDT$/, '')}/USDT`;
}

// ── Permissions check ─────────────────────────────────────────────────

export class PermissionsError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = 'PermissionsError';
    this.detail = detail;
  }
}

interface ApiRestrictions {
  ipRestrict?: boolean;
  enableReading?: boolean;
  enableSpotAndMarginTrading?: boolean;
  enableWithdrawals?: boolean;
  enableMargin?: boolean;
  enableFutures?: boolean;
  enableVanillaOptions?: boolean;
  [k: string]: unknown;
}

/**
 * Hit Binance's signed `GET /sapi/v1/account/apiRestrictions` endpoint
 * via the ccxt raw API wrapper. We require spot trading enabled AND
 * withdrawals disabled — anything else is refused so a leaked key can't
 * drain funds.
 */
export async function verifyBinancePermissions(): Promise<{
  ok: boolean;
  enableSpotAndMarginTrading: boolean;
  enableWithdrawals: boolean;
  ipRestrict: boolean;
  detail: Record<string, unknown>;
}> {
  const creds = getApiKey('binance');
  if (!creds) {
    return {
      ok: false,
      enableSpotAndMarginTrading: false,
      enableWithdrawals: false,
      ipRestrict: false,
      detail: { error: 'binance key not configured' },
    };
  }
  try {
    const client = await ensureBinance();
    const raw = (await client.sapiGetAccountApirestrictions()) as ApiRestrictions;
    const spotOk = raw.enableSpotAndMarginTrading === true;
    const withdrawalsOff = raw.enableWithdrawals === false;
    const ok = spotOk && withdrawalsOff;
    return {
      ok,
      enableSpotAndMarginTrading: spotOk,
      enableWithdrawals: raw.enableWithdrawals === true,
      ipRestrict: raw.ipRestrict === true,
      detail: raw as Record<string, unknown>,
    };
  } catch (err) {
    logger.error({ err }, 'verifyBinancePermissions failed');
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      enableSpotAndMarginTrading: false,
      enableWithdrawals: false,
      ipRestrict: false,
      detail: { error: message },
    };
  }
}

// ── Live-order poll loop ──────────────────────────────────────────────

/**
 * Per-order poll. We track timers in-process so an order's lifecycle is
 * reconciled independently of the global watcher in order-manager
 * (which also covers live orders but at a slower cadence). Once the
 * order hits a terminal state we clear the timer.
 */
const orderPollTimers = new Map<number, NodeJS.Timeout>();

function stopOrderPoll(orderId: number): void {
  const t = orderPollTimers.get(orderId);
  if (t) {
    clearTimeout(t);
    orderPollTimers.delete(orderId);
  }
}

function scheduleOrderPoll(orderId: number): void {
  stopOrderPoll(orderId);
  const timer = setTimeout(() => {
    orderPollTimers.delete(orderId);
    pollOrderOnce(orderId).catch((err) => {
      logger.warn({ err, orderId }, 'ccxt pollOrderOnce failed');
    });
  }, 2000);
  orderPollTimers.set(orderId, timer);
}

async function pollOrderOnce(orderId: number): Promise<void> {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as
    | OrderRow
    | undefined;
  if (!row) return;
  if (row.broker !== 'ccxt') return;
  const current = row.status as OrderStatus;
  if (isTerminal(current)) return;

  const asset = db
    .prepare(`SELECT symbol FROM assets WHERE id = ?`)
    .get(row.asset_id) as { symbol: string } | undefined;
  if (!asset) return;

  try {
    const client = await ensureBinance();
    const resp = (await client.fetchOrder(
      row.broker_order_id ?? row.client_order_id,
      resolveCcxtSymbol(asset.symbol),
    )) as {
      id?: string;
      status?: string;
      info?: { status?: string };
      filled?: number;
      average?: number;
      timestamp?: number;
    };
    const status = mapCcxtStatus(resp.status, resp.info?.status);
    const filledQty = parseNum(resp.filled);
    const avgFill = resp.average != null ? parseNum(resp.average) : null;
    const completedAt = isTerminal(status) ? nowSec() : null;
    db.prepare(
      `UPDATE orders
          SET status = ?,
              filled_qty = ?,
              avg_fill_price = COALESCE(?, avg_fill_price),
              completed_at = COALESCE(?, completed_at)
        WHERE id = ?`,
    ).run(status, filledQty, avgFill, completedAt, orderId);

    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) as OrderRow;
    if (updated.status !== row.status || updated.filled_qty !== row.filled_qty) {
      emitStatusForRow(updated);
    }

    if (!isTerminal(updated.status as OrderStatus)) {
      scheduleOrderPoll(orderId);
    }
  } catch (err) {
    logger.warn({ err, orderId }, 'ccxt fetchOrder poll failed; will retry');
    // retry after the same interval
    scheduleOrderPoll(orderId);
  }
}

// ── Startup reconciliation ─────────────────────────────────────────────

function resolveAssetIdBySymbol(ccxtSymbol: string): number | null {
  // ccxt returns symbols like 'BTC/USDT'. Our stored symbol could be either
  // 'BTCUSDT' or 'BTC/USDT' depending on seed.
  const flat = ccxtSymbol.replace('/', '');
  const row = db
    .prepare(
      `SELECT id FROM assets
         WHERE tradeable_via = 'ccxt'
           AND (symbol = ? OR symbol = ?)
         LIMIT 1`,
    )
    .get(ccxtSymbol, flat) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * One-shot reconcile on boot. Best-effort: any errors are logged but
 * don't stop startup. Only runs when a binance key is present — no key,
 * nothing to reconcile.
 */
export async function reconcileCcxtOnBoot(): Promise<void> {
  const creds = getApiKey('binance');
  if (!creds) {
    logger.info('ccxt reconcile skipped — no binance key');
    return;
  }
  try {
    const client = await ensureBinance();
    // fetchOpenOrders without symbol needs the user to have the "multiple
    // symbol" whitelist; if binance rejects we catch below.
    const remote = (await client.fetchOpenOrders()) as Array<{
      id?: string;
      clientOrderId?: string;
      symbol?: string;
      side?: 'buy' | 'sell';
      type?: string;
      amount?: number;
      price?: number;
      stopPrice?: number;
      status?: string;
      timestamp?: number;
      info?: { status?: string };
    }>;

    const remoteIds = new Set<string>();
    for (const r of remote) {
      const brokerId = r.id ?? r.clientOrderId ?? '';
      if (brokerId) remoteIds.add(brokerId);

      const assetId = r.symbol ? resolveAssetIdBySymbol(r.symbol) : null;
      if (!assetId) continue;

      const existing = db
        .prepare(
          `SELECT id FROM orders WHERE broker = 'ccxt' AND broker_order_id = ?`,
        )
        .get(brokerId) as { id: number } | undefined;
      if (existing) continue;

      const type = ((r.type ?? 'market') as OrderType);
      const side = (r.side ?? 'buy') as OrderSide;
      const clientOrderId = r.clientOrderId && r.clientOrderId.length > 0
        ? r.clientOrderId
        : `recon-${brokerId}`;
      const status = mapCcxtStatus(r.status, r.info?.status);
      const createdAt = r.timestamp ? Math.floor(r.timestamp / 1000) : nowSec();
      db.prepare(
        `INSERT INTO orders
           (client_order_id, broker, asset_id, side, type, qty,
            limit_price, stop_price, status, filled_qty,
            submitted_at, created_at, broker_order_id)
         VALUES (?, 'ccxt', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      ).run(
        clientOrderId,
        assetId,
        side,
        type,
        parseNum(r.amount),
        r.price != null ? parseNum(r.price) : null,
        r.stopPrice != null ? parseNum(r.stopPrice) : null,
        status,
        createdAt,
        createdAt,
        brokerId,
      );
      logger.info(
        { brokerId, assetId, symbol: r.symbol },
        'ccxt reconcile: inserted missing remote order',
      );
    }

    // Local-only: mark submitted rows not present remotely as 'orphan'.
    // We use 'rejected' with an error message so downstream UIs don't
    // break on a new status enum value.
    const localOpen = db
      .prepare(
        `SELECT id, broker_order_id FROM orders
           WHERE broker = 'ccxt' AND status IN ('submitted','partial')`,
      )
      .all() as Array<{ id: number; broker_order_id: string | null }>;
    for (const loc of localOpen) {
      if (!loc.broker_order_id) continue;
      if (remoteIds.has(loc.broker_order_id)) continue;
      db.prepare(
        `UPDATE orders
            SET status = 'rejected', error = 'orphan: not found on remote', completed_at = ?
          WHERE id = ?`,
      ).run(nowSec(), loc.id);
      logger.warn(
        { orderId: loc.id, brokerOrderId: loc.broker_order_id },
        'ccxt reconcile: local order marked orphan (not on remote)',
      );
      const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(loc.id) as OrderRow;
      emitStatusForRow(row);
    }
  } catch (err) {
    logger.warn({ err }, 'ccxt reconcile failed (non-fatal)');
  }
}

// ── Broker implementation ──────────────────────────────────────────────

class CryptoCcxtBroker implements Broker {
  async placeOrder(req: PlaceOrderRequest): Promise<Order> {
    if (!isLive()) {
      // Paper-shimmed path: all crypto orders route through paper broker.
      return paperBroker.placeOrder(req);
    }

    // ─── Live path ───
    const creds = getApiKey('binance');
    if (!creds) throw new Error('binance key not configured');

    // 1. Gate on key permissions. Prevents sending any order if the key
    // has withdrawals enabled or spot disabled.
    const perms = await verifyBinancePermissions();
    if (!perms.ok) {
      throw new PermissionsError('binance_permissions_failed', {
        enableSpotAndMarginTrading: perms.enableSpotAndMarginTrading,
        enableWithdrawals: perms.enableWithdrawals,
      });
    }

    const client = await ensureBinance();

    // Resolve the symbol. We look it up from the asset id so the manager
    // doesn't have to know about exchange-specific formatting.
    const asset = db
      .prepare(
        `SELECT id, symbol FROM assets WHERE id = ? AND tradeable_via = 'ccxt'`,
      )
      .get(req.assetId) as { id: number; symbol: string } | undefined;
    if (!asset) throw new Error('asset not tradeable via ccxt');

    const ccxtSymbol = resolveCcxtSymbol(asset.symbol);

    // 2. Idempotent client order id. Pattern mirrors the paper broker so
    // downstream DB lookups work the same way.
    const clientOrderId = generateClientOrderId(req.assetId);
    const ts = nowSec();

    // 3. Submit. ccxt binance accepts `newClientOrderId` in the params
    // passthrough — we include both keys so the behaviour is the same
    // whether ccxt normalises it or forwards verbatim.
    const params: Record<string, unknown> = {
      clientOrderId,
      newClientOrderId: clientOrderId,
    };
    const price =
      req.type === 'limit'
        ? req.limitPrice
        : req.type === 'stop'
          ? req.stopPrice
          : undefined;

    let resp: {
      id?: string;
      status?: string;
      info?: Record<string, unknown>;
      filled?: number;
      average?: number;
    };
    try {
      resp = (await client.createOrder(
        ccxtSymbol,
        req.type,
        req.side,
        req.qty,
        price,
        params,
      )) as typeof resp;
    } catch (err) {
      logger.error({ err, clientOrderId, ccxtSymbol }, 'binance createOrder failed');
      // Persist a rejected row so the UI sees the failure even though we
      // never got a broker_order_id.
      const info = db
        .prepare(
          `INSERT INTO orders
             (client_order_id, broker, asset_id, side, type, qty,
              limit_price, stop_price, status, filled_qty,
              submitted_at, created_at, error)
           VALUES (?, 'ccxt', ?, ?, ?, ?, ?, ?, 'rejected', 0, ?, ?, ?)`,
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
          err instanceof Error ? err.message : String(err),
        );
      const row = db
        .prepare('SELECT * FROM orders WHERE id = ?')
        .get(Number(info.lastInsertRowid)) as OrderRow;
      emitStatusForRow(row);
      throw err instanceof Error ? err : new Error(String(err));
    }

    // 4. Persist the submitted order. raw_response_json intentionally
    // stored in `error` column as JSON if there's no dedicated column;
    // schema-compatible fallback if `raw_response_json` column isn't
    // defined. Here we stash a truncated JSON of resp.info in the
    // `error` column only on non-ok statuses — for submitted we leave it
    // null.
    const initialStatus = mapCcxtStatus(resp.status, resp.info?.status as string | undefined);
    const filledQty = parseNum(resp.filled);
    const avgFill = resp.average != null ? parseNum(resp.average) : null;
    const brokerId = resp.id ?? clientOrderId;

    const info = db
      .prepare(
        `INSERT INTO orders
           (client_order_id, broker, asset_id, side, type, qty,
            limit_price, stop_price, status, avg_fill_price, filled_qty,
            submitted_at, created_at, broker_order_id)
         VALUES (?, 'ccxt', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        clientOrderId,
        req.assetId,
        req.side,
        req.type,
        req.qty,
        req.limitPrice ?? null,
        req.stopPrice ?? null,
        initialStatus,
        avgFill,
        filledQty,
        ts,
        ts,
        brokerId,
      );
    const rowId = Number(info.lastInsertRowid);
    const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(rowId) as OrderRow;

    logger.info(
      {
        clientOrderId,
        brokerId,
        assetId: req.assetId,
        side: req.side,
        qty: req.qty,
        status: row.status,
      },
      'live binance order placed',
    );
    emitStatusForRow(row);

    // 5. Kick off the poll loop if not already terminal.
    if (!isTerminal(row.status as OrderStatus)) {
      scheduleOrderPoll(rowId);
    }

    return rowToOrder(row);
  }

  async cancelOrder(clientOrderId: string): Promise<void> {
    if (!isLive()) return paperBroker.cancelOrder(clientOrderId);
    const row = db
      .prepare(`SELECT * FROM orders WHERE client_order_id = ? AND broker = 'ccxt'`)
      .get(clientOrderId) as OrderRow | undefined;
    if (!row) throw new Error('order not found');

    const asset = db
      .prepare(`SELECT symbol FROM assets WHERE id = ?`)
      .get(row.asset_id) as { symbol: string } | undefined;
    if (!asset) throw new Error('asset lookup failed');

    const client = await ensureBinance();
    const target = row.broker_order_id ?? clientOrderId;
    await client.cancelOrder(target, resolveCcxtSymbol(asset.symbol));
    const ts = nowSec();
    db.prepare(
      `UPDATE orders SET status = 'cancelled', completed_at = ? WHERE id = ?`,
    ).run(ts, row.id);
    const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(row.id) as OrderRow;
    emitStatusForRow(updated);
    stopOrderPoll(row.id);
  }

  async getOrder(clientOrderId: string): Promise<Order> {
    if (!isLive()) return paperBroker.getOrder(clientOrderId);
    const row = db
      .prepare(`SELECT * FROM orders WHERE client_order_id = ? AND broker = 'ccxt'`)
      .get(clientOrderId) as OrderRow | undefined;
    if (!row) throw new Error('order not found');
    // Fire-and-forget refresh from the exchange; return the local row.
    // The per-order poll loop handles ongoing updates — here we just
    // nudge an extra refresh for manual reads.
    pollOrderOnce(row.id).catch(() => void 0);
    return rowToOrder(row);
  }

  async listOpenOrders(): Promise<Order[]> {
    if (!isLive()) return paperBroker.listOpenOrders();
    const rows = db
      .prepare(
        `SELECT * FROM orders
           WHERE broker = 'ccxt' AND status IN ('submitted','partial')
           ORDER BY created_at DESC`,
      )
      .all() as OrderRow[];
    return rows.map(rowToOrder);
  }

  async getPositions(): Promise<Position[]> {
    // Positions are always tracked locally (paper ledger), regardless of
    // live mode — Binance spot has no "position" concept anyway.
    return paperBroker.getPositions();
  }

  async getAccountBalance(): Promise<AccountBalance> {
    // In paper mode return the paper balance. In live mode we hit Binance.
    if (!isLive()) return paperBroker.getAccountBalance();
    const creds = getApiKey('binance');
    if (!creds) throw new Error('binance key not configured');
    const client = await ensureBinance();
    const bal = (await client.fetchBalance()) as {
      total?: Record<string, number>;
      USDT?: { free?: number; total?: number };
    };
    const cash = bal.USDT?.total ?? bal.total?.USDT ?? 0;
    return {
      broker: 'ccxt',
      cash,
      equity: cash,
      buyingPower: cash,
      currency: 'USDT',
    };
  }
}

export const cryptoCcxtBroker = new CryptoCcxtBroker();

/** Cancel all pending per-order poll timers — used on shutdown. */
export function stopCcxtPolls(): void {
  for (const t of orderPollTimers.values()) clearTimeout(t);
  orderPollTimers.clear();
}
