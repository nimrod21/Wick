/**
 * Risk guards (IMPL-2 §2.3) — PLAN §10, enforced in code, per-bot config.
 *
 * `checkAndClamp` is a PURE function: no DB, no clock, no imports with
 * side effects. All state (last fill ts, trades today, open position) is
 * passed in — `engine.buildGuardState()` assembles it. The protector
 * bypasses these guards entirely (SL/TP exits are never vetoed).
 *
 * Rules (defaults, per-bot override via config_json):
 *   - min confidence 65 (below → veto, caller records as wait)
 *   - cooldown 30 min after any fill
 *   - min hold 60 min before selling (SL/TP exempt — protector path)
 *   - max 6 trades/day
 *   - max 30% of equity per symbol; one position per symbol (no adds)
 *   - buy notional: min $10, max available cash (fee+slip headroom kept)
 *   - SL default −5% clamped to [−15,−1]; TP default +10% clamped to [+2,+50]
 */

export interface GuardConfig {
  minConfidence: number;
  cooldownMin: number;
  minHoldMin: number;
  maxTradesDay: number;
  maxPosPct: number;      // % of equity per symbol
  defaultSlPct: number;   // negative
  defaultTpPct: number;   // positive
}

export const GUARD_DEFAULTS: GuardConfig = {
  minConfidence: 65,
  cooldownMin: 30,
  minHoldMin: 60,
  maxTradesDay: 6,
  maxPosPct: 30,
  defaultSlPct: -5,
  defaultTpPct: 10,
};

export const SL_CLAMP: readonly [number, number] = [-15, -1];
export const TP_CLAMP: readonly [number, number] = [2, 50];
export const MIN_NOTIONAL_USD = 10;
/** Headroom divisor so clamped max notional + fee (0.1%) + worst slip (0.1%) ≤ cash. */
const CASH_HEADROOM = 1.002;

/**
 * Map a bot's `config_json` (snake_case keys per PLAN §6) onto GuardConfig,
 * falling back to defaults. Pure; tolerant of missing/garbage config.
 */
export function resolveGuardConfig(configJson: string | null | undefined): GuardConfig {
  let raw: Record<string, unknown> = {};
  if (configJson) {
    try {
      const parsed: unknown = JSON.parse(configJson);
      if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
    } catch {
      /* defaults */
    }
  }
  const num = (key: string, fallback: number): number => {
    const v = raw[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };
  return {
    minConfidence: num('min_confidence', GUARD_DEFAULTS.minConfidence),
    cooldownMin: num('cooldown_min', GUARD_DEFAULTS.cooldownMin),
    minHoldMin: num('min_hold_min', GUARD_DEFAULTS.minHoldMin),
    maxTradesDay: num('max_trades_day', GUARD_DEFAULTS.maxTradesDay),
    maxPosPct: num('max_pos_pct', GUARD_DEFAULTS.maxPosPct),
    defaultSlPct: num('default_sl_pct', GUARD_DEFAULTS.defaultSlPct),
    defaultTpPct: num('default_tp_pct', GUARD_DEFAULTS.defaultTpPct),
  };
}

export interface GuardBot {
  id: number;
  config: GuardConfig;
}

/** LLM decision fields the guards care about (PLAN §7 contract). */
export interface GuardDecision {
  action: 'buy' | 'sell' | 'wait';
  symbol: string | null;
  size_pct: number | null;   // buy: % of cash; sell: % of position
  confidence: number;
  sl_pct: number | null;
  tp_pct: number | null;
}

export interface GuardState {
  nowTs: number;
  cash: number;
  equity: number;
  lastFillTs: number | null;
  tradesToday: number;
  /** Open position for decision.symbol, or null. */
  position: { qty: number; avgEntry: number; openedTs: number; valueUsd: number } | null;
}

export interface ClampedDecision {
  action: 'buy' | 'sell' | 'wait';
  symbol: string | null;
  /** buy: % of cash after clamping; sell: % of position (1–100). */
  sizePct: number | null;
  /** buy only: exact notional USD to pass to engine.buy(). */
  notionalUsd: number | null;
  slPct: number | null;
  tpPct: number | null;
}

export type GuardResult =
  | { verdict: 'pass'; clamped: ClampedDecision }
  | { verdict: 'veto'; reason: string; detail?: string };

const clampNum = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

function clampSl(slPct: number | null, cfg: GuardConfig): number {
  const v = slPct === null || !Number.isFinite(slPct) || slPct === 0 ? cfg.defaultSlPct : -Math.abs(slPct);
  return clampNum(v, SL_CLAMP[0], SL_CLAMP[1]);
}

function clampTp(tpPct: number | null, cfg: GuardConfig): number {
  const v = tpPct === null || !Number.isFinite(tpPct) || tpPct === 0 ? cfg.defaultTpPct : Math.abs(tpPct);
  return clampNum(v, TP_CLAMP[0], TP_CLAMP[1]);
}

function veto(reason: string, detail?: string): GuardResult {
  return { verdict: 'veto', reason, detail };
}

/**
 * Apply PLAN §10 to an LLM decision. Returns 'pass' with clamped values
 * (feed `clamped.notionalUsd` / `clamped.sizePct` to the engine) or
 * 'veto' with a machine-readable reason for the decision row.
 */
export function checkAndClamp(
  bot: GuardBot,
  decision: GuardDecision,
  state: GuardState,
): GuardResult {
  const cfg = bot.config;

  if (decision.action === 'wait') {
    return {
      verdict: 'pass',
      clamped: {
        action: 'wait',
        symbol: decision.symbol,
        sizePct: null,
        notionalUsd: null,
        slPct: null,
        tpPct: null,
      },
    };
  }

  // 1. Min confidence — below it, the trade becomes a wait (caller logs veto reason).
  if (!Number.isFinite(decision.confidence) || decision.confidence < cfg.minConfidence) {
    return veto('min_confidence', `${decision.confidence} < ${cfg.minConfidence}`);
  }

  // 2. Max trades/day.
  if (state.tradesToday >= cfg.maxTradesDay) {
    return veto('max_trades_day', `${state.tradesToday} >= ${cfg.maxTradesDay}`);
  }

  // 3. Cooldown after any fill.
  if (state.lastFillTs !== null) {
    const sinceMin = (state.nowTs - state.lastFillTs) / 60_000;
    if (sinceMin < cfg.cooldownMin) {
      return veto('cooldown', `${sinceMin.toFixed(1)}min < ${cfg.cooldownMin}min since last fill`);
    }
  }

  if (!decision.symbol) return veto('no_symbol');

  if (decision.action === 'buy') {
    // 4. One position per symbol — no adds via the LLM path.
    if (state.position !== null) {
      return veto('position_exists', decision.symbol);
    }
    if (decision.size_pct === null || !Number.isFinite(decision.size_pct) || decision.size_pct <= 0) {
      return veto('no_size');
    }
    const sizePct = clampNum(decision.size_pct, 1, 100);
    let notional = state.cash * (sizePct / 100);

    // 5. Max position per symbol: 30% of equity; and never more than cash
    //    (with fee+slip headroom so the engine never rejects a passed buy).
    const cap = Math.min((cfg.maxPosPct / 100) * state.equity, state.cash / CASH_HEADROOM);
    if (notional > cap) notional = cap;

    // 6. Min $10 notional after clamping.
    if (notional < MIN_NOTIONAL_USD) {
      return veto('below_min_notional', `$${notional.toFixed(2)} < $${MIN_NOTIONAL_USD}`);
    }

    return {
      verdict: 'pass',
      clamped: {
        action: 'buy',
        symbol: decision.symbol,
        sizePct: (notional / state.cash) * 100,
        notionalUsd: notional,
        slPct: clampSl(decision.sl_pct, cfg),
        tpPct: clampTp(decision.tp_pct, cfg),
      },
    };
  }

  // action === 'sell'
  if (state.position === null) return veto('no_position', decision.symbol);

  // 7. Min hold before a voluntary sell (SL/TP protector exits bypass guards).
  const heldMin = (state.nowTs - state.position.openedTs) / 60_000;
  if (heldMin < cfg.minHoldMin) {
    return veto('min_hold', `${heldMin.toFixed(1)}min < ${cfg.minHoldMin}min`);
  }

  const sellPct =
    decision.size_pct === null || !Number.isFinite(decision.size_pct) || decision.size_pct <= 0
      ? 100
      : clampNum(decision.size_pct, 1, 100);

  return {
    verdict: 'pass',
    clamped: {
      action: 'sell',
      symbol: decision.symbol,
      sizePct: sellPct,
      notionalUsd: null,
      slPct: null,
      tpPct: null,
    },
  };
}
