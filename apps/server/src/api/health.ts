/**
 * Ops surface (IMPL-4 §7.4). `GET /health` answers the five questions you ask
 * when Wick has been running unattended for a week:
 *   is the market feed alive · is the data warm · how much LLM quota is left
 *   per provider · how many bots are running · when did the evaluator last run.
 *
 * `pnpm doctor` prints exactly this report (plus versions), so the shape lives
 * here and is reused rather than duplicated.
 */

import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { db, DB_PATH } from '../db/client.js';
import { wsStatus, type WsStatus } from '../collectors/crypto/binance-ws.js';
import { isMarketWarm } from '../market/market-state.js';
import { getProviders } from '../llm/providers.js';
import { getUsage, poolRemaining, hasHeadroom } from '../llm/quota.js';
import { lastEvaluatorRun } from '../learn/evaluator.js';
import { nowMs } from '../util/time.js';

export interface ProviderHeadroom {
  id: string;
  enabled: boolean;
  rpd: number;
  used: number;
  errors: number;
  /** rpd − used today (UTC). */
  remaining: number;
  /** False when disabled, rpd spent, or the rpm bucket is empty right now. */
  headroom: boolean;
}

export interface HealthReport {
  ok: boolean;
  ts: number;
  uptimeSec: number;
  pid: number;
  node: string;
  ws: WsStatus;
  marketWarm: boolean;
  providers: ProviderHeadroom[];
  poolRemaining: number;
  bots: { total: number; running: number; stopped: number; busted: number };
  evaluator: { lastRunTs: number; agoSec: number; written: number; skipped: number } | null;
  db: DbStats;
}

export interface DbStats {
  path: string;
  sizeMb: number;
  decisions: number;
  fills: number;
  openPositions: number;
  candles1m: number;
  triggerLog: number;
  /** Newest decision ts, ms (null when the bots have never decided). */
  lastDecisionTs: number | null;
}

function count(sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { n: number };
  return row.n;
}

export function dbStats(): DbStats {
  let sizeMb = 0;
  try {
    sizeMb = Math.round((fs.statSync(DB_PATH).size / 1_048_576) * 100) / 100;
  } catch {
    /* file may be mid-checkpoint — size is cosmetic */
  }
  const last = db.prepare('SELECT MAX(ts) AS n FROM decisions').get() as { n: number | null };
  return {
    path: DB_PATH,
    sizeMb,
    decisions: count('SELECT COUNT(*) AS n FROM decisions'),
    fills: count('SELECT COUNT(*) AS n FROM fills'),
    openPositions: count('SELECT COUNT(*) AS n FROM positions WHERE qty > 1e-12'),
    candles1m: count("SELECT COUNT(*) AS n FROM candles WHERE tf = '1m'"),
    triggerLog: count('SELECT COUNT(*) AS n FROM trigger_log'),
    lastDecisionTs: last.n,
  };
}

export function healthReport(): HealthReport {
  const ts = nowMs();
  const providers = getProviders();
  const evalRun = lastEvaluatorRun();
  const statuses = db
    .prepare('SELECT status, COUNT(*) AS n FROM bots GROUP BY status')
    .all() as Array<{ status: string; n: number }>;
  const byStatus = (s: string): number => statuses.find((r) => r.status === s)?.n ?? 0;

  return {
    ok: true,
    ts,
    uptimeSec: Math.round(process.uptime()),
    pid: process.pid,
    node: process.version,
    ws: wsStatus(),
    marketWarm: isMarketWarm(),
    providers: providers.map((p) => {
      const usage = getUsage(p.id, ts);
      return {
        id: p.id,
        enabled: p.enabled,
        rpd: p.rpd,
        used: usage.calls,
        errors: usage.errors,
        remaining: Math.max(0, p.rpd - usage.calls),
        headroom: hasHeadroom(p, ts),
      };
    }),
    poolRemaining: poolRemaining(providers, ts),
    bots: {
      total: statuses.reduce((a, r) => a + r.n, 0),
      running: byStatus('running'),
      stopped: byStatus('stopped'),
      busted: byStatus('busted'),
    },
    evaluator: evalRun
      ? {
          lastRunTs: evalRun.ts,
          agoSec: Math.round((ts - evalRun.ts) / 1000),
          written: evalRun.run.written,
          skipped: evalRun.run.skipped,
        }
      : null,
    db: dbStats(),
  };
}

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => healthReport());
}
