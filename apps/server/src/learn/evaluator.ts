/**
 * Outcome evaluator (IMPL-3 §5.1, PLAN §11.1) — judges decisions in hindsight.
 *
 * Cron every 15 min: every decision past a horizon (1h / 4h / 24h) that has no
 * `outcomes` row yet gets a forward return and a score in [-1, 1].
 *
 * NO LOOK-AHEAD (IMPL-3 pitfall #1). Prices come from the `candles` 1h table
 * and a candle's `ts` is its OPEN time, so the close of candle T is the price
 * at T+1h. `priceAt(symbol, t)` therefore takes the newest candle whose CLOSE
 * happened at or before t — never a candle still forming at t. A decision at
 * 14:00:00 (taken on the 13:00 candle's close) prices at 14:00 and its 1h
 * forward price is the 14:00 candle's close, i.e. 15:00 — exactly the pitfall's
 * requirement.
 *
 * Scoring is PLAN §11 verbatim; see `scoreFor`. The 4h horizon is primary:
 * completing it publishes an `outcome` bus event, which is what drives
 * indicator stats (5.2) and journal reflections (5.3).
 *
 * All SQL is prepared inside functions (module-level prepare crashes on a
 * fresh DB before migrations run). All ts values are UTC ms.
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { OutcomeEvent } from '@wick/shared';
import { db } from '../db/client.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../util/logger.js';
import { nowMs } from '../util/time.js';

/** Forward returns are read off the 1h candle series. */
export const EVAL_TF = '1h';
const CANDLE_MS = 3_600_000;

/** Symbol-less waits are scored against BTC (PLAN §11). */
export const FALLBACK_SYMBOL = 'BTCUSDT';

export type Horizon = '1h' | '4h' | '24h';

export const HORIZONS: ReadonlyArray<{ name: Horizon; ms: number }> = [
  { name: '1h', ms: CANDLE_MS },
  { name: '4h', ms: 4 * CANDLE_MS },
  { name: '24h', ms: 24 * CANDLE_MS },
];

/** The horizon indicator stats + journal learn from (PLAN §11). */
export const PRIMARY_HORIZON: Horizon = '4h';

/**
 * How stale a candle close may be relative to the instant we want a price
 * for. A wake can happen mid-candle (a trigger at 14:23 prices at 14:00), so
 * one candle of slack is structural; two allows exactly one missing candle
 * before we give up and let the hourly self-heal backfill it.
 */
export const GAP_TOLERANCE_MS = 2 * CANDLE_MS;

/** Round-trip cost charged against a buy's forward return (PLAN §11). */
export const ROUND_TRIP_FEE_PCT = 0.25;

/** Return scale: ±2% saturates the score (PLAN §11). */
export const RETURN_SCALE_PCT = 2;

/** Batch cap per (horizon × run) — keeps each cron tick's transaction short. */
const BATCH_LIMIT = 500;

export type ScoredAction = 'buy' | 'sell' | 'wait';

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

// ── scoring (PLAN §11.1, verbatim) ─────────────────────────────────────

/**
 * Score a decision given its forward return in PERCENT.
 *
 *  buy  — clamp(fwd_ret / 2%, -1, 1) minus the 0.25% round-trip fee. The fee
 *         is charged in RETURN space (net return = gross - fees) before the
 *         ±2% scaling: "being right small still costs".
 *  sell — clamp(-fwd_ret / 2%, -1, 1). Selling before a drop is a win.
 *  wait — +0.3 when there was nothing to catch (|fwd_ret| < 0.3%) or buying
 *         would have lost (fwd_ret < -0.3%); -0.3 when a real move was missed
 *         (fwd_ret > +1%); 0 in between. Waiting is rewarded, chronic missing
 *         is not.
 */
export function scoreFor(action: ScoredAction, fwdRetPct: number): number {
  switch (action) {
    case 'buy':
      return clamp((fwdRetPct - ROUND_TRIP_FEE_PCT) / RETURN_SCALE_PCT, -1, 1);
    case 'sell':
      return clamp(-fwdRetPct / RETURN_SCALE_PCT, -1, 1);
    case 'wait':
      if (Math.abs(fwdRetPct) < 0.3) return 0.3;
      if (fwdRetPct < -0.3) return 0.3;
      if (fwdRetPct > 1) return -0.3;
      return 0;
  }
}

/**
 * How a decision row is SCORED. Vetoed decisions score as `wait` (no trade
 * happened) while their `action`/`status` columns keep the original intent —
 * IMPL-3 pitfall #2: distinguishable in stats queries.
 */
export function scoredActionOf(action: string, status: string): ScoredAction {
  if (status === 'vetoed') return 'wait';
  return action === 'buy' || action === 'sell' ? action : 'wait';
}

// ── prices (no look-ahead) ─────────────────────────────────────────────

export interface PricePoint {
  price: number;
  /** When that price was actually known (candle open ts + 1h). */
  closeTs: number;
}

/**
 * Newest 1h candle CLOSE at or before `ts`. Returns null when the series has
 * no candle within GAP_TOLERANCE_MS of `ts` (gap — skip, self-heal + a later
 * cron run pick it up).
 */
export function priceAt(symbol: string, ts: number): PricePoint | null {
  const row = db
    .prepare(
      `SELECT ts, c FROM candles
        WHERE symbol = ? AND tf = ? AND ts <= ?
        ORDER BY ts DESC LIMIT 1`,
    )
    .get(symbol, EVAL_TF, ts - CANDLE_MS) as { ts: number; c: number } | undefined;
  if (!row) return null;
  const closeTs = row.ts + CANDLE_MS;
  if (ts - closeTs > GAP_TOLERANCE_MS) return null;
  return { price: row.c, closeTs };
}

/**
 * Forward return in percent between the decision instant and decision+horizon.
 * Null when either leg is missing from the candle store.
 */
export function forwardReturnPct(
  symbol: string,
  decisionTs: number,
  horizonMs: number,
): number | null {
  const base = priceAt(symbol, decisionTs);
  if (!base || base.price <= 0) return null;
  const fwd = priceAt(symbol, decisionTs + horizonMs);
  if (!fwd) return null;
  // Belt and braces against a stale-price pair: the forward leg must be a
  // LATER observation than the base leg, or there is no forward at all.
  if (fwd.closeTs <= base.closeTs) return null;
  return ((fwd.price - base.price) / base.price) * 100;
}

// ── the cron pass ──────────────────────────────────────────────────────

interface PendingRow {
  id: number;
  bot_id: number;
  ts: number;
  action: string;
  symbol: string | null;
  status: string;
}

/**
 * Decisions older than `horizonMs` with no outcome row for that horizon.
 * `llm_failed` rows are excluded: no model answered, so there is no judgement
 * to make (IMPL-3 §5.1 lists `executed` + `vetoed`).
 */
function pending(horizon: Horizon, horizonMs: number, ts: number): PendingRow[] {
  return db
    .prepare(
      `SELECT d.id, d.bot_id, d.ts, d.action, d.symbol, d.status
         FROM decisions d
        WHERE d.status IN ('executed', 'vetoed')
          AND d.ts <= ?
          AND NOT EXISTS (
                SELECT 1 FROM outcomes o
                 WHERE o.decision_id = d.id AND o.horizon = ?)
        ORDER BY d.ts
        LIMIT ?`,
    )
    .all(ts - horizonMs, horizon, BATCH_LIMIT) as PendingRow[];
}

export interface EvaluatorRun {
  written: number;
  skipped: number;
  byHorizon: Record<Horizon, number>;
}

/** Last completed pass (ops surface — GET /health, `pnpm doctor`). */
let lastRun: { ts: number; run: EvaluatorRun } | null = null;

export function lastEvaluatorRun(): { ts: number; run: EvaluatorRun } | null {
  return lastRun;
}

/**
 * One evaluation pass. Safe to call any time — it is idempotent (the
 * `outcomes` PK plus the NOT EXISTS filter) and self-healing (a decision
 * skipped for a candle gap is retried on every later run).
 */
export function evaluatePending(ts: number = nowMs()): EvaluatorRun {
  const run: EvaluatorRun = { written: 0, skipped: 0, byHorizon: { '1h': 0, '4h': 0, '24h': 0 } };
  const insert = db.prepare(
    `INSERT INTO outcomes (decision_id, horizon, fwd_ret_pct, score, evaluated_ts)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(decision_id, horizon) DO NOTHING`,
  );
  const events: OutcomeEvent[] = [];

  for (const { name: horizon, ms } of HORIZONS) {
    for (const row of pending(horizon, ms, ts)) {
      const symbol = row.symbol ?? FALLBACK_SYMBOL;
      const fwdRet = forwardReturnPct(symbol, row.ts, ms);
      if (fwdRet === null) {
        run.skipped += 1;
        continue;
      }
      const scoredAs = scoredActionOf(row.action, row.status);
      const score = scoreFor(scoredAs, fwdRet);
      const info = insert.run(row.id, horizon, fwdRet, score, ts);
      if (info.changes === 0) continue; // raced with another pass
      run.written += 1;
      run.byHorizon[horizon] += 1;

      if (horizon === PRIMARY_HORIZON) {
        events.push({
          id: row.id,
          ts,
          source: 'evaluator',
          kind: 'outcome',
          decisionId: row.id,
          botId: row.bot_id,
          horizon,
          symbol,
          action: (row.action === 'buy' || row.action === 'sell' ? row.action : 'wait'),
          scoredAs,
          status: row.status as OutcomeEvent['status'],
          fwdRetPct: fwdRet,
          score,
        });
      }
    }
  }

  // Emitted after the writes so subscribers (indicator stats, journal, SSE)
  // always see a committed outcomes row.
  for (const evt of events) eventBus.emit(evt);

  lastRun = { ts: nowMs(), run };
  if (run.written > 0 || run.skipped > 0) {
    logger.info(
      { written: run.written, skipped: run.skipped, byHorizon: run.byHorizon },
      'evaluator pass complete',
    );
  }
  return run;
}

// ── lifecycle ──────────────────────────────────────────────────────────

let task: ScheduledTask | null = null;

/** PLAN §11: cron every 15 minutes. */
export function startEvaluatorCron(): void {
  if (task) return;
  task = cron.schedule('*/15 * * * *', () => {
    try {
      evaluatePending();
    } catch (err) {
      logger.error({ err }, 'evaluator cron failed');
    }
  });
  logger.info('evaluator started (*/15 min)');
}

export function stopEvaluatorCron(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
