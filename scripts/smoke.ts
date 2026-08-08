/**
 * `pnpm smoke` (IMPL-4 §7.5) — end-to-end proof that a real Wick server can
 * take a bot from wake to fill, in about two minutes, for free.
 *
 * What it does:
 *   1. registers a throwaway `stub-smoke` provider in the registry (adapter
 *      'stub', no network, no key) and pins a deterministic BUY decision into
 *      the child process via WICK_STUB_DECISION
 *   2. boots the REAL server (built dist when present, else tsx on source)
 *      against real Binance data and waits for marketWarm
 *   3. creates a throwaway bot on a 1m cadence pinned to that provider
 *   4. subscribes to /api/sse and waits for the scheduled wake
 *   5. asserts: decision row (buy, executed, provider stub-smoke) + fill row +
 *      position, and that both arrived over SSE
 *   6. tears everything down — the bot and every row it wrote, the provider
 *      row, its llm_usage row — and leaves the DB exactly as it found it
 *
 * Exit code 0 = green. Any failed assertion prints and exits 1, still after
 * teardown.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../apps/server/src/db/client.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SERVER_PORT ?? 3001);
const BASE = `http://127.0.0.1:${PORT}`;
const PROVIDER_ID = 'stub-smoke';
const BOT_NAME = `SMOKE-${Date.now()}`;
const SYMBOL = 'BTCUSDT';

/** Boot + backfill on a cold candle store can take a while. */
const WARM_TIMEOUT_MS = 180_000;
/** 1m candle close (≤60s) + bot-scheduler stagger (≤30s) + slack. */
const WAKE_TIMEOUT_MS = 150_000;

const STUB_DECISION = {
  action: 'buy',
  symbol: SYMBOL,
  size_pct: 20,
  confidence: 90,
  reasoning: 'smoke test: deterministic stub decision',
  sl_pct: -5,
  tp_pct: 10,
};

// ── tiny assertion harness ─────────────────────────────────────────────

const results: Array<{ ok: boolean; label: string; detail: string }> = [];

function check(ok: boolean, label: string, detail: string): void {
  results.push({ ok, label, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}

function step(msg: string): void {
  console.log(`\n[smoke] ${msg}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── registry juggling ──────────────────────────────────────────────────

function readRegistryRaw(): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('providers.registry') as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeRegistryRaw(value: string | null): void {
  if (value === null) {
    db.prepare('DELETE FROM settings WHERE key = ?').run('providers.registry');
    return;
  }
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('providers.registry', value);
}

/** Prepend the stub provider so the throwaway bot can name it first. */
function installStubProvider(original: string | null): void {
  const list: unknown[] = original ? (JSON.parse(original) as unknown[]) : [];
  const filtered = list.filter((p) => (p as { id?: string }).id !== PROVIDER_ID);
  filtered.unshift({
    id: PROVIDER_ID,
    // Non-empty baseUrl required: getProviders() drops rows with an empty one.
    baseUrl: 'stub://local',
    authStyle: 'none',
    adapter: 'stub',
    models: ['stub-1'],
    rpm: 600,
    rpd: 100_000,
    enabled: true,
  });
  writeRegistryRaw(JSON.stringify(filtered));
}

// ── server process ─────────────────────────────────────────────────────

function serverCommand(): { cmd: string; args: string[]; mode: string } {
  const dist = path.join(REPO_ROOT, 'apps/server/dist/index.js');
  if (fs.existsSync(dist)) return { cmd: process.execPath, args: [dist], mode: 'built dist' };
  return {
    cmd: process.execPath,
    args: [
      path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'),
      path.join(REPO_ROOT, 'apps/server/src/index.ts'),
    ],
    mode: 'tsx source',
  };
}

let child: ChildProcess | null = null;
const serverLog: string[] = [];

function startServer(): string {
  const { cmd, args, mode } = serverCommand();
  child = spawn(cmd, args, {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // production: pino-pretty's transport worker dies when pm2/this script
      // redirects stdout to a pipe or file (known Phase-7 bug).
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      SERVER_PORT: String(PORT),
      WICK_STUB_DECISION: JSON.stringify(STUB_DECISION),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (buf: Buffer): void => {
    const text = buf.toString();
    serverLog.push(text);
    if (serverLog.length > 400) serverLog.shift();
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  return mode;
}

async function stopServer(): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const proc = child;
  await new Promise<void>((resolve) => {
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
      resolve();
    }, 8000);
  });
}

async function waitFor<T>(
  label: string,
  timeoutMs: number,
  fn: () => Promise<T | null>,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      console.error(`[smoke] server exited early (code ${child.exitCode}) while waiting for ${label}`);
      return null;
    }
    const got = await fn();
    if (got !== null) return got;
    await sleep(1000);
  }
  return null;
}

interface Health {
  ok: boolean;
  marketWarm: boolean;
  ws: { connected: boolean };
}

async function getHealth(): Promise<Health | null> {
  try {
    const res = await fetch(`${BASE}/health`);
    if (!res.ok) return null;
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

// ── SSE listener (manual parse — no EventSource dependency) ────────────

interface SseCollector {
  kinds: Map<string, unknown[]>;
  close: () => void;
}

async function openSse(): Promise<SseCollector> {
  const ctrl = new AbortController();
  const kinds = new Map<string, unknown[]>();
  const res = await fetch(`${BASE}/api/sse?topics=decision,fill`, {
    signal: ctrl.signal,
    headers: { accept: 'text/event-stream' },
  });
  const body = res.body;
  if (!body) throw new Error('SSE response had no body');

  void (async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx = buf.indexOf('\n\n');
        while (idx !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim();
          const data = /^data:\s*(.+)$/m.exec(frame)?.[1];
          if (event && data) {
            try {
              const parsed: unknown = JSON.parse(data);
              const list = kinds.get(event) ?? [];
              list.push(parsed);
              kinds.set(event, list);
            } catch {
              /* non-JSON frame (hello/ping) — ignore */
            }
          }
          idx = buf.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted at teardown */
    }
  })();

  return { kinds, close: () => ctrl.abort() };
}

// ── teardown ───────────────────────────────────────────────────────────

function purgeBot(botId: number): Record<string, number> {
  const removed: Record<string, number> = {};
  const run = (name: string, sql: string, ...params: unknown[]): void => {
    removed[name] = db.prepare(sql).run(...params).changes;
  };
  db.transaction(() => {
    run(
      'outcomes',
      'DELETE FROM outcomes WHERE decision_id IN (SELECT id FROM decisions WHERE bot_id = ?)',
      botId,
    );
    run('decisions', 'DELETE FROM decisions WHERE bot_id = ?', botId);
    run('fills', 'DELETE FROM fills WHERE bot_id = ?', botId);
    run('positions', 'DELETE FROM positions WHERE bot_id = ?', botId);
    run('equity_snapshots', 'DELETE FROM equity_snapshots WHERE bot_id = ?', botId);
    run('trigger_log', 'DELETE FROM trigger_log WHERE bot_id = ?', botId);
    run('journal', 'DELETE FROM journal WHERE bot_id = ?', botId);
    run('lessons_current', 'DELETE FROM lessons_current WHERE bot_id = ?', botId);
    run('indicator_stats', 'DELETE FROM indicator_stats WHERE bot_id = ?', botId);
    run('bots', 'DELETE FROM bots WHERE id = ?', botId);
  })();
  removed.llm_usage = db.prepare('DELETE FROM llm_usage WHERE provider = ?').run(PROVIDER_ID).changes;
  return removed;
}

// ── main ───────────────────────────────────────────────────────────────

async function runChecks(): Promise<void> {
  const originalRegistry = readRegistryRaw();
  let botId: number | null = null;
  let sse: SseCollector | null = null;

  // The body `return`s early on the first hard failure; teardown and the
  // summary must still run, hence try/finally + a summary after it.
  try {
    step('installing throwaway stub provider');
    installStubProvider(originalRegistry);

    step('booting server');
    const mode = startServer();
    console.log(`  running ${mode}`);

    const health = await waitFor('marketWarm', WARM_TIMEOUT_MS, async () => {
      const h = await getHealth();
      return h && h.marketWarm ? h : null;
    });
    check(health !== null, 'server boots and reaches marketWarm', health ? `ws connected=${health.ws.connected}` : 'timeout');
    if (!health) return;

    step('opening SSE stream');
    sse = await openSse();

    step('creating throwaway bot (1m cadence, stub provider)');
    const createRes = await fetch(`${BASE}/api/bots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: BOT_NAME,
        bankroll: 1000,
        status: 'running',
        config: {
          cadence_tf: '1m',
          symbols: [SYMBOL],
          provider_order: [PROVIDER_ID],
          min_confidence: 50,
          cooldown_min: 0,
          min_hold_min: 0,
        },
      }),
    });
    const created = (await createRes.json()) as { bot?: { id: number } };
    botId = created.bot?.id ?? null;
    check(botId !== null, 'bot created via API', botId === null ? `HTTP ${createRes.status}` : `id ${botId}`);
    if (botId === null) return;

    step('waiting for the scheduled 1m wake');
    const decision = await waitFor('decision', WAKE_TIMEOUT_MS, async () => {
      const row = db
        .prepare('SELECT * FROM decisions WHERE bot_id = ? ORDER BY id DESC LIMIT 1')
        .get(botId) as
        | { id: number; action: string; status: string; provider: string | null; symbol: string | null; trigger_type: string }
        | undefined;
      return row ?? null;
    });
    check(
      decision !== null,
      'wake produced a decision row',
      decision ? `id ${decision.id}, trigger ${decision.trigger_type}` : 'timeout',
    );
    if (!decision) return;

    check(
      decision.action === 'buy' && decision.status === 'executed',
      'decision is the stubbed BUY and executed',
      `action=${decision.action} status=${decision.status}`,
    );
    check(
      decision.provider === PROVIDER_ID,
      'decision records the stub provider',
      `provider=${decision.provider}`,
    );

    const fill = db
      .prepare('SELECT * FROM fills WHERE decision_id = ?')
      .get(decision.id) as { id: number; side: string; qty: number; price: number; fee: number } | undefined;
    check(
      fill !== undefined,
      'paper engine wrote the fill',
      fill ? `${fill.side} qty=${fill.qty.toFixed(6)} @ ${fill.price.toFixed(2)} fee=${fill.fee.toFixed(4)}` : 'no fill row',
    );

    const position = db
      .prepare('SELECT * FROM positions WHERE bot_id = ?')
      .get(botId) as { symbol: string; qty: number; stop_price: number | null; tp_price: number | null } | undefined;
    check(
      position !== undefined && position.stop_price !== null && position.tp_price !== null,
      'position opened with SL/TP armed',
      position ? `${position.symbol} qty=${position.qty.toFixed(6)} sl=${position.stop_price?.toFixed(2)} tp=${position.tp_price?.toFixed(2)}` : 'no position',
    );

    // SSE frames are pushed synchronously with the DB write but travel over a
    // socket — give them a beat before asserting.
    await sleep(1500);
    const sseDecisions = (sse.kinds.get('decision') ?? []) as Array<{ decisionId?: number }>;
    const sseFills = (sse.kinds.get('fill') ?? []) as Array<{ botId?: number }>;
    check(
      sseDecisions.some((d) => d.decisionId === decision.id),
      'decision arrived over SSE',
      `${sseDecisions.length} decision frame(s)`,
    );
    check(
      sseFills.some((f) => f.botId === botId),
      'fill arrived over SSE',
      `${sseFills.length} fill frame(s)`,
    );
  } finally {
    step('teardown');
    sse?.close();
    await stopServer();
    if (botId !== null) {
      const removed = purgeBot(botId);
      console.log(`  purged bot ${botId}: ${Object.entries(removed).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(', ') || 'nothing'}`);
    }
    writeRegistryRaw(originalRegistry);
    console.log('  provider registry restored');
  }
}

async function main(): Promise<void> {
  console.log(`Wick smoke test — bot "${BOT_NAME}", provider "${PROVIDER_ID}", symbol ${SYMBOL}`);
  await runChecks();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? 'SMOKE GREEN' : 'SMOKE RED'} — ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('\n--- last server output ---');
    console.log(serverLog.join('').split('\n').slice(-40).join('\n'));
  }
  db.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

void main().catch(async (err: unknown) => {
  console.error('smoke crashed:', err);
  await stopServer();
  process.exit(1);
});
