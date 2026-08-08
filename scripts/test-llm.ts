/**
 * Phase 3 test suite (tsx asserts): router rotation, quota ledger, parse /
 * repair paths, decision coercion, prompt golden test. Runs against the
 * stub adapter and real DB (llm_usage rows under 'stub-*' provider ids,
 * cleaned up before and after). `UPDATE_GOLDEN=1` regenerates the golden
 * prompt file after intentional prompt changes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../apps/server/src/db/client.js';
import { decide } from '../apps/server/src/llm/router.js';
import { extractJson } from '../apps/server/src/llm/router.js';
import type { ProviderRecord } from '../apps/server/src/llm/providers.js';
import { getProviders } from '../apps/server/src/llm/providers.js';
import {
  hasHeadroom,
  record,
  getUsage,
  poolRemaining,
  resetRpmBuckets,
  utcDate,
} from '../apps/server/src/llm/quota.js';
import { resetStub, setStubScript, getStubCalls } from '../apps/server/src/llm/adapters/stub.js';
import type { StubBehavior } from '../apps/server/src/llm/adapters/stub.js';
import { buildPrompt, PROMPT_TOKEN_TARGET } from '../apps/server/src/llm/prompt.js';
import { FIXTURE_BOT_CONFIG, FIXTURE_SNAPSHOT } from '../apps/server/src/llm/golden/fixture.js';
import { DecisionSchema } from '../packages/shared/src/decision.js';
import type { BotCtx } from '../apps/server/src/llm/router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_PATH = path.join(__dirname, '..', 'apps', 'server', 'src', 'llm', 'golden', 'prompt.golden.txt');

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  cleanup();
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${err instanceof Error ? err.message : String(err)}`);
  }
}

function cleanup(): void {
  db.prepare("DELETE FROM llm_usage WHERE provider LIKE 'stub-%'").run();
  resetStub();
  resetRpmBuckets();
}

function stubProvider(id: string, overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id,
    baseUrl: 'stub://local',
    authStyle: 'none',
    adapter: 'stub',
    models: ['stub-model'],
    rpm: 100,
    rpd: 100,
    enabled: true,
    ...overrides,
  };
}

const BOT: BotCtx = { botId: 999, config: FIXTURE_BOT_CONFIG };

function script(id: string, behaviors: StubBehavior[]): void {
  setStubScript(id, behaviors);
}

async function main(): Promise<void> {
  console.log('llm router tests (stub adapter, real DB stub-* rows)');

  // ── rotation ──────────────────────────────────────────────────────────

  await test('rotation skips provider without rpd headroom', async () => {
    const providers = [stubProvider('stub-a', { rpd: 0 }), stubProvider('stub-b')];
    script('stub-b', [{ kind: 'valid' }]);
    const res = await decide(BOT, FIXTURE_SNAPSHOT, { providers });
    assert.equal(res.failed ?? false, false);
    if (!res.failed) assert.equal(res.provider, 'stub-b');
    assert.equal(getUsage('stub-a').calls, 0); // skipped, not called
    assert.equal(getUsage('stub-b').calls, 1);
  });

  await test('rotation skips provider with empty rpm bucket', async () => {
    const providers = [stubProvider('stub-a', { rpm: 0 }), stubProvider('stub-b')];
    script('stub-b', [{ kind: 'valid' }]);
    const res = await decide(BOT, FIXTURE_SNAPSHOT, { providers });
    if (!res.failed) assert.equal(res.provider, 'stub-b');
    else assert.fail('expected success from stub-b');
  });

  await test('rotation respects bot provider_order', async () => {
    const providers = [stubProvider('stub-a'), stubProvider('stub-b')];
    script('stub-a', [{ kind: 'valid' }]);
    script('stub-b', [{ kind: 'valid' }]);
    const res = await decide(
      { ...BOT, providerOrder: ['stub-b', 'stub-a'] },
      FIXTURE_SNAPSHOT,
      { providers },
    );
    if (res.failed) assert.fail('expected success');
    assert.equal(res.provider, 'stub-b');
  });

  await test('disabled provider is skipped', async () => {
    const providers = [stubProvider('stub-a', { enabled: false }), stubProvider('stub-b')];
    script('stub-b', [{ kind: 'valid' }]);
    const res = await decide(BOT, FIXTURE_SNAPSHOT, { providers });
    if (res.failed) assert.fail('expected success');
    assert.equal(res.provider, 'stub-b');
    assert.equal(getUsage('stub-a').calls, 0);
  });

  // ── failure fall-through ──────────────────────────────────────────────

  await test('429 falls through to next provider and records error', async () => {
    const providers = [stubProvider('stub-a'), stubProvider('stub-b')];
    script('stub-a', [{ kind: '429' }]);
    script('stub-b', [{ kind: 'valid' }]);
    const res = await decide(BOT, FIXTURE_SNAPSHOT, { providers });
    if (res.failed) assert.fail('expected success');
    assert.equal(res.provider, 'stub-b');
    assert.deepEqual(getUsage('stub-a'), { calls: 1, errors: 1 });
    assert.deepEqual(getUsage('stub-b'), { calls: 1, errors: 0 });
  });

  await test('5xx and timeout fall through the same way', async () => {
    const providers = [stubProvider('stub-a'), stubProvider('stub-b'), stubProvider('stub-c')];
    script('stub-a', [{ kind: '500' }]);
    script('stub-b', [{ kind: 'timeout' }]);
    script('stub-c', [{ kind: 'valid' }]);
    const res = await decide(BOT, FIXTURE_SNAPSHOT, { providers });
    if (res.failed) assert.fail('expected success');
    assert.equal(res.provider, 'stub-c');
    assert.deepEqual(getUsage('stub-a'), { calls: 1, errors: 1 });
    assert.deepEqual(getUsage('stub-b'), { calls: 1, errors: 1 });
  });

  // ── parse / repair paths ──────────────────────────────────────────────

  await test('prose-wrapped JSON is extracted without a repair call', async () => {
    const providers = [stubProvider('stub-a')];
    script('stub-a', [{ kind: 'prose' }]);
    const res = await decide(BOT, FIXTURE_SNAPSHOT, { providers });
    if (res.failed) assert.fail('expected success');
    assert.equal(res.provider, 'stub-a');
    assert.equal(res.decision.action, 'wait');
    assert.equal(getStubCalls().length, 1); // no repair round-trip
    assert.deepEqual(getUsage('stub-a'), { calls: 1, errors: 0 });
  });

  await test('garbage → repair retry succeeds on same provider', async () => {
    const providers = [stubProvider('stub-a')];
    script('stub-a', [{ kind: 'garbage' }, { kind: 'valid' }]);
    const res = await decide(BOT, FIXTURE_SNAPSHOT, { providers });
    if (res.failed) assert.fail('expected success');
    assert.equal(res.provider, 'stub-a');
    assert.equal(getStubCalls().length, 2);
    const repairReq = getStubCalls()[1]!.req;
    assert.match(repairReq.user, /corrected JSON/);
    assert.deepEqual(getUsage('stub-a'), { calls: 2, errors: 0 });
  });

  await test('garbage twice → repair fails → fails over to next provider', async () => {
    const providers = [stubProvider('stub-a'), stubProvider('stub-b')];
    script('stub-a', [{ kind: 'garbage' }, { kind: 'garbage' }]);
    script('stub-b', [{ kind: 'valid' }]);
    const res = await decide(BOT, FIXTURE_SNAPSHOT, { providers });
    if (res.failed) assert.fail('expected success');
    assert.equal(res.provider, 'stub-b');
    // malformed-after-repair marks an error on the ledger (PLAN §7)
    assert.deepEqual(getUsage('stub-a'), { calls: 2, errors: 1 });
    assert.deepEqual(getUsage('stub-b'), { calls: 1, errors: 0 });
  });

  await test('schema-invalid JSON follows the malformed path (repair, then rotate)', async () => {
    const providers = [stubProvider('stub-a'), stubProvider('stub-b')];
    const bad = { kind: 'valid', decision: { action: 'buy', symbol: null, size_pct: null, confidence: 90, reasoning: 'buy with no symbol' } } as const;
    script('stub-a', [bad, bad]);
    script('stub-b', [{ kind: 'valid' }]);
    const res = await decide(BOT, FIXTURE_SNAPSHOT, { providers });
    if (res.failed) assert.fail('expected success');
    assert.equal(res.provider, 'stub-b');
    assert.deepEqual(getUsage('stub-a'), { calls: 2, errors: 1 });
  });

  await test('all providers down → clean {failed: true}, no throw', async () => {
    const providers = [
      stubProvider('stub-a', { enabled: false }),
      stubProvider('stub-b', { rpd: 0 }),
      stubProvider('stub-c'),
    ];
    script('stub-c', [{ kind: '429' }]);
    const res = await decide(BOT, FIXTURE_SNAPSHOT, { providers });
    assert.equal(res.failed, true);
    if (res.failed) assert.match(res.reason, /exhausted/);
  });

  await test('empty provider list → clean {failed: true}', async () => {
    const res = await decide(BOT, FIXTURE_SNAPSHOT, { providers: [] });
    assert.equal(res.failed, true);
  });

  // ── decision coercion ─────────────────────────────────────────────────

  await test('coerces "82%" confidence and uppercase action', async () => {
    const providers = [stubProvider('stub-a')];
    script('stub-a', [
      {
        kind: 'valid',
        decision: {
          action: 'BUY',
          symbol: 'btcusdt',
          size_pct: '25',
          confidence: '82%',
          reasoning: 'coercion test',
          sl_pct: '-5',
        },
      },
    ]);
    const res = await decide(BOT, FIXTURE_SNAPSHOT, { providers });
    if (res.failed) assert.fail('expected success');
    assert.equal(res.decision.action, 'buy');
    assert.equal(res.decision.symbol, 'BTCUSDT');
    assert.equal(res.decision.size_pct, 25);
    assert.equal(res.decision.confidence, 82);
    assert.equal(res.decision.sl_pct, -5);
    assert.equal(res.decision.tp_pct, null); // omitted → null
  });

  await test('DecisionSchema rejects out-of-range values', () => {
    assert.equal(DecisionSchema.safeParse({ action: 'buy', symbol: 'X', size_pct: 150, confidence: 80, reasoning: 'r' }).success, false);
    assert.equal(DecisionSchema.safeParse({ action: 'hold', symbol: null, size_pct: null, confidence: 50, reasoning: 'r' }).success, false);
    assert.equal(DecisionSchema.safeParse({ action: 'wait', symbol: null, size_pct: null, confidence: 101, reasoning: 'r' }).success, false);
  });

  await test('extractJson handles fences, prose, nesting and braces in strings', () => {
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('Sure: {"a":{"b":"}"}} trailing'), { a: { b: '}' } });
    assert.equal(extractJson('no json here'), null);
  });

  // ── quota ledger ──────────────────────────────────────────────────────

  await test('quota UTC date rollover resets daily headroom', () => {
    const p = stubProvider('stub-a', { rpd: 2, rpm: 100 });
    const day1 = Date.UTC(2026, 7, 8, 23, 59, 0);
    const day2 = Date.UTC(2026, 7, 9, 0, 1, 0);
    assert.equal(utcDate(day1), '2026-08-08');
    assert.equal(utcDate(day2), '2026-08-09');
    record(p, true, day1);
    record(p, false, day1);
    assert.equal(hasHeadroom(p, day1), false); // rpd 2 exhausted
    assert.equal(hasHeadroom(p, day2), true); // fresh UTC day
    assert.deepEqual(getUsage('stub-a', day1), { calls: 2, errors: 1 });
    assert.deepEqual(getUsage('stub-a', day2), { calls: 0, errors: 0 });
  });

  await test('poolRemaining sums enabled providers only', () => {
    const now = Date.UTC(2026, 7, 8, 12, 0, 0);
    const a = stubProvider('stub-a', { rpd: 10 });
    const b = stubProvider('stub-b', { rpd: 5, enabled: false });
    const c = stubProvider('stub-c', { rpd: 3 });
    record(a, true, now);
    record(a, true, now);
    assert.equal(poolRemaining([a, b, c], now), 8 + 3);
  });

  await test('rpm token bucket refills over time', () => {
    const p = stubProvider('stub-a', { rpm: 2, rpd: 1000 });
    const t0 = Date.UTC(2026, 7, 8, 12, 0, 0);
    record(p, true, t0);
    record(p, true, t0);
    assert.equal(hasHeadroom(p, t0), false); // bucket drained
    assert.equal(hasHeadroom(p, t0 + 61_000), true); // refilled after a minute
  });

  // ── prompt golden test ────────────────────────────────────────────────

  await test(`prompt golden file matches and stays under ${PROMPT_TOKEN_TARGET} tokens`, () => {
    const prompt = buildPrompt(FIXTURE_BOT_CONFIG, FIXTURE_SNAPSHOT);
    const rendered = `── SYSTEM ──\n${prompt.system}\n── USER ──\n${prompt.user}\n`;
    assert.ok(
      prompt.estTokens < PROMPT_TOKEN_TARGET,
      `prompt too big: ${prompt.estTokens} tokens (target < ${PROMPT_TOKEN_TARGET})`,
    );
    if (process.env.UPDATE_GOLDEN === '1') {
      fs.writeFileSync(GOLDEN_PATH, rendered, 'utf8');
      console.log(`        golden updated (${prompt.estTokens} est tokens)`);
      return;
    }
    assert.ok(fs.existsSync(GOLDEN_PATH), 'golden file missing — run with UPDATE_GOLDEN=1 once');
    const golden = fs.readFileSync(GOLDEN_PATH, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(rendered, golden, 'rendered prompt drifted from golden — intentional? UPDATE_GOLDEN=1');
    console.log(`        est tokens: ${prompt.estTokens}`);
  });

  await test('registry falls back to defaults and reads settings', () => {
    const providers = getProviders();
    assert.ok(providers.length >= 6, `expected >=6 providers, got ${providers.length}`);
    const groq = providers.find((p) => p.id === 'groq');
    assert.ok(groq, 'groq missing from registry');
    assert.equal(groq!.adapter, 'openai-compat');
    const gemini = providers.find((p) => p.id === 'gemini');
    assert.equal(gemini!.adapter, 'gemini');
    const ollama = providers.find((p) => p.id === 'ollama');
    assert.equal(ollama!.authStyle, 'none');
  });

  cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
