/**
 * Phase 4 test suite (tsx + node:assert, same style as test-guards/test-llm).
 *
 * Covers the IMPL-3 §4 acceptance list that does not need a second process:
 *   - end-to-end wake → stub LLM → guards → paper fill → decision row + SSE
 *   - guards live: max_trades_day = 1 → second trade decision `vetoed`
 *   - trigger engine: rsi_cross fires, cooldown blocks the repeat (fired=0)
 *   - budget gate: rpd=3 everywhere → P3 yields under the P1 reserve, P1 passes
 *   - wake absorption: 3 wakes in one tick → 1 decision, freshest reason wins
 *   - boot resume: resumeBots() re-arms scheduling for running bots
 *
 * Runs against the real DB. Everything it creates (test bots + their rows)
 * and every setting it lowers is restored at the end.
 *
 *   pnpm tsx scripts/test-bots.ts
 */

import assert from 'node:assert/strict';
import { db } from '../apps/server/src/db/client.js';
import { runMigrations } from '../apps/server/src/db/migrate.js';
import { eventBus } from '../apps/server/src/core/event-bus.js';
import { setMarketWarm } from '../apps/server/src/market/market-state.js';
import { midPrice, type BotRow } from '../apps/server/src/paper/engine.js';
import { createBot, listBots, parseConfig, updateBot } from '../apps/server/src/bots/bot-store.js';
import {
  requestWake,
  resetRunner,
  runnerStats,
  waitForIdle,
} from '../apps/server/src/bots/bot-runner.js';
import { staggerMs, stopBotScheduler, STAGGER_MAX_MS } from '../apps/server/src/bots/scheduler.js';
import { resumeBots, stopBustedCron } from '../apps/server/src/bots/boot.js';
import {
  budgetGate,
  budgetInfo,
  fireTrigger,
  resetTriggerState,
  startTriggerEngine,
  stopTriggerEngine,
} from '../apps/server/src/market/trigger-engine.js';
import { resetStub, setStubScript } from '../apps/server/src/llm/adapters/stub.js';
import { getProviders } from '../apps/server/src/llm/providers.js';
import { record, utcDate } from '../apps/server/src/llm/quota.js';
import type { IndicatorEvent } from '../packages/shared/src/events.js';

const STUB_ID = 'stub-e2e';
const TEST_PREFIX = 'test-phase4-';

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

function setThresholds(patch: Record<string, unknown>): void {
  const cur = JSON.parse(readSetting('triggers.thresholds') ?? '{}') as Record<string, unknown>;
  writeSetting('triggers.thresholds', JSON.stringify({ ...cur, ...patch }));
}

/** Registry containing only the deterministic stub provider. */
function useStubRegistry(rpd = 100): void {
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
        rpd,
        enabled: true,
      },
    ]),
  );
}

// ── test-bot bookkeeping ───────────────────────────────────────────────

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

function purgeTestBots(): void {
  const rows = db
    .prepare(`SELECT id FROM bots WHERE name LIKE '${TEST_PREFIX}%'`)
    .all() as Array<{ id: number }>;
  const tx = db.transaction((ids: number[]) => {
    for (const id of ids) {
      db.prepare('DELETE FROM decisions WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM fills WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM positions WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM equity_snapshots WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM trigger_log WHERE bot_id = ?').run(id);
      db.prepare('DELETE FROM bots WHERE id = ?').run(id);
    }
  });
  tx(rows.map((r) => r.id));
}

function purgeStubUsage(): void {
  db.prepare('DELETE FROM llm_usage WHERE provider = ?').run(STUB_ID);
}

function newBot(suffix: string, symbols: string[]): BotRow {
  return createBot({
    name: `${TEST_PREFIX}${suffix}`,
    bankroll: 1000,
    status: 'running',
    config: { symbols, provider_order: [STUB_ID], cadence_tf: '1h' },
  });
}

function decisionsOf(botId: number): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT * FROM decisions WHERE bot_id = ? ORDER BY id DESC')
    .all(botId) as Array<Record<string, unknown>>;
}

function triggerRows(botId: number): Array<{ id: number; type: string; detail: string; fired: number }> {
  return db
    .prepare('SELECT id, type, detail, fired FROM trigger_log WHERE bot_id = ? ORDER BY id DESC')
    .all(botId) as Array<{ id: number; type: string; detail: string; fired: number }>;
}

function stubDecision(over: Record<string, unknown>): void {
  setStubScript(STUB_ID, [
    {
      kind: 'valid',
      decision: {
        action: 'wait',
        symbol: null,
        size_pct: null,
        confidence: 80,
        reasoning: 'phase-4 test decision',
        sl_pct: null,
        tp_pct: null,
        ...over,
      },
    },
  ]);
}

function indicatorEvent(symbol: string, name: string, value: number): IndicatorEvent {
  return {
    id: 1,
    ts: Date.now(),
    source: 'test',
    kind: 'indicator',
    symbol,
    tf: '1h',
    name,
    value,
    vote: null,
  };
}

// ── suite ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  runMigrations();
  console.log('phase 4 tests (bots + trigger engine)\n');

  purgeTestBots();
  purgeStubUsage();
  quiesceOtherBots();
  setMarketWarm();

  const price = midPrice('BTCUSDT');
  assert.ok(
    price !== null,
    'no BTCUSDT price available — boot the server once so candles exist (pnpm dev:server)',
  );
  console.log(`  (BTCUSDT mid from candle store: ${price})\n`);

  // ── 1. end-to-end: wake → stub → guards → fill → decision row + SSE ──
  await test('e2e: wake produces a decision row with snapshot + provider, and a real fill', async () => {
    useStubRegistry();
    resetRunner();
    const bot = newBot('e2e', ['BTCUSDT']);
    stubDecision({ action: 'buy', symbol: 'BTCUSDT', size_pct: 20, confidence: 80, sl_pct: -5, tp_pct: 10 });

    const seen: Array<{ kind: string; status?: string }> = [];
    const un = eventBus.on('decision', (e) => seen.push({ kind: e.kind, status: e.status }));

    requestWake({
      botId: bot.id,
      triggerType: 'scheduled',
      triggerDetail: 'scheduled:1h test close',
      reason: 'Woken by: scheduled 1h candle close (test).',
      symbol: null,
      priority: 3,
    });
    await waitForIdle();
    un();

    const rows = decisionsOf(bot.id);
    assert.equal(rows.length, 1, `expected 1 decision, got ${rows.length}`);
    const d = rows[0]!;
    assert.equal(d.action, 'buy');
    assert.equal(d.status, 'executed');
    assert.equal(d.provider, STUB_ID);
    assert.equal(d.model, 'stub-model');
    assert.ok(typeof d.latency_ms === 'number', 'latency_ms missing');
    const snap = JSON.parse(String(d.snapshot_json)) as {
      indicators: unknown[];
      candles1h: unknown[];
      triggerReason: string;
      meta: { run: number; triggerType: string };
    };
    assert.ok(snap.indicators.length >= 8, `snapshot has ${snap.indicators.length} indicators`);
    assert.ok(snap.candles1h.length > 0, 'snapshot has no candles');
    assert.equal(snap.meta.run, 1);
    assert.equal(snap.meta.triggerType, 'scheduled');
    assert.match(snap.triggerReason, /^Woken by:/);

    const fill = db
      .prepare('SELECT * FROM fills WHERE bot_id = ? ORDER BY id DESC LIMIT 1')
      .get(bot.id) as { decision_id: number; side: string; qty: number; price: number } | undefined;
    assert.ok(fill, 'no fill row written');
    assert.equal(fill!.decision_id, d.id);
    assert.equal(fill!.side, 'buy');
    const pos = db.prepare('SELECT * FROM positions WHERE bot_id = ?').all(bot.id);
    assert.equal(pos.length, 1, 'expected one open position');
    assert.equal(seen.length, 1, 'expected exactly one SSE decision event');
    assert.equal(seen[0]!.status, 'executed');
    console.log(
      `        fill: ${fill!.qty.toFixed(8)} BTC @ ${fill!.price.toFixed(2)}, decision #${String(d.id)}`,
    );
  });

  // ── 2. guards live: max_trades_day = 1 → second trade vetoed ─────────
  await test('guards: max_trades_day=1 vetoes the second trade decision', async () => {
    const bot = db
      .prepare(`SELECT * FROM bots WHERE name = ?`)
      .get(`${TEST_PREFIX}e2e`) as BotRow;
    updateBot(bot.id, { config: { max_trades_day: 1 } });
    setThresholds({ per_bot_wake_floor_min: 0 }); // otherwise the 10-min floor gates the wake
    stubDecision({ action: 'buy', symbol: 'BTCUSDT', size_pct: 10, confidence: 90 });

    requestWake({
      botId: bot.id,
      triggerType: 'scheduled',
      triggerDetail: 'scheduled:1h second attempt',
      reason: 'Woken by: scheduled 1h candle close (second attempt).',
      symbol: null,
      priority: 3,
    });
    await waitForIdle();

    const rows = decisionsOf(bot.id);
    assert.equal(rows.length, 2, `expected 2 decisions, got ${rows.length}`);
    const d = rows[0]!;
    assert.equal(d.status, 'vetoed');
    assert.equal(d.action, 'buy', 'the vetoed intent must stay visible in the action column');
    assert.match(String(d.veto_reason), /^max_trades_day/);
    const fills = db.prepare('SELECT COUNT(*) AS n FROM fills WHERE bot_id = ?').get(bot.id) as {
      n: number;
    };
    assert.equal(fills.n, 1, 'vetoed decision must not fill');
    console.log(`        veto_reason: ${String(d.veto_reason)}`);
  });

  // ── 3. trigger engine: rsi_cross fires, cooldown blocks the repeat ───
  await test('trigger: rsi_cross fires once, cooldown blocks the immediate repeat', async () => {
    useStubRegistry();
    resetRunner();
    resetTriggerState();
    setThresholds({ per_bot_wake_floor_min: 0 });
    const bot = newBot('trig', ['ETHUSDT']);
    stubDecision({ action: 'wait', confidence: 20 });

    const live = db
      .prepare(
        "SELECT value FROM indicator_values WHERE symbol = 'ETHUSDT' AND name = 'rsi14' ORDER BY ts DESC LIMIT 1",
      )
      .get() as { value: number | null } | undefined;
    const liveRsi = live?.value ?? 50;
    const level = Math.max(5, Math.round(liveRsi) - 1); // "lower the threshold to the current value"
    setThresholds({ rsi_high: level });

    startTriggerEngine();
    // previous candle below the lowered threshold, then the live value above it
    eventBus.emit(indicatorEvent('ETHUSDT', 'rsi14', level - 5));
    eventBus.emit(indicatorEvent('ETHUSDT', 'rsi14', liveRsi));
    await waitForIdle();

    const firedRows = triggerRows(bot.id).filter((r) => r.type === 'rsi_cross' && r.fired === 1);
    assert.equal(firedRows.length, 1, `expected 1 fired rsi_cross row, got ${firedRows.length}`);
    const rows = decisionsOf(bot.id);
    assert.equal(rows.length, 1, `expected 1 decision, got ${rows.length}`);
    assert.equal(rows[0]!.trigger_type, 'rsi_cross');
    const snap = JSON.parse(String(rows[0]!.snapshot_json)) as { triggerReason: string };
    assert.match(snap.triggerReason, /RSI\(14,1h\) crossed/);

    // immediate repeat → gated by the per (type × symbol) cooldown
    eventBus.emit(indicatorEvent('ETHUSDT', 'rsi14', level - 5));
    await waitForIdle();
    const gated = triggerRows(bot.id).filter((r) => r.type === 'rsi_cross' && r.fired === 0);
    assert.ok(gated.length >= 1, 'expected a fired=0 cooldown row');
    assert.match(gated[0]!.detail, /cooldown_/);
    assert.equal(decisionsOf(bot.id).length, 1, 'cooldown must not produce a second decision');
    stopTriggerEngine();
    console.log(
      `        rsi ${liveRsi.toFixed(1)} crossed level ${level}; gated row: ${gated[0]!.detail.split('[')[1] ?? ''}`,
    );
  });

  // ── 4. budget gate: rpd=3 everywhere → P3 yields, P1 passes ──────────
  await test('budget: all rpd=3 → P3 gated by the P1 reserve while P1 still passes', async () => {
    restoreSettings(); // real registry (5 enabled providers)
    setThresholds({ per_bot_wake_floor_min: 0 });
    const registry = JSON.parse(readSetting('providers.registry') ?? '[]') as Array<Record<string, unknown>>;
    writeSetting('providers.registry', JSON.stringify(registry.map((p) => ({ ...p, rpd: 3 }))));

    const providers = getProviders().filter((p) => p.enabled);
    const poolTotal = providers.reduce((s, p) => s + p.rpd, 0);
    const today = utcDate();
    const before = db
      .prepare('SELECT provider, calls, errors FROM llm_usage WHERE date = ?')
      .all(today) as Array<{ provider: string; calls: number; errors: number }>;

    // Burn the pool down to just under the 30% reserve line.
    let burn = poolTotal - 4;
    for (const p of providers) {
      for (let i = 0; i < p.rpd && burn > 0; i++, burn--) record(p, true);
    }
    const info = budgetInfo();
    assert.equal(info.poolTotal, poolTotal);
    assert.equal(info.pool, 4);
    assert.ok(Math.abs(info.reserve - poolTotal * 0.3) < 1e-9);

    const p3 = budgetGate(3, info, false);
    const p1 = budgetGate(1, info, false);
    assert.equal(p3.ok, false, 'P3 should yield under the reserve');
    assert.match(p3.ok === false ? p3.reason : '', /budget_p1_reserve/);
    assert.equal(p1.ok, true, 'P1 must still pass (reserve is for P1)');

    // and end-to-end through fireTrigger (trigger_log evidence)
    const bot = db.prepare('SELECT * FROM bots WHERE name = ?').get(`${TEST_PREFIX}trig`) as BotRow;
    fireTrigger({
      type: 'scheduled',
      priority: 3,
      symbol: null,
      detail: 'scheduled:budget test',
      reason: 'Woken by: scheduled (budget test).',
      onlyBotIds: [bot.id],
      skipTypeCooldown: true,
    });
    const sched = triggerRows(bot.id).filter((r) => r.type === 'scheduled');
    assert.equal(sched[0]!.fired, 0, 'P3 wake should be logged as gated');
    assert.match(sched[0]!.detail, /budget_p1_reserve/);

    fireTrigger({
      type: 'price_velocity',
      priority: 1,
      symbol: 'ETHUSDT',
      detail: 'price_velocity:ETHUSDT budget test',
      reason: 'Woken by: price velocity (budget test).',
    });
    const pv = triggerRows(bot.id).filter((r) => r.type === 'price_velocity');
    assert.equal(pv[0]!.fired, 1, 'P1 wake should fire on the reserve');
    await waitForIdle();

    // restore the ledger exactly as we found it
    db.prepare('DELETE FROM llm_usage WHERE date = ?').run(today);
    for (const r of before) {
      db.prepare('INSERT INTO llm_usage (provider, date, calls, errors) VALUES (?, ?, ?, ?)').run(
        r.provider,
        today,
        r.calls,
        r.errors,
      );
    }
    restoreSettings();
    console.log(
      `        pool ${info.pool}/${info.poolTotal}, P1 reserve ${info.reserve.toFixed(1)} → P3 blocked, P1 passed`,
    );
  });

  // ── 5. wake absorption: 3 wakes in one tick → 1 decision ─────────────
  await test('absorption: 3 wakes in one tick produce 1 decision with the freshest reason', async () => {
    useStubRegistry();
    resetRunner();
    setThresholds({ per_bot_wake_floor_min: 0 });
    const bot = newBot('absorb', ['BTCUSDT']);
    stubDecision({ action: 'wait', confidence: 30 });

    for (const [i, reason] of ['first', 'second', 'third'].entries()) {
      requestWake({
        botId: bot.id,
        triggerType: 'rsi_cross',
        triggerDetail: `rsi_cross:BTCUSDT ${reason}`,
        reason: `Woken by: ${reason} trigger.`,
        symbol: 'BTCUSDT',
        priority: 2,
      });
      void i;
    }
    const stats = runnerStats();
    assert.equal(stats.queued, 1, `expected 1 queued, got ${stats.queued}`);
    assert.equal(stats.absorbed, 2, `expected 2 absorbed, got ${stats.absorbed}`);
    await waitForIdle();

    const rows = decisionsOf(bot.id);
    assert.equal(rows.length, 1, `expected 1 decision from 3 wakes, got ${rows.length}`);
    assert.match(String(rows[0]!.trigger_detail), /third/);
    const snap = JSON.parse(String(rows[0]!.snapshot_json)) as { triggerReason: string };
    assert.match(snap.triggerReason, /third trigger/);
    console.log(`        3 wakes → queued 1, absorbed 2, decisions 1 (freshest reason kept)`);
  });

  // ── 6. deterministic stagger + boot resume ──────────────────────────
  await test('scheduler stagger is deterministic and inside 0–30s', () => {
    const a = staggerMs(1);
    const b = staggerMs(1);
    const c = staggerMs(2);
    assert.equal(a, b, 'stagger must be deterministic per bot id');
    assert.ok(a >= 0 && a < STAGGER_MAX_MS, `stagger out of range: ${a}`);
    assert.ok(c >= 0 && c < STAGGER_MAX_MS);
    console.log(`        bot1 ${a}ms, bot2 ${c}ms`);
  });

  await test('boot resume reloads running bots and restarts wake sources', () => {
    const running = resumeBots();
    const expected = (
      db.prepare("SELECT COUNT(*) AS n FROM bots WHERE status = 'running'").get() as { n: number }
    ).n;
    assert.equal(running, expected);
    const cfg = parseConfig(
      db.prepare('SELECT * FROM bots WHERE name = ?').get(`${TEST_PREFIX}e2e`) as BotRow,
    );
    assert.equal(cfg.run, 1, 'run counter should survive a resume');
    stopBotScheduler();
    console.log(`        resumed ${running} running bot(s)`);
  });

  // ── cleanup ───────────────────────────────────────────────────────────
  stopTriggerEngine();
  stopBustedCron();
  resetStub();
  purgeTestBots();
  purgeStubUsage();
  restoreOtherBots();
  restoreSettings();

  console.log(`\n${passed} passed, ${failed} failed`);
  db.close();
  process.exit(failed === 0 ? 0 : 1);
}

void main();
