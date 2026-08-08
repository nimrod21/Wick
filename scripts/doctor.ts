/**
 * `pnpm doctor` (IMPL-4 §7.4) — one screen that answers "is Wick healthy?".
 *
 * Prints the same report as `GET /health` plus environment facts the server
 * cannot see (Node version, build artifacts, master key, vault keys, backups).
 * Works with the server down: the live section degrades to SERVER DOWN and the
 * DB numbers are read locally.
 *
 * Read-only. Never writes to the DB, never calls a provider.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../apps/server/src/db/client.js';
import { config, getApiKey } from '../apps/server/src/config.js';
import { dbStats, type HealthReport } from '../apps/server/src/api/health.js';
import { getProviders } from '../apps/server/src/llm/providers.js';
import { BACKUP_DIR } from '../apps/server/src/jobs/hygiene.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEALTH_URL = `http://127.0.0.1:${process.env.SERVER_PORT ?? 3001}/health`;

const warnings: string[] = [];

function ok(label: string, value: string): void {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

function warn(label: string, value: string, why: string): void {
  console.log(`  ${label.padEnd(22)} ${value}   <-- ${why}`);
  warnings.push(`${label}: ${why}`);
}

function fmtAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

async function fetchHealth(): Promise<HealthReport | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(HEALTH_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as HealthReport;
  } catch {
    return null;
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function reportEnvironment(): void {
  section('environment');
  const major = Number(process.versions.node.split('.')[0]);
  if (major === 22) ok('node', process.version);
  else warn('node', process.version, 'Wick needs Node 22 (better-sqlite3 prebuilds)');

  const serverDist = path.join(REPO_ROOT, 'apps/server/dist/index.js');
  const webBuild = path.join(REPO_ROOT, 'apps/web/.next');
  if (fs.existsSync(serverDist)) ok('server build', serverDist);
  else warn('server build', 'missing', 'run `pnpm build` before `pnpm pm2:start`');
  if (fs.existsSync(webBuild)) ok('web build', webBuild);
  else warn('web build', 'missing', 'run `pnpm build` before `pnpm pm2:start`');

  if (config.masterKey && config.masterKey.length >= 32) ok('master key', 'present (.env)');
  else warn('master key', 'missing', 'vault keys cannot be decrypted; generated on next boot');
}

function reportDb(): void {
  const stats = dbStats();
  section('database');
  ok('path', stats.path);
  ok('size', `${stats.sizeMb} MB`);
  ok('decisions / fills', `${stats.decisions} / ${stats.fills}`);
  ok('open positions', String(stats.openPositions));
  ok('1m candles', String(stats.candles1m));
  ok('trigger_log rows', String(stats.triggerLog));
  ok(
    'last decision',
    stats.lastDecisionTs === null
      ? 'never'
      : `${new Date(stats.lastDecisionTs).toISOString()} (${fmtAge(Date.now() - stats.lastDecisionTs)})`,
  );

  const bots = db
    .prepare('SELECT status, COUNT(*) AS n FROM bots GROUP BY status')
    .all() as Array<{ status: string; n: number }>;
  ok('bots', bots.length === 0 ? 'none' : bots.map((b) => `${b.n} ${b.status}`).join(', '));

  if (fs.existsSync(BACKUP_DIR)) {
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort().reverse();
    if (files.length > 0) ok('backups', `${files.length} (newest ${files[0]})`);
    else warn('backups', 'none', 'nightly backup has not run yet');
  } else {
    warn('backups', 'no backups/ dir', 'nightly backup has not run yet');
  }
}

function reportProviders(live: HealthReport | null): void {
  section('providers (daily quota, UTC)');
  const providers = getProviders();
  if (live) {
    for (const p of live.providers) {
      const key = getApiKey(p.id) ? 'key' : 'no key';
      const line = `${p.used}/${p.rpd} used, ${p.remaining} left, ${p.errors} err, ${key}`;
      if (!p.enabled) ok(p.id, `disabled — ${line}`);
      else if (!p.headroom) warn(p.id, line, 'no headroom right now');
      else ok(p.id, line);
    }
    ok('pool remaining', String(live.poolRemaining));
    return;
  }
  for (const p of providers) {
    ok(p.id, `${p.enabled ? 'enabled' : 'disabled'}, rpd ${p.rpd}, ${getApiKey(p.id) ? 'key' : 'no key'}`);
  }
}

function reportLive(live: HealthReport | null): void {
  section(`live server (${HEALTH_URL})`);
  if (!live) {
    warn('status', 'SERVER DOWN', 'start it with `pnpm dev` or `pnpm pm2:start`');
    return;
  }
  ok('status', `up, pid ${live.pid}, uptime ${Math.round(live.uptimeSec / 60)}m, node ${live.node}`);
  if (live.ws.connected) {
    ok(
      'binance ws',
      `connected, ${live.ws.symbols} symbols, last frame ${live.ws.lastMessageAgoMs ?? '?'}ms ago`,
    );
  } else {
    warn('binance ws', `disconnected (reconnect attempt ${live.ws.reconnectAttempt})`, 'no live prices');
  }
  if (live.marketWarm) ok('market warm', 'yes');
  else warn('market warm', 'no', 'backfill still running — bots are gated');
  ok('bots', `${live.bots.running} running, ${live.bots.stopped} stopped, ${live.bots.busted} busted`);
  if (live.evaluator) {
    ok(
      'evaluator',
      `last run ${fmtAge(live.evaluator.agoSec * 1000)}, ${live.evaluator.written} written, ${live.evaluator.skipped} skipped`,
    );
  } else {
    ok('evaluator', 'no run yet this boot (cron every 15 min)');
  }
}

async function main(): Promise<void> {
  console.log('Wick doctor');
  const live = await fetchHealth();
  reportEnvironment();
  reportLive(live);
  reportProviders(live);
  reportDb();

  section('summary');
  if (warnings.length === 0) {
    console.log('  all checks clean');
  } else {
    for (const w of warnings) console.log(`  ! ${w}`);
  }
  console.log();
  db.close();
}

void main().catch((err: unknown) => {
  console.error('doctor failed:', err);
  process.exit(1);
});
