/**
 * Crypto (ccxt / Binance) adapter — Phase 9 paper shim.
 *
 * In paper mode (`kv['trading_mode'] !== 'live'`), every write call
 * delegates to `paperBroker`. Only read-only calls like `fetchBalance`
 * actually hit Binance — used for key verification in Settings.
 *
 * Live mode (`kv['trading_mode'] === 'live'`) is reserved for Phase 10;
 * this file wires the branch but returns errors until the user explicitly
 * opts in via the Settings flow. That keeps the contract stable for the
 * order-manager and avoids a later refactor.
 */

import type {
  AccountBalance,
  Broker,
  Order,
  PlaceOrderRequest,
  Position,
} from '@cockpit/shared';
import { getApiKey } from '../config.js';
import { db } from '../db/client.js';
import { logger } from '../util/logger.js';
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

class CryptoCcxtBroker implements Broker {
  async placeOrder(req: PlaceOrderRequest): Promise<Order> {
    if (!isLive()) {
      // Paper-shimmed path: all crypto orders route through paper broker.
      return paperBroker.placeOrder(req);
    }

    // Live path — Phase 10 wires the full createOrder call. Guard here so
    // flipping `trading_mode` by hand doesn't silently send money.
    const creds = getApiKey('binance');
    if (!creds) throw new Error('binance key not configured');
    const client = await ensureBinance();

    // Resolve the symbol. We look it up from the asset id so the manager
    // doesn't have to know about exchange-specific formatting.
    const asset = db
      .prepare(
        `SELECT symbol FROM assets WHERE id = ? AND tradeable_via = 'ccxt'`,
      )
      .get(req.assetId) as { symbol: string } | undefined;
    if (!asset) throw new Error('asset not tradeable via ccxt');

    const ccxtSymbol = asset.symbol.includes('/')
      ? asset.symbol
      : `${asset.symbol.replace(/USDT$/, '')}/USDT`;

    const params: Record<string, unknown> = {};
    const price =
      req.type === 'limit' ? req.limitPrice : req.type === 'stop' ? req.stopPrice : undefined;
    const brokerResponse = await client.createOrder(
      ccxtSymbol,
      req.type,
      req.side,
      req.qty,
      price,
      params,
    );
    logger.info({ brokerResponse }, 'live binance order placed');

    // Live reconciliation / DB insert will be wired by Phase 10 order
    // manager's watcher; we throw here so paper callers never land here
    // accidentally.
    throw new Error(
      'live crypto trading requires Phase 10 order reconciliation to be enabled',
    );
  }

  async cancelOrder(clientOrderId: string): Promise<void> {
    if (!isLive()) return paperBroker.cancelOrder(clientOrderId);
    const client = await ensureBinance();
    await client.cancelOrder(clientOrderId);
  }

  async getOrder(clientOrderId: string): Promise<Order> {
    if (!isLive()) return paperBroker.getOrder(clientOrderId);
    throw new Error('live getOrder not implemented until Phase 10');
  }

  async listOpenOrders(): Promise<Order[]> {
    if (!isLive()) return paperBroker.listOpenOrders();
    const client = await ensureBinance();
    await client.fetchOpenOrders();
    return [];
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
