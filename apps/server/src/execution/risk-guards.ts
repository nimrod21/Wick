/**
 * Risk guards (legacy pipeline, kept as adaptation base).
 *
 * Phase 2 rewires this — Wick's per-bot guards (min confidence, cooldown,
 * min-hold, max trades/day, max position %, SL/TP clamps, drawdown kill)
 * replace these portfolio-level rules, reading per-bot config instead of
 * the old `kv` table. Kept as the adaptation base. All enforced once
 * centrally in `order-manager` before any broker.placeOrder call.
 */

import type { PlaceOrderRequest } from '@wick/shared';
import { db } from '../db/client.js';
import { nowSec } from '../util/time.js';

export type GuardResult =
  | { ok: true }
  | { ok: false; reason: string; detail?: Record<string, unknown> };

// ── defaults ───────────────────────────────────────────────────────────

const DEFAULT_MAX_NOTIONAL = 500;
const DEFAULT_MAX_OPEN_POSITIONS = 1;
const DEFAULT_DAILY_LOSS_CAP = -1000;
const DEFAULT_COOLDOWN_SECONDS = 10;

// ── kv helpers ─────────────────────────────────────────────────────────

function kvGet(key: string): string | null {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as
    | { v: string }
    | undefined;
  return row ? row.v : null;
}

function kvNumber(key: string, fallback: number): number {
  const raw = kvGet(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// ── signals / state reads ──────────────────────────────────────────────

/** Latest 1m close — our best proxy for mark price. Null if no data. */
export function lastClose(assetId: number): number | null {
  const row = db
    .prepare(
      `SELECT c FROM candles_1m WHERE asset_id = ? ORDER BY ts DESC LIMIT 1`,
    )
    .get(assetId) as { c: number } | undefined;
  return row ? row.c : null;
}

/**
 * Open positions for an asset = any position row with |qty| > epsilon
 * across all brokers. A user with a paper BTC long shouldn't also be
 * allowed to open a second paper BTC long under the default max=1.
 */
export function countOpenPositions(assetId: number): number {
  const rows = db
    .prepare(`SELECT qty FROM positions WHERE asset_id = ?`)
    .all(assetId) as Array<{ qty: number }>;
  let n = 0;
  for (const r of rows) {
    if (Math.abs(r.qty) > 1e-9) n += 1;
  }
  return n;
}

/**
 * Most recent order for an asset across any status. Used for cooldown —
 * we don't care whether it filled or was rejected, just that a request
 * was made recently.
 */
export function lastOrderForAsset(assetId: number): { created_at: number } | null {
  const row = db
    .prepare(
      `SELECT created_at FROM orders WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(assetId) as { created_at: number } | undefined;
  return row ?? null;
}

/**
 * Realized PnL since midnight UTC plus unrealized PnL marked to the
 * latest 1m close. This is intentionally broker-agnostic: the daily
 * loss cap is a portfolio rule.
 */
export function todaysPnL(): number {
  const startOfDayUtc = Math.floor(Date.now() / 86_400_000) * 86_400;

  // Realized: any realized_pnl accumulated since midnight. We approximate
  // "since midnight" by looking at filled orders completed today and the
  // current realized_pnl column. Since `positions.realized_pnl` is
  // cumulative, we subtract the yesterday snapshot if present. For MVP
  // just use the cumulative realized_pnl — close enough for the daily
  // loss cap MVP; a snapshot cron at midnight can refine later.
  const realizedRow = db
    .prepare(`SELECT COALESCE(SUM(realized_pnl), 0) AS r FROM positions`)
    .get() as { r: number };
  const realized = realizedRow.r;

  // Unrealized: for each position, (mark - avg) * qty. Skip if no mark.
  const positions = db
    .prepare(
      `SELECT asset_id, qty, avg_entry_price FROM positions WHERE qty != 0`,
    )
    .all() as Array<{ asset_id: number; qty: number; avg_entry_price: number }>;
  let unrealized = 0;
  for (const p of positions) {
    const mark = lastClose(p.asset_id);
    if (mark === null) continue;
    unrealized += (mark - p.avg_entry_price) * p.qty;
  }

  // Realized-today subset: orders completed today with a fill. We count
  // realized PnL implicitly via positions.realized_pnl above; the
  // completed-today filter is only used to reset the "today" baseline
  // in the future. For the loss cap MVP, we rely on cumulative realized
  // + current unrealized.
  void startOfDayUtc; // kept for future snapshotting
  return realized + unrealized;
}

// ── guard pipeline ─────────────────────────────────────────────────────

function fail(reason: string, detail?: Record<string, unknown>): GuardResult {
  return { ok: false, reason, detail };
}

export async function guard(req: PlaceOrderRequest): Promise<GuardResult> {
  // 1. Kill switch — a manual "stop all trading" toggle. Short-circuits
  // before any DB reads beyond the kv lookup it already did.
  if (kvGet('kill_switch') === 'true') {
    return fail('kill_switch_active');
  }

  // 2. Per-order max notional. We use the latest 1m close as the mark;
  // if there's no candle yet, we're reading nothing and cannot guard —
  // reject safely.
  const mark = lastClose(req.assetId);
  if (mark === null) {
    return fail('no_price_reference', { assetId: req.assetId });
  }
  const notional = req.qty * mark;
  const maxNotional = kvNumber('max_order_notional', DEFAULT_MAX_NOTIONAL);
  if (notional > maxNotional) {
    return fail('notional_exceeds_max', { notional, max: maxNotional });
  }

  // 3. Max open positions per asset — only applies to buys (opening new
  // longs). Sells to flatten are always allowed.
  if (req.side === 'buy') {
    const max = kvNumber('max_open_positions_per_asset', DEFAULT_MAX_OPEN_POSITIONS);
    const open = countOpenPositions(req.assetId);
    if (open >= max) {
      return fail('max_positions_exceeded', { open, max });
    }
  }

  // 4. Daily loss cap. Cap is stored as a negative number (e.g. -1000
  // means "stop after losing $1000"). If current PnL has dropped to or
  // below the cap, reject.
  const cap = kvNumber('daily_loss_cap', DEFAULT_DAILY_LOSS_CAP);
  const pnl = todaysPnL();
  if (pnl <= cap) {
    return fail('daily_loss_cap_reached', { pnl, cap });
  }

  // 5. Cooldown per asset. Prevents accidental double-submits and bot
  // runaway loops.
  const cooldown = kvNumber('order_cooldown_seconds', DEFAULT_COOLDOWN_SECONDS);
  const last = lastOrderForAsset(req.assetId);
  if (last && nowSec() - last.created_at < cooldown) {
    return fail('cooldown_active', {
      remainingSec: cooldown - (nowSec() - last.created_at),
    });
  }

  // 6. Frontend confirmation flag. Last because the UI-originated
  // request is the only one that carries it; bots will set it too.
  if (!req.confirmed) {
    return fail('confirmation_required');
  }

  return { ok: true };
}
