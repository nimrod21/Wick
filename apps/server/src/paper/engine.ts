/**
 * Paper trading engine (IMPL-2 §2.1) — bot-scoped fills against live prices.
 *
 * Accounting model (PLAN §10):
 *   - Fee 0.1% per side, charged on the pre-slip notional (qty × mid).
 *   - Slippage 0.05% of notional, ×2 while a volatility window is open for
 *     the symbol (trigger engine calls `setVolatilityWindow` in Phase 4).
 *   - Buy of $N: qty = N / mid; cash -= N + slip + fee  (fill price = mid×(1+s)).
 *   - Sell of qty q: cash += q×mid − slip − fee          (fill price = mid×(1−s)).
 *   - Weighted-avg entry on adds; position row deleted when remaining
 *     value < $0.50 (dust — a partial sell that would leave dust closes fully).
 *   - equity(botId) = cash + Σ qty×mid. Hourly cron → `equity_snapshots`.
 *     Drawdown high-water mark is derived from snapshots (+ bankroll_start
 *     + current equity), never stored separately.
 *
 * Rejections are typed results, not exceptions. Prepared statements are
 * created inside functions (module-level prepare crashes on a fresh DB
 * before migrations run).
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { FillEvent } from '@wick/shared';
import { db } from '../db/client.js';
import { eventBus } from '../core/event-bus.js';
import { getLastPrice } from '../collectors/crypto/binance-ws.js';
import { logger } from '../util/logger.js';
import { nowMs } from '../util/time.js';

export const FEE_RATE = 0.001;        // 0.1% per side
export const BASE_SLIP_RATE = 0.0005; // 0.05%
export const MIN_NOTIONAL_USD = 10;
export const DUST_USD = 0.5;
const QTY_EPS = 1e-12;
const PRIMED_PRICE_TTL_MS = 30_000;

// ── row shapes ─────────────────────────────────────────────────────────

export interface BotRow {
  id: number;
  name: string;
  status: string;
  bankroll_start: number;
  cash: number;
  config_json: string;
  created_ts: number;
  stopped_ts: number | null;
}

export interface PositionRow {
  bot_id: number;
  symbol: string;
  qty: number;
  avg_entry: number;
  stop_price: number | null;
  tp_price: number | null;
  opened_ts: number;
}

export interface FillRow {
  id: number;
  bot_id: number;
  decision_id: number | null;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;
  fee: number;
  slip: number;
  ts: number;
}

// ── result types ───────────────────────────────────────────────────────

export type RejectReason =
  | 'bot_not_found'
  | 'no_price'
  | 'insufficient_cash'
  | 'no_position'
  | 'below_min_notional'
  | 'invalid_size';

export type TradeResult =
  | { ok: true; fill: FillRow; position: PositionRow | null; cash: number }
  | { ok: false; reason: RejectReason; detail?: string };

export interface TradeOpts {
  /** SL as percent distance; sign-normalized (5 or −5 both mean 5% below entry). */
  slPct?: number | null;
  /** TP as percent distance above entry. */
  tpPct?: number | null;
  decisionId?: number | null;
  /** Fill reason for the event/audit trail. Default 'trade'. */
  reason?: 'trade' | 'sl' | 'tp';
}

// ── price source ───────────────────────────────────────────────────────

const primedPrices = new Map<string, { price: number; ts: number }>();

/**
 * Inject an externally-fetched price (CLI REST fallback when neither the
 * WS feed nor a fresh 1m candle is available). TTL 30s.
 */
export function primeMid(symbol: string, price: number): void {
  primedPrices.set(symbol.toUpperCase(), { price, ts: nowMs() });
}

/**
 * Live mid for a symbol: WS last trade price → primed price (≤30s old) →
 * newest 1m candle close. Null when nothing is available.
 */
export function midPrice(symbol: string): number | null {
  const sym = symbol.toUpperCase();
  const live = getLastPrice(sym);
  if (live !== null && Number.isFinite(live)) return live;

  const primed = primedPrices.get(sym);
  if (primed && nowMs() - primed.ts <= PRIMED_PRICE_TTL_MS) return primed.price;

  const row = db
    .prepare(`SELECT c FROM candles WHERE symbol = ? AND tf = '1m' ORDER BY ts DESC LIMIT 1`)
    .get(sym) as { c: number } | undefined;
  return row ? row.c : null;
}

// ── volatility window (Phase 4 wires the trigger engine to this) ───────

const volatilityUntil = new Map<string, number>();

/** Double slippage for `symbol` until `untilTs` (UTC ms). */
export function setVolatilityWindow(symbol: string, untilTs: number): void {
  volatilityUntil.set(symbol.toUpperCase(), untilTs);
}

export function isVolatilityWindowOpen(symbol: string): boolean {
  const until = volatilityUntil.get(symbol.toUpperCase());
  return until !== undefined && nowMs() < until;
}

function slipRate(symbol: string): number {
  return BASE_SLIP_RATE * (isVolatilityWindowOpen(symbol) ? 2 : 1);
}

// ── small readers ──────────────────────────────────────────────────────

export function getBot(botId: number): BotRow | undefined {
  return db.prepare('SELECT * FROM bots WHERE id = ?').get(botId) as BotRow | undefined;
}

export function getPosition(botId: number, symbol: string): PositionRow | undefined {
  return db
    .prepare('SELECT * FROM positions WHERE bot_id = ? AND symbol = ?')
    .get(botId, symbol.toUpperCase()) as PositionRow | undefined;
}

export function getPositions(botId: number): PositionRow[] {
  return db
    .prepare('SELECT * FROM positions WHERE bot_id = ? ORDER BY opened_ts')
    .all(botId) as PositionRow[];
}

function normalizeSl(slPct: number | null | undefined): number | null {
  if (slPct === null || slPct === undefined || !Number.isFinite(slPct) || slPct === 0) return null;
  return -Math.abs(slPct);
}

function normalizeTp(tpPct: number | null | undefined): number | null {
  if (tpPct === null || tpPct === undefined || !Number.isFinite(tpPct) || tpPct === 0) return null;
  return Math.abs(tpPct);
}

function publishFill(fill: FillRow, notional: number, reason: 'trade' | 'sl' | 'tp'): void {
  const evt: FillEvent = {
    id: fill.id,
    ts: fill.ts,
    source: 'paper-engine',
    kind: 'fill',
    botId: fill.bot_id,
    symbol: fill.symbol,
    side: fill.side,
    qty: fill.qty,
    price: fill.price,
    fee: fill.fee,
    slip: fill.slip,
    notional,
    reason,
    decisionId: fill.decision_id,
  };
  eventBus.emit(evt);
}

// ── buy / sell ─────────────────────────────────────────────────────────

/**
 * Buy `notionalUsd` (pre-slip, pre-fee) of `symbol` for bot `botId`.
 * Cash decrement = notional + slip + fee. Stop/TP absolute prices are
 * recomputed from the (new weighted-avg) entry when pcts are provided;
 * an add without pcts keeps the existing levels.
 */
export function buy(
  botId: number,
  symbol: string,
  notionalUsd: number,
  opts: TradeOpts = {},
): TradeResult {
  const sym = symbol.toUpperCase();
  const bot = getBot(botId);
  if (!bot) return { ok: false, reason: 'bot_not_found' };
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
    return { ok: false, reason: 'invalid_size', detail: String(notionalUsd) };
  }
  if (notionalUsd < MIN_NOTIONAL_USD) {
    return {
      ok: false,
      reason: 'below_min_notional',
      detail: `$${notionalUsd.toFixed(2)} < $${MIN_NOTIONAL_USD}`,
    };
  }
  const mid = midPrice(sym);
  if (mid === null) return { ok: false, reason: 'no_price', detail: sym };

  const s = slipRate(sym);
  const slipUsd = notionalUsd * s;
  const fee = notionalUsd * FEE_RATE;
  const cost = notionalUsd + slipUsd + fee;
  if (cost > bot.cash + 1e-9) {
    return {
      ok: false,
      reason: 'insufficient_cash',
      detail: `need $${cost.toFixed(2)}, have $${bot.cash.toFixed(2)}`,
    };
  }

  const qty = notionalUsd / mid;
  const execPrice = mid * (1 + s);
  const ts = nowMs();
  const slPct = normalizeSl(opts.slPct);
  const tpPct = normalizeTp(opts.tpPct);

  const result = db.transaction((): { fill: FillRow; position: PositionRow } => {
    const info = db
      .prepare(
        `INSERT INTO fills (bot_id, decision_id, symbol, side, qty, price, fee, slip, ts)
         VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, ?)`,
      )
      .run(botId, opts.decisionId ?? null, sym, qty, execPrice, fee, slipUsd, ts);
    const fillId = Number(info.lastInsertRowid);

    const existing = getPosition(botId, sym);
    let avgEntry: number;
    if (existing && existing.qty > QTY_EPS) {
      avgEntry =
        (existing.avg_entry * existing.qty + execPrice * qty) / (existing.qty + qty);
    } else {
      avgEntry = execPrice;
    }
    const stopPrice = slPct !== null ? avgEntry * (1 + slPct / 100) : existing?.stop_price ?? null;
    const tpPrice = tpPct !== null ? avgEntry * (1 + tpPct / 100) : existing?.tp_price ?? null;

    db.prepare(
      `INSERT INTO positions (bot_id, symbol, qty, avg_entry, stop_price, tp_price, opened_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bot_id, symbol) DO UPDATE SET
         qty = excluded.qty, avg_entry = excluded.avg_entry,
         stop_price = excluded.stop_price, tp_price = excluded.tp_price`,
    ).run(
      botId,
      sym,
      (existing?.qty ?? 0) + qty,
      avgEntry,
      stopPrice,
      tpPrice,
      existing?.opened_ts ?? ts,
    );

    db.prepare('UPDATE bots SET cash = cash - ? WHERE id = ?').run(cost, botId);

    const fill = db.prepare('SELECT * FROM fills WHERE id = ?').get(fillId) as FillRow;
    const position = getPosition(botId, sym) as PositionRow;
    return { fill, position };
  })();

  const cash = (getBot(botId) as BotRow).cash;
  publishFill(result.fill, notionalUsd, opts.reason ?? 'trade');
  logger.info(
    { bot: botId, symbol: sym, notional: notionalUsd, price: execPrice, fee, slip: slipUsd },
    'paper buy filled',
  );
  return { ok: true, fill: result.fill, position: result.position, cash };
}

/**
 * Sell `pctOfPosition` (1–100) of the bot's `symbol` position at live mid.
 * A partial sell that would leave < $0.50 of value closes the whole
 * position. Cash credit = qty×mid − slip − fee (realized P&L is implicit).
 */
export function sell(
  botId: number,
  symbol: string,
  pctOfPosition: number,
  opts: TradeOpts = {},
): TradeResult {
  const sym = symbol.toUpperCase();
  const bot = getBot(botId);
  if (!bot) return { ok: false, reason: 'bot_not_found' };
  if (!Number.isFinite(pctOfPosition) || pctOfPosition <= 0) {
    return { ok: false, reason: 'invalid_size', detail: String(pctOfPosition) };
  }
  const pct = Math.min(pctOfPosition, 100);

  const position = getPosition(botId, sym);
  if (!position || position.qty <= QTY_EPS) {
    return { ok: false, reason: 'no_position', detail: sym };
  }
  const mid = midPrice(sym);
  if (mid === null) return { ok: false, reason: 'no_price', detail: sym };

  let qtyToSell = position.qty * (pct / 100);
  const remainingValue = (position.qty - qtyToSell) * mid;
  const fullClose = pct >= 100 || remainingValue < DUST_USD;
  if (fullClose) qtyToSell = position.qty;

  const s = slipRate(sym);
  const notional = qtyToSell * mid;
  const slipUsd = notional * s;
  const fee = notional * FEE_RATE;
  const proceeds = notional - slipUsd - fee;
  const execPrice = mid * (1 - s);
  const ts = nowMs();

  const fill = db.transaction((): FillRow => {
    const info = db
      .prepare(
        `INSERT INTO fills (bot_id, decision_id, symbol, side, qty, price, fee, slip, ts)
         VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?)`,
      )
      .run(botId, opts.decisionId ?? null, sym, qtyToSell, execPrice, fee, slipUsd, ts);

    if (fullClose) {
      db.prepare('DELETE FROM positions WHERE bot_id = ? AND symbol = ?').run(botId, sym);
    } else {
      db.prepare('UPDATE positions SET qty = qty - ? WHERE bot_id = ? AND symbol = ?').run(
        qtyToSell,
        botId,
        sym,
      );
    }
    db.prepare('UPDATE bots SET cash = cash + ? WHERE id = ?').run(proceeds, botId);
    return db.prepare('SELECT * FROM fills WHERE id = ?').get(Number(info.lastInsertRowid)) as FillRow;
  })();

  const cash = (getBot(botId) as BotRow).cash;
  publishFill(fill, notional, opts.reason ?? 'trade');
  logger.info(
    { bot: botId, symbol: sym, qty: qtyToSell, price: execPrice, fee, slip: slipUsd, fullClose, reason: opts.reason ?? 'trade' },
    'paper sell filled',
  );
  return { ok: true, fill, position: getPosition(botId, sym) ?? null, cash };
}

// ── equity, snapshots, drawdown ────────────────────────────────────────

/**
 * equity = cash + Σ qty×mid. Positions with no price at all (should not
 * happen after warm-up) are marked at avg entry rather than dropped.
 */
export function equity(botId: number): number | null {
  const bot = getBot(botId);
  if (!bot) return null;
  let eq = bot.cash;
  for (const p of getPositions(botId)) {
    const mid = midPrice(p.symbol);
    eq += p.qty * (mid ?? p.avg_entry);
  }
  return eq;
}

/** Write one equity snapshot row for every bot. Returns rows written. */
export function snapshotEquityAll(): number {
  const bots = db.prepare('SELECT id FROM bots').all() as Array<{ id: number }>;
  const ts = nowMs();
  let written = 0;
  for (const { id } of bots) {
    const eq = equity(id);
    if (eq === null) continue;
    db.prepare(
      'INSERT OR REPLACE INTO equity_snapshots (bot_id, ts, equity) VALUES (?, ?, ?)',
    ).run(id, ts, eq);
    written += 1;
  }
  return written;
}

export interface DrawdownInfo {
  equity: number;
  highWaterMark: number;
  drawdownPct: number; // 0..100, from HWM
}

/**
 * Drawdown derived (not stored): HWM = max(bankroll_start, snapshot max,
 * current equity).
 */
export function getDrawdown(botId: number): DrawdownInfo | null {
  const bot = getBot(botId);
  const eq = equity(botId);
  if (!bot || eq === null) return null;
  const row = db
    .prepare('SELECT MAX(equity) AS m FROM equity_snapshots WHERE bot_id = ?')
    .get(botId) as { m: number | null };
  const hwm = Math.max(bot.bankroll_start, row.m ?? 0, eq);
  const drawdownPct = hwm > 0 ? ((hwm - eq) / hwm) * 100 : 0;
  return { equity: eq, highWaterMark: hwm, drawdownPct };
}

let equityTask: ScheduledTask | null = null;

/** Hourly (at :00) equity snapshot cron. */
export function startEquityCron(): void {
  if (equityTask) return;
  equityTask = cron.schedule('0 * * * *', () => {
    try {
      const n = snapshotEquityAll();
      if (n > 0) logger.info({ bots: n }, 'equity snapshots written');
    } catch (err) {
      logger.error({ err }, 'equity snapshot cron failed');
    }
  });
  logger.info('equity snapshot cron started (hourly)');
}

export function stopEquityCron(): void {
  if (equityTask) {
    equityTask.stop();
    equityTask = null;
  }
}

// ── guard-state builder (I/O lives here, not in risk-guards) ───────────

export interface EngineGuardState {
  nowTs: number;
  cash: number;
  equity: number;
  lastFillTs: number | null;
  tradesToday: number;
  position: {
    qty: number;
    avgEntry: number;
    openedTs: number;
    valueUsd: number;
  } | null;
}

/**
 * Assemble the pure-guard `state` for a bot + target symbol. Phase 4 calls
 * this, then `checkAndClamp`, then `buy`/`sell`. `tradesToday` counts all
 * fills since UTC midnight (protector exits included — conservative).
 */
export function buildGuardState(botId: number, symbol: string | null): EngineGuardState | null {
  const bot = getBot(botId);
  const eq = equity(botId);
  if (!bot || eq === null) return null;
  const ts = nowMs();
  const dayStart = ts - (ts % 86_400_000);

  const last = db
    .prepare('SELECT MAX(ts) AS m FROM fills WHERE bot_id = ?')
    .get(botId) as { m: number | null };
  const today = db
    .prepare('SELECT COUNT(*) AS n FROM fills WHERE bot_id = ? AND ts >= ?')
    .get(botId, dayStart) as { n: number };

  let position: EngineGuardState['position'] = null;
  if (symbol) {
    const p = getPosition(botId, symbol);
    if (p && p.qty > QTY_EPS) {
      const mid = midPrice(p.symbol);
      position = {
        qty: p.qty,
        avgEntry: p.avg_entry,
        openedTs: p.opened_ts,
        valueUsd: p.qty * (mid ?? p.avg_entry),
      };
    }
  }

  return {
    nowTs: ts,
    cash: bot.cash,
    equity: eq,
    lastFillTs: last.m,
    tradesToday: today.n,
    position,
  };
}
