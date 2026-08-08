/**
 * Unit tests for paper/risk-guards.ts (IMPL-2 §2.3 acceptance).
 * Plain tsx + node:assert (vitest not in the workspace; see STATUS.md).
 * Every PLAN §10 rule has a veto/clamp case. Run: pnpm tsx scripts/test-guards.ts
 */

import assert from 'node:assert/strict';
import {
  GUARD_DEFAULTS,
  checkAndClamp,
  resolveGuardConfig,
  type GuardDecision,
  type GuardResult,
  type GuardState,
} from '../apps/server/src/paper/risk-guards.js';

const bot = { id: 1, config: { ...GUARD_DEFAULTS } };
const NOW = 1_754_600_000_000;

function state(over: Partial<GuardState> = {}): GuardState {
  return {
    nowTs: NOW,
    cash: 1000,
    equity: 1000,
    lastFillTs: null,
    tradesToday: 0,
    position: null,
    ...over,
  };
}

function decision(over: Partial<GuardDecision> = {}): GuardDecision {
  return {
    action: 'buy',
    symbol: 'BTCUSDT',
    size_pct: 10,
    confidence: 80,
    sl_pct: null,
    tp_pct: null,
    ...over,
  };
}

function expectVeto(res: GuardResult, reason: string, label: string): void {
  assert.equal(res.verdict, 'veto', `${label}: expected veto, got ${JSON.stringify(res)}`);
  if (res.verdict === 'veto') assert.equal(res.reason, reason, `${label}: wrong reason ${res.reason}`);
  passed(label);
}

function expectPass(res: GuardResult, label: string): Extract<GuardResult, { verdict: 'pass' }> {
  assert.equal(res.verdict, 'pass', `${label}: expected pass, got ${JSON.stringify(res)}`);
  passed(label);
  return res as Extract<GuardResult, { verdict: 'pass' }>;
}

let count = 0;
function passed(label: string): void {
  count += 1;
  console.log(`  ok ${count}: ${label}`);
}

const HELD_POS = { qty: 0.001, avgEntry: 100_000, openedTs: NOW - 120 * 60_000, valueUsd: 100 };

// ── §10: min confidence 65 ─────────────────────────────────────────────
expectVeto(checkAndClamp(bot, decision({ confidence: 64.9 }), state()), 'min_confidence', 'confidence 64.9 vetoed');
expectPass(checkAndClamp(bot, decision({ confidence: 65 }), state()), 'confidence 65 passes');

// ── §10: cooldown 30 min after any fill ────────────────────────────────
expectVeto(
  checkAndClamp(bot, decision(), state({ lastFillTs: NOW - 29 * 60_000 })),
  'cooldown',
  'buy 29min after fill vetoed',
);
expectPass(
  checkAndClamp(bot, decision(), state({ lastFillTs: NOW - 31 * 60_000 })),
  'buy 31min after fill passes',
);
expectVeto(
  checkAndClamp(
    bot,
    decision({ action: 'sell', size_pct: 100 }),
    state({ lastFillTs: NOW - 10 * 60_000, position: HELD_POS }),
  ),
  'cooldown',
  'sell inside cooldown vetoed',
);

// ── §10: min hold 60 min before selling ────────────────────────────────
expectVeto(
  checkAndClamp(
    bot,
    decision({ action: 'sell', size_pct: 100 }),
    state({ position: { ...HELD_POS, openedTs: NOW - 59 * 60_000 } }),
  ),
  'min_hold',
  'sell at 59min hold vetoed',
);
expectPass(
  checkAndClamp(
    bot,
    decision({ action: 'sell', size_pct: 100 }),
    state({ position: { ...HELD_POS, openedTs: NOW - 61 * 60_000 } }),
  ),
  'sell at 61min hold passes',
);

// ── §10: max 6 trades/day ──────────────────────────────────────────────
expectVeto(checkAndClamp(bot, decision(), state({ tradesToday: 6 })), 'max_trades_day', '7th trade vetoed');
expectPass(checkAndClamp(bot, decision(), state({ tradesToday: 5 })), '6th trade passes');

// ── §10: one position per symbol ───────────────────────────────────────
expectVeto(
  checkAndClamp(bot, decision(), state({ position: HELD_POS })),
  'position_exists',
  'buy while holding symbol vetoed',
);

// ── §10: max 30% of equity per symbol (clamp) ─────────────────────────
{
  const r = expectPass(
    checkAndClamp(bot, decision({ size_pct: 100 }), state({ cash: 1000, equity: 1000 })),
    'buy 100% of cash clamped to 30% of equity',
  );
  assert.ok(r.clamped.notionalUsd !== null && Math.abs(r.clamped.notionalUsd - 300) < 1e-9,
    `expected $300, got ${r.clamped.notionalUsd}`);
}

// ── §10: max = available cash (clamp incl. fee/slip headroom) ─────────
{
  const r = expectPass(
    checkAndClamp(bot, decision({ size_pct: 100 }), state({ cash: 100, equity: 1000 })),
    'buy clamped to available cash w/ fee headroom',
  );
  assert.ok(r.clamped.notionalUsd !== null && r.clamped.notionalUsd <= 100 / 1.002 + 1e-9,
    `expected ≤ ${100 / 1.002}, got ${r.clamped.notionalUsd}`);
}

// ── §10: min $10 notional ──────────────────────────────────────────────
expectVeto(
  checkAndClamp(bot, decision({ size_pct: 1 }), state({ cash: 500, equity: 500 })),
  'below_min_notional',
  '$5 buy vetoed',
);

// ── §10: SL clamp [−15,−1], default −5 ────────────────────────────────
{
  const clampedSl = (sl: number | null, label: string, expected: number): void => {
    const r = expectPass(checkAndClamp(bot, decision({ sl_pct: sl }), state()), label);
    assert.equal(r.clamped.slPct, expected, `${label}: got ${r.clamped.slPct}`);
  };
  clampedSl(-20, 'SL −20 clamped to −15', -15);
  clampedSl(-0.5, 'SL −0.5 clamped to −1', -1);
  clampedSl(5, 'SL +5 sign-normalized to −5', -5);
  clampedSl(null, 'SL omitted defaults to −5', -5);
}

// ── §10: TP clamp [+2,+50], default +10 ───────────────────────────────
{
  const clampedTp = (tp: number | null, label: string, expected: number): void => {
    const r = expectPass(checkAndClamp(bot, decision({ tp_pct: tp }), state()), label);
    assert.equal(r.clamped.tpPct, expected, `${label}: got ${r.clamped.tpPct}`);
  };
  clampedTp(100, 'TP 100 clamped to 50', 50);
  clampedTp(1, 'TP 1 clamped to 2', 2);
  clampedTp(null, 'TP omitted defaults to +10', 10);
}

// ── contract edges ─────────────────────────────────────────────────────
{
  const r = expectPass(checkAndClamp(bot, decision({ action: 'wait', symbol: null }), state()), 'wait passes through');
  assert.equal(r.clamped.action, 'wait');
}
expectVeto(
  checkAndClamp(bot, decision({ action: 'sell', size_pct: 100 }), state({ position: null })),
  'no_position',
  'sell with no position vetoed',
);
expectVeto(checkAndClamp(bot, decision({ symbol: null }), state()), 'no_symbol', 'buy without symbol vetoed');
expectVeto(checkAndClamp(bot, decision({ size_pct: null }), state()), 'no_size', 'buy without size vetoed');
{
  const r = expectPass(
    checkAndClamp(bot, decision({ action: 'sell', size_pct: 250 }), state({ position: HELD_POS })),
    'sell size 250% clamped to 100%',
  );
  assert.equal(r.clamped.sizePct, 100);
}

// ── config resolution ──────────────────────────────────────────────────
{
  const cfg = resolveGuardConfig(JSON.stringify({ min_confidence: 70, cooldown_min: 15 }));
  assert.equal(cfg.minConfidence, 70);
  assert.equal(cfg.cooldownMin, 15);
  assert.equal(cfg.maxTradesDay, 6);
  passed('resolveGuardConfig merges bot config over defaults');
  const bad = resolveGuardConfig('not json');
  assert.deepEqual(bad, GUARD_DEFAULTS);
  passed('resolveGuardConfig tolerates garbage');
}

console.log(`\nALL ${count} GUARD TESTS PASSED`);
