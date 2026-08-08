/**
 * Phase 5 test suite (tsx + node:assert, same style as test-guards/llm/bots).
 *
 * Covers the IMPL-3 §5 acceptance list:
 *   - scoring formulas, pure and end-to-end (buy/sell/wait × up/flat/down)
 *   - `wait` fixtures: flat → +0.3, through a +2% move → −0.3
 *   - no look-ahead: forward price comes from candles AFTER the decision ts
 *   - backdated decision → evaluator writes 1h + 4h outcomes (24h not due)
 *   - vetoed decisions score as wait while staying distinguishable
 *   - indicator_stats accumulate live; weights frozen below 30 samples
 *   - auto-disable at 100 samples / 40% → gone from the next prompt, shadow
 *     votes still recorded
 *   - journal reflections; daily lesson call → ≤10 bullets → next decision's
 *     snapshot_json carries them; llm failure keeps the previous lessons
 *   - GET /api/stats/models aggregates
 *
 * Runs against the real DB on synthetic symbols (TEST*USDT) and test bots;
 * every row and every setting it touches is restored at the end.
 *
 *   pnpm tsx scripts/test-learn.ts
 */

import assert from 'node:assert/strict';
import { db } from '../apps/server/src/db/client.js';
import { runMigrations } from '../apps/server/src/db/migrate.js';
import { eventBus } from '../apps/server/src/core/event-bus.js';
import { setMarketWarm } from '../apps/server/src/market/market-state.js';
import { buildServer } from '../apps/server/src/api/server.js';
import { createBot, listBots, parseConfig } from '../apps/server/src/bots/bot-store.js';
import { buildBotSnapshot } from '../apps/server/src/bots/snapshot.js';
import { requestWake, resetRunner, waitForIdle } from '../apps/server/src/bots/bot-runner.js';
import { buildPrompt } from '../apps/server/src/llm/prompt.js';
import { resetStub, setStubScript } from '../apps/server/src/llm/adapters/stub.js';
import type { BotRow } from '../apps/server/src/paper/engine.js';
import {
  evaluatePending,
  forwardReturnPct,
  priceAt,
  scoreFor,
  scoredActionOf,
} from '../apps/server/src/learn/evaluator.js';
import {
  DISABLE_FLOOR,
  SAMPLE_FLOOR,
  laplaceHitRate,
  listIndicatorStats,
  recomputeWeights,
  recordOutcomeVotes,
  startIndicatorStats,
  stopIndicatorStats,
  voteHit,
} from '../apps/server/src/learn/indicator-stats.js';
import {
  compressLessons,
  getLessons,
  parseLessons,
  reflectionText,
  startJournal,
  stopJournal,
} from '../apps/server/src/learn/journal.js';

const STUB_ID = 'stub-learn';
const TEST_PREFIX = 'test-phase5-';
const SYMBOLS = { up: 'TEST1USDT', flat: 'TEST2USDT', down: 'TEST3USDT' } as const;
const H = 3_600_000;

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
}

// ── settings save/restore ──────────────────────────────────────────────

function readSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeSetting(key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

const SAVED = {
  registry: readSetting('providers.registry'),
  thresholds: readSetting('triggers.thresholds'),
};

function restoreSettings(): void {
  if (SAVED.registry !== null) writeSetting('providers.registry', SAVED.registry);
  if (SAVED.thresholds !== null) writeSetting('triggers.thresholds', SAVED.thresholds);
}

function useStubRegistry(): void {
  writeSetting(
    'providers.registry',
    JSON.stringify([
      {
        id: STUB_ID,
        baseUrl: 'stub://local',
        authStyle: 'none',
        adapter: 'stub',
        models: ['stub-model'],
        rpm: 100,
        rpd: 1000,
        enabled: true,
      },
    ]),
  );
}

function setThresholds(patch: Record<string, unknown>): void {
  const cur = JSON.parse(readSetting('triggers.thresholds') ?? '{}') as Record<string, unknown>;
  writeSetting('triggers.thresholds', JSON.stringify({ ...cur, ...patch }));
}

// ── synthetic market ───────────────────────────────────────────────────

/** Candle grid anchor: 30 hourly candles ending at the current hour. */
const NOW = Date.now();
const T0 = Math.floor((NOW - 30 * H) / H) * H;
/** Decision instant: 5 hours ago, exactly on a candle close. */
const DECISION_TS = T0 + 25 * H;

/**
 * Write a 30-candle 1h series for `symbol`. `closes[i]` is the close of the
 * candle OPENING at T0 + i*H — i.e. the price known at T0 + (i+1)*H.
 */
function seedCandles(symbol: string, closes: number[]): void {
  const ins = db.prepare(
    'INSERT OR REPLACE INTO candles (symbol, tf, ts, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < closes.length; i++) {
      const c = closes[i]!;
      ins.run(symbol, '1h', T0 + i * H, c, c, c, c, 1000);
    }
    // one 1m candle so paper-engine midPrice() can price the symbol
    const last = closes[closes.length - 1]!;
    ins.run(symbol, '1m', T0 + closes.length * H, last, last, last, last, 10);
  });
  tx();
}

/** Flat 100 everywhere, then the three prices the horizons actually read. */
function series(at24: number, at25: number, at28: number): number[] {
  const out = new Array<number>(30).fill(100);
  out[24] = at24;
  out[25] = at25;
  out[28] = at28;
  out[29] = at28;
  return out;
}

function seedIndicatorValues(symbol: string, votes: Record<string, string | null>): void {
  const ins = db.prepare(
    'INSERT OR REPLACE INTO indicator_values (symbol, tf, ts, name, value, vote) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const ts = T0 + 29 * H;
  const tx = db.transaction(() => {
    for (const [name, vote] of Object.entries(votes)) ins.run(symbol, '1h', ts, name, 1, vote);
  });
  tx();
}

// ── synthetic decisions ────────────────────────────────────────────────

interface DecisionSeed {
  botId: number;
  symbol: string | null;
  action: 'buy' | 'sell' | 'wait';
  status?: 'executed' | 'vetoed' | 'llm_failed';
  ts?: number;
  snapshot?: unknown;
  provider?: string | null;
  model?: string | null;
  confidence?: number;
  triggerType?: string;
}

function seedDecision(s: DecisionSeed): number {
  const info = db
    .prepare(
      `INSERT INTO decisions
         (bot_id, ts, trigger_type, trigger_detail, snapshot_json, action, symbol, size_pct,
          confidence, reasoning, sl_pct, tp_pct, provider, model, latency_ms, status, veto_reason)
       VALUES (?, ?, ?, 'synthetic', ?, ?, ?, ?, ?, 'synthetic test decision', NULL, NULL, ?, ?, 120, ?, NULL)`,
    )
    .run(
      s.botId,
      s.ts ?? DECISION_TS,
      s.triggerType ?? 'scheduled',
      s.snapshot === undefined ? null : JSON.stringify(s.snapshot),
      s.action,
      s.symbol,
      s.action === 'wait' ? null : 25,
      s.confidence ?? 70,
      s.provider ?? null,
      s.model ?? null,
      s.status ?? 'executed',
    );
  return Number(info.lastInsertRowid);
}

function outcomeOf(decisionId: number, horizon: string): { fwd_ret_pct: number; score: number } | undefined {
  return db
    .prepare('SELECT fwd_ret_pct, score FROM outcomes WHERE decision_id = ? AND horizon = ?')
    .get(decisionId, horizon) as { fwd_ret_pct: number; score: number } | undefined;
}

// ── bookkeeping ────────────────────────────────────────────────────────

const otherBotStatuses = new Map<number, string>();

function quiesceOtherBots(): void {
  for (const bot of listBots()) {
    if (bot.name.startsWith(TEST_PREFIX)) continue;
    otherBotStatuses.set(bot.id, bot.status);
    db.prepare("UPDATE bots SET status = 'stopped' WHERE id = ?").run(bot.id);
  }
}

function restoreOtherBots(): void {
  for (const [id, status] of otherBotStatuses) {
    db.prepare('UPDATE bots SET status = ? WHERE id = ?').run(status, id);
  }
}

function purge(): void {
  const rows = db
    .prepare(`SELECT id FROM bots WHERE name LIKE '${TEST_PREFIX}%'`)
    .all() as Array<{ id: number }>;
  const tx = db.transaction((ids: number[]) => {
    for (const id of ids) {
      db.prepare('DELETE FROM outcomes WHERE decision_id IN (SELECT id FROM decisions WHERE bot_id = ?)').run(id);
      db.prepare('DELETE FROM decisions WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM fills WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM positions WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM equity_snapshots WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM trigger_log WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM indicator_stats WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM journal WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM lessons_current WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM bots WHERE id = ?').run(id);
    }
    for (const symbol of Object.values(SYMBOLS)) {
      db.prepare('DELETE FROM candles WHERE symbol = ?').run(symbol);
      db.prepare('DELETE FROM indicator_values WHERE symbol = ?').run(symbol);
    }
    db.prepare('DELETE FROM llm_usage WHERE provider = ?').run(STUB_ID);
  });
  tx(rows.map((r) => r.id));
}

function newBot(suffix: string, symbols: string[]): BotRow {
  return createBot({
    name: `${TEST_PREFIX}${suffix}`,
    bankroll: 1000,
    status: 'running',
    config: { symbols, provider_order: [STUB_ID], cadence_tf: '1h' },
  });
}

const SNAPSHOT_VOTES = {
  indicators: [
    { name: 'rsi14', value: 28, vote: 'bull', weight: 1, hitRate: null },
    { name: 'macd', value: -3, vote: 'bear', weight: 1, hitRate: null },
    { name: 'bollinger', value: 0.5, vote: 'neutral', weight: 1, hitRate: null },
    { name: 'atr14', value: 12, vote: null, weight: 1, hitRate: null },
    { name: 'volume_ratio', value: 3.1, vote: 'bull', weight: 1, hitRate: null },
  ],
  meta: { run: 1 },
};

// ── suite ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  runMigrations();
  console.log('phase 5 tests (learning: evaluator, indicator stats, journal)\n');

  purge();
  quiesceOtherBots();
  setMarketWarm();

  seedCandles(SYMBOLS.up, series(100, 102, 102)); // +2%
  seedCandles(SYMBOLS.flat, series(100, 100.1, 100.1)); // +0.1%
  seedCandles(SYMBOLS.down, series(100, 98, 98)); // −2%
  seedIndicatorValues(SYMBOLS.up, {
    rsi14: 'bull',
    macd: 'bear',
    bollinger: 'neutral',
    atr14: null,
    volume_ratio: 'bull',
    ema_trend: 'bull',
    funding: 'neutral',
    fear_greed: 'neutral',
  });

  // ── 1. pure scoring formulas ─────────────────────────────────────────
  await test('scoreFor: buy/sell/wait × up/flat/down match PLAN §11 exactly', () => {
    // buy: clamp((ret − 0.25% round-trip fee) / 2%, −1, 1)
    assert.equal(scoreFor('buy', 2), 0.875);
    assert.equal(scoreFor('buy', 0.1), -0.075);
    assert.equal(scoreFor('buy', -2), -1); // clamped
    assert.equal(scoreFor('buy', 10), 1); // clamped
    // sell: clamp(−ret / 2%, −1, 1) — no fee term in the plan
    assert.equal(scoreFor('sell', 2), -1);
    assert.equal(scoreFor('sell', 0.1), -0.05);
    assert.equal(scoreFor('sell', -2), 1);
    // wait: +0.3 nothing to catch / would have lost, −0.3 real move missed
    assert.equal(scoreFor('wait', 0.1), 0.3);
    assert.equal(scoreFor('wait', -2), 0.3);
    assert.equal(scoreFor('wait', 2), -0.3);
    assert.equal(scoreFor('wait', 0.5), 0); // in between: neither rewarded nor punished
    console.log('        buy(+2%)=0.875  sell(−2%)=1.00  wait(flat)=+0.30  wait(+2%)=−0.30');
  });

  await test('wait fixtures: flat market → +0.3, through a +2% move → −0.3', () => {
    assert.equal(scoreFor('wait', 0.0), 0.3);
    assert.equal(scoreFor('wait', 0.29), 0.3);
    assert.equal(scoreFor('wait', 1.01), -0.3);
    assert.equal(scoreFor('wait', 2.0), -0.3);
    assert.equal(scoredActionOf('buy', 'vetoed'), 'wait', 'vetoed must score as wait');
    assert.equal(scoredActionOf('buy', 'executed'), 'buy');
  });

  // ── 2. no look-ahead ─────────────────────────────────────────────────
  await test('no look-ahead: forward price comes from candles AFTER the decision ts', () => {
    const base = priceAt(SYMBOLS.up, DECISION_TS);
    assert.ok(base, 'no base price');
    assert.equal(base!.price, 100, 'base must be the close known AT the decision instant');
    assert.equal(base!.closeTs, DECISION_TS, 'base close must land exactly on the decision ts');

    const fwd1h = priceAt(SYMBOLS.up, DECISION_TS + H);
    assert.equal(fwd1h!.closeTs, DECISION_TS + H, '1h price must be the NEXT close, not the current one');
    assert.equal(fwd1h!.price, 102);

    assert.equal(forwardReturnPct(SYMBOLS.up, DECISION_TS, H), 2);
    assert.equal(forwardReturnPct(SYMBOLS.up, DECISION_TS, 4 * H), 2);
    // 24h has no candle that far ahead → null (self-heals on a later run)
    assert.equal(forwardReturnPct(SYMBOLS.up, DECISION_TS, 24 * H), null);
    console.log(
      `        decision @${new Date(DECISION_TS).toISOString().slice(11, 16)} base 100 → 1h close 102 (t+1h), 24h skipped`,
    );
  });

  // ── 3. evaluator end-to-end over all nine action × market combos ─────
  const scoreBot = newBot('score', [SYMBOLS.up]);
  const ids: Record<string, number> = {};
  await test('evaluator: backdated decisions get 1h + 4h outcomes with correct signed scores', () => {
    for (const [market, symbol] of Object.entries(SYMBOLS)) {
      for (const action of ['buy', 'sell', 'wait'] as const) {
        ids[`${market}_${action}`] = seedDecision({ botId: scoreBot.id, symbol, action });
      }
    }
    ids.vetoed = seedDecision({ botId: scoreBot.id, symbol: SYMBOLS.up, action: 'buy', status: 'vetoed' });
    ids.failed = seedDecision({ botId: scoreBot.id, symbol: SYMBOLS.up, action: 'wait', status: 'llm_failed' });

    // 9 action×market combos + 1 vetoed = 10 scorable decisions × 2 due
    // horizons. The llm_failed row is deliberately NOT judged.
    const run = evaluatePending();
    assert.equal(run.written, 20, `expected 20 outcome rows, got ${run.written}`);
    assert.equal(run.byHorizon['1h'], 10);
    assert.equal(run.byHorizon['4h'], 10);
    assert.equal(run.byHorizon['24h'], 0, '24h must not be evaluated yet (not due / no candles)');

    const expected: Record<string, number> = {
      up_buy: 0.875, up_sell: -1, up_wait: -0.3,
      flat_buy: -0.075, flat_sell: -0.05, flat_wait: 0.3,
      down_buy: -1, down_sell: 1, down_wait: 0.3,
    };
    for (const [key, want] of Object.entries(expected)) {
      for (const horizon of ['1h', '4h']) {
        const o = outcomeOf(ids[key]!, horizon);
        assert.ok(o, `${key} has no ${horizon} outcome`);
        assert.ok(Math.abs(o!.score - want) < 1e-9, `${key} ${horizon}: score ${o!.score} != ${want}`);
      }
      assert.equal(outcomeOf(ids[key]!, '24h'), undefined, `${key} must have no 24h outcome yet`);
    }

    // vetoed buy scores as a wait (−0.3 in a +2% market) but keeps its action
    const vet = outcomeOf(ids.vetoed!, '4h');
    assert.ok(Math.abs(vet!.score - -0.3) < 1e-9, `vetoed scored ${vet!.score}, expected −0.3`);
    const vetRow = db.prepare('SELECT action, status FROM decisions WHERE id = ?').get(ids.vetoed!) as {
      action: string;
      status: string;
    };
    assert.equal(vetRow.action, 'buy', 'vetoed intent must stay in the action column');
    assert.equal(vetRow.status, 'vetoed');
    // llm_failed is not judged at all
    assert.equal(outcomeOf(ids.failed!, '4h'), undefined, 'llm_failed must not be scored');

    console.log(
      `        ${run.written} outcomes: 1h ${run.byHorizon['1h']}, 4h ${run.byHorizon['4h']}, 24h ${run.byHorizon['24h']}`,
    );
  });

  await test('evaluator is idempotent: a second pass writes nothing new', () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM outcomes').get() as { n: number }).n;
    const run = evaluatePending();
    const after = (db.prepare('SELECT COUNT(*) AS n FROM outcomes').get() as { n: number }).n;
    assert.equal(run.written, 0, `second pass wrote ${run.written} rows`);
    assert.equal(after, before);
  });

  // ── 4. indicator stats accumulate live ───────────────────────────────
  const statsBot = newBot('stats', [SYMBOLS.up]);
  await test('indicator stats accumulate from a 4h outcome (neutral + dead-band skipped)', () => {
    startIndicatorStats();
    startJournal();
    const id = seedDecision({
      botId: statsBot.id,
      symbol: SYMBOLS.up,
      action: 'buy',
      snapshot: SNAPSHOT_VOTES,
      provider: STUB_ID,
      model: 'stub-model',
    });
    const run = evaluatePending();
    assert.ok(run.byHorizon['4h'] >= 1, 'expected a 4h outcome for the stats decision');

    const stats = new Map(listIndicatorStats(statsBot.id).map((s) => [s.indicator, s]));
    // +2% move: bull votes hit, bear votes miss, neutral/null votes skipped
    assert.equal(stats.get('rsi14')?.samples, 1);
    assert.equal(stats.get('rsi14')?.hits, 1);
    assert.equal(stats.get('macd')?.samples, 1);
    assert.equal(stats.get('macd')?.hits, 0);
    assert.equal(stats.get('volume_ratio')?.hits, 1);
    assert.equal(stats.get('bollinger'), undefined, 'neutral vote must not create a sample');
    assert.equal(stats.get('atr14'), undefined, 'vote-less indicator must not create a sample');
    assert.equal(voteHit('bull', 0.2), null, 'moves inside ±0.3% have no direction');
    console.log(`        ${stats.size} indicators sampled; rsi14 1/1, macd 0/1 on a +2.00% move`);
    void id;
  });

  // ── 5. weight floor: frozen below 30 samples, moves at 30 ────────────
  await test(`weights frozen until ${SAMPLE_FLOOR} samples, then move`, () => {
    const set = db.prepare(
      `INSERT INTO indicator_stats (bot_id, indicator, samples, hits, weight, enabled, updated_ts)
       VALUES (?, 'ema_trend', ?, ?, 1.0, 1, ?)
       ON CONFLICT(bot_id, indicator) DO UPDATE SET samples = excluded.samples, hits = excluded.hits,
         weight = excluded.weight, enabled = 1`,
    );

    set.run(statsBot.id, SAMPLE_FLOOR - 1, 20, Date.now());
    recomputeWeights(Date.now(), statsBot.id);
    let row = listIndicatorStats(statsBot.id).find((s) => s.indicator === 'ema_trend')!;
    assert.equal(row.weight, 1.0, `weight moved at ${SAMPLE_FLOOR - 1} samples — the floor is locked`);

    set.run(statsBot.id, SAMPLE_FLOOR, 21, Date.now());
    recomputeWeights(Date.now(), statsBot.id);
    row = listIndicatorStats(statsBot.id).find((s) => s.indicator === 'ema_trend')!;
    const hr = laplaceHitRate(21, SAMPLE_FLOOR);
    const want = 1.0 * (1 + 0.1 * (hr - 0.5));
    assert.ok(Math.abs(row.weight - want) < 1e-12, `weight ${row.weight} != ${want}`);
    assert.ok(row.weight > 1.0, 'a >50% hit-rate must raise the weight');
    console.log(
      `        n=${SAMPLE_FLOOR - 1}: w 1.000 (frozen) → n=${SAMPLE_FLOOR}: w ${row.weight.toFixed(5)} (hit-rate ${(hr * 100).toFixed(1)}%)`,
    );
  });

  // ── 6. auto-disable + shadow ─────────────────────────────────────────
  await test(`auto-disable at ${DISABLE_FLOOR} samples / 40% → gone from the prompt, votes still recorded`, () => {
    db.prepare(
      `INSERT INTO indicator_stats (bot_id, indicator, samples, hits, weight, enabled, updated_ts)
       VALUES (?, 'funding', ?, 40, 1.0, 1, ?)
       ON CONFLICT(bot_id, indicator) DO UPDATE SET samples = excluded.samples, hits = excluded.hits, enabled = 1`,
    ).run(statsBot.id, DISABLE_FLOOR, Date.now());

    const changes = recomputeWeights(Date.now(), statsBot.id);
    const disabled = changes.find((c) => c.indicator === 'funding' && c.kind === 'disabled');
    assert.ok(disabled, 'funding should have been auto-disabled');
    assert.ok(disabled!.hitRate < 0.45, `hit-rate ${disabled!.hitRate} should be < 0.45`);

    const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(statsBot.id) as BotRow;
    const snap = buildBotSnapshot(bot, parseConfig(bot), SYMBOLS.up, 'Woken by: test.');
    const shadowed = snap.indicators.find((i) => i.name === 'funding');
    assert.ok(shadowed, 'disabled indicator must STAY in the snapshot');
    assert.equal(shadowed!.shadow, true, 'disabled indicator must be marked shadow');

    const prompt = buildPrompt(
      { name: bot.name, personality: 'test', minConfidence: 65, feePctPerSide: 0.1, slippagePct: 0.05 },
      snap,
    );
    const indicatorBlock = prompt.user.split('Indicators (')[1]!.split('\n\n')[0]!;
    assert.ok(!indicatorBlock.includes('- funding:'), 'shadow indicator must not appear in the prompt');
    assert.ok(indicatorBlock.includes('- rsi14:'), 'enabled indicators must still appear');
    assert.match(indicatorBlock, /hit-rate .+ \(w [\d.]+, n \d+\)/, 'annotation format missing');

    // shadow votes keep accumulating
    const before = listIndicatorStats(statsBot.id).find((s) => s.indicator === 'funding')!.samples;
    recordOutcomeVotes(
      seedDecision({
        botId: statsBot.id,
        symbol: SYMBOLS.up,
        action: 'wait',
        snapshot: { indicators: [{ name: 'funding', value: 1, vote: 'bull' }] },
      }),
      statsBot.id,
      2,
    );
    const after = listIndicatorStats(statsBot.id).find((s) => s.indicator === 'funding')!;
    assert.equal(after.samples, before + 1, 'shadow votes must still be recorded');
    assert.equal(after.enabled, false, 'recording a shadow vote must not re-enable it');
    console.log(
      `        funding disabled at n=${DISABLE_FLOOR} hit-rate ${(disabled!.hitRate * 100).toFixed(1)}% → absent from prompt, samples ${before}→${after.samples}`,
    );
  });

  await test(`prompt with full learning data stays under the token target`, () => {
    const bot = db.prepare('SELECT * FROM bots WHERE id = ?').get(statsBot.id) as BotRow;
    const snap = buildBotSnapshot(bot, parseConfig(bot), SYMBOLS.up, 'Woken by: test.');
    snap.lessons = Array.from({ length: 10 }, (_, i) => `Standing lesson number ${i + 1}: ${'x'.repeat(80)}`);
    const prompt = buildPrompt(
      { name: bot.name, personality: 'test', minConfidence: 65, feePctPerSide: 0.1, slippagePct: 0.05 },
      snap,
    );
    assert.ok(prompt.estTokens < 2500, `prompt too big with full learning data: ${prompt.estTokens}`);
    console.log(`        est tokens with 10 lessons + annotated indicators: ${prompt.estTokens}`);
  });

  // ── 7. journal reflections ───────────────────────────────────────────
  await test('journal: reflection names votes with the exact indicator stat keys', () => {
    const rows = db
      .prepare("SELECT text FROM journal WHERE bot_id = ? AND kind = 'reflection' ORDER BY id DESC")
      .all(statsBot.id) as Array<{ text: string }>;
    assert.ok(rows.length >= 1, 'expected a reflection for the executed buy');
    const text = rows[0]!.text;
    assert.match(text, /^Bought TEST1USDT on scheduled at conf 70 → \+2\.00% @4h/);
    assert.match(text, /Votes right: rsi14, volume_ratio\./);
    assert.match(text, /Wrong: macd\./);
    // waits/vetoes must NOT produce reflections (they would drown the journal)
    const waitCount = db
      .prepare("SELECT COUNT(*) AS n FROM journal WHERE bot_id = ? AND kind = 'reflection'")
      .get(scoreBot.id) as { n: number };
    assert.equal(waitCount.n, 0, 'scoring bot had no snapshot decisions to reflect on');
    console.log(`        "${text.slice(0, 96)}…"`);
  });

  await test('journal: reflection template is pure and handles vote-less snapshots', () => {
    const text = reflectionText(
      { id: 1, bot_id: 1, ts: 0, trigger_type: 'volume_spike', action: 'buy', symbol: 'SOLUSDT', confidence: 72, status: 'executed', snapshot_json: null },
      -1.8,
      -0.9,
    );
    assert.equal(text, 'Bought SOLUSDT on volume_spike at conf 72 → -1.80% @4h (score -0.90). No directional votes to judge.');
  });

  // ── 8. daily lesson compression ──────────────────────────────────────
  useStubRegistry();
  const lessonBot = newBot('lessons', [SYMBOLS.up]);
  await test('lessons: one LLM call → ≤10 bullets replace lessons_current', async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `- Lesson ${i + 1}: do not trade chop on TEST1USDT.`).join('\n');
    setStubScript(STUB_ID, [{ kind: 'custom', result: { ok: true, text: `Here you go:\n${twelve}`, status: 200 } }]);

    const res = await compressLessons(lessonBot.id);
    assert.ok(res.ok, `lesson call failed: ${res.ok ? '' : res.reason}`);
    const lessons = getLessons(lessonBot.id);
    assert.ok(lessons, 'lessons_current not written');
    const bullets = lessons!.text.split('\n');
    assert.equal(bullets.length, 10, `expected 10 bullets, got ${bullets.length}`);
    assert.ok(lessons!.text.length <= 1000, `lessons too long: ${lessons!.text.length} chars`);
    assert.ok(bullets.every((b) => b.startsWith('- ')), 'every lesson must be a bullet');
    const journalled = db
      .prepare("SELECT COUNT(*) AS n FROM journal WHERE bot_id = ? AND kind = 'lesson'")
      .get(lessonBot.id) as { n: number };
    assert.equal(journalled.n, 1, 'the lesson should also be journalled');
    console.log(`        12 bullets in → 10 bullets stored (${lessons!.text.length} chars)`);
  });

  await test('lessons: parseLessons caps bullets and total length', () => {
    assert.equal(parseLessons('1. first\n2. second').length, 2);
    assert.equal(parseLessons('no bullets here').length, 1);
    assert.equal(parseLessons('').length, 0);
    const huge = Array.from({ length: 10 }, () => `- ${'y'.repeat(190)}`).join('\n');
    const capped = parseLessons(huge);
    assert.ok(capped.join('\n').length <= 1000, 'total length not capped');
  });

  await test('lessons: llm failure keeps the PREVIOUS lessons (never blocks)', async () => {
    const before = getLessons(lessonBot.id)!;
    setStubScript(STUB_ID, [{ kind: '429' }, { kind: '429' }, { kind: '429' }]);
    const res = await compressLessons(lessonBot.id);
    assert.equal(res.ok, false, 'expected the lesson call to fail');
    const after = getLessons(lessonBot.id)!;
    assert.equal(after.text, before.text, 'previous lessons must stand');
    assert.equal(after.updatedTs, before.updatedTs);
    console.log(`        all providers 429 → lessons unchanged (${after.text.split('\n').length} bullets)`);
  });

  await test('lessons ride into the NEXT decision snapshot_json', async () => {
    resetRunner();
    setThresholds({ per_bot_wake_floor_min: 0 });
    setStubScript(STUB_ID, [
      {
        kind: 'valid',
        decision: {
          action: 'wait',
          symbol: null,
          size_pct: null,
          confidence: 40,
          reasoning: 'phase-5 lessons test',
          sl_pct: null,
          tp_pct: null,
        },
      },
    ]);

    const seen: number[] = [];
    const un = eventBus.on('decision', (e) => seen.push(e.decisionId));
    requestWake({
      botId: lessonBot.id,
      triggerType: 'scheduled',
      triggerDetail: 'scheduled:1h phase-5',
      reason: 'Woken by: scheduled 1h candle close (phase-5 test).',
      symbol: SYMBOLS.up,
      priority: 3,
    });
    await waitForIdle();
    un();

    assert.equal(seen.length, 1, `expected one decision event, got ${seen.length}`);
    const row = db.prepare('SELECT snapshot_json FROM decisions WHERE id = ?').get(seen[0]!) as {
      snapshot_json: string;
    };
    const snap = JSON.parse(row.snapshot_json) as {
      lessons: string[];
      indicators: Array<{ name: string; weight: number; hitRate: number | null; samples: number }>;
    };
    assert.equal(snap.lessons.length, 10, `snapshot carries ${snap.lessons.length} lessons`);
    assert.match(snap.lessons[0]!, /^Lesson 1:/);
    assert.ok(snap.indicators.length >= 5, 'snapshot must still carry indicators');
    console.log(`        decision #${seen[0]!} snapshot_json → ${snap.lessons.length} standing lessons`);
  });

  // ── 9. model scoreboard API ──────────────────────────────────────────
  await test('GET /api/stats/models aggregates score per provider/model', async () => {
    const app = await buildServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/stats/models' });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.payload) as {
        horizon: string;
        models: Array<{ provider: string; model: string; decisions: number; evaluated: number; wins: number; losses: number; meanScore: number | null; botIds: number[] }>;
      };
      assert.equal(body.horizon, '4h');
      const stub = body.models.find((m) => m.provider === STUB_ID);
      assert.ok(stub, `stub provider missing from scoreboard: ${JSON.stringify(body.models)}`);
      assert.ok(stub!.decisions >= 2, `expected >=2 decisions, got ${stub!.decisions}`);
      assert.ok(stub!.evaluated >= 1, 'expected at least one evaluated decision');
      assert.ok(stub!.meanScore !== null, 'meanScore missing');
      assert.ok(stub!.botIds.length >= 1, 'botIds missing');

      // and the per-bot learning routes
      const stats = await app.inject({ method: 'GET', url: `/api/bots/${statsBot.id}/stats` });
      assert.equal(stats.statusCode, 200);
      const statsBody = JSON.parse(stats.payload) as { stats: Array<{ indicator: string; enabled: boolean }> };
      assert.ok(statsBody.stats.some((s) => s.indicator === 'funding' && !s.enabled), 'stats route missing the disabled row');

      const journal = await app.inject({ method: 'GET', url: `/api/bots/${lessonBot.id}/journal?kind=lesson` });
      assert.equal(journal.statusCode, 200);
      const journalBody = JSON.parse(journal.payload) as { entries: unknown[]; lessons: { text: string } | null };
      assert.equal(journalBody.entries.length, 1);
      assert.ok(journalBody.lessons, 'journal route must return current lessons');

      const outcomes = await app.inject({ method: 'GET', url: `/api/bots/${scoreBot.id}/outcomes` });
      assert.equal(outcomes.statusCode, 200);
      const outBody = JSON.parse(outcomes.payload) as {
        decisions: Array<{ id: number; action: string; status: string; outcomes: Record<string, { score: number }> }>;
      };
      const withBoth = outBody.decisions.filter((d) => d.outcomes['1h'] && d.outcomes['4h']);
      assert.ok(withBoth.length >= 9, `expected >=9 fully-scored decisions, got ${withBoth.length}`);
      console.log(
        `        scoreboard: ${STUB_ID} mean ${stub!.meanScore!.toFixed(3)} over ${stub!.evaluated} evaluated; outcomes route returned ${outBody.decisions.length} decisions`,
      );
    } finally {
      await app.close();
    }
  });

  // ── cleanup ──────────────────────────────────────────────────────────
  stopIndicatorStats();
  stopJournal();
  resetStub();
  purge();
  restoreOtherBots();
  restoreSettings();

  console.log(`\n${passed} passed, ${failed} failed`);
  db.close();
  process.exit(failed === 0 ? 0 : 1);
}

void main();
