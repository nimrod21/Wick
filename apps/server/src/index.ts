/**
 * Wick server boot: config → db+migrate(+seed) → vault master key →
 * event bus → API server → SSE (served by the API server).
 *
 * Collector wiring is present but DISABLED for Phase 0 — Phase 1 turns it
 * on after verifying backfill/WS behaviour against the new schema.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, setMasterKey } from './config.js';
import { logger } from './util/logger.js';
import { db } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { buildServer } from './api/server.js';
import { backfillAll } from './collectors/crypto/binance-rest.js';
import {
  flushKlineBuffer,
  startBinanceWs,
  stopBinanceWs,
} from './collectors/crypto/binance-ws.js';
import {
  computeAll,
  startIndicatorEngine,
  stopIndicatorEngine,
} from './market/indicator-engine.js';
import { setMarketWarm } from './market/market-state.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { startEquityCron, stopEquityCron } from './paper/engine.js';
import { startProtector, stopProtector } from './paper/protector.js';
import { startTriggerEngine, stopTriggerEngine } from './market/trigger-engine.js';
import { startBotScheduler, stopBotScheduler } from './bots/scheduler.js';
import { seedDefaultBots } from './bots/bot-store.js';
import { resumeBots, stopBustedCron } from './bots/boot.js';

function ensureMasterKey(): void {
  if (config.masterKey && config.masterKey.length >= 32) return;
  const generated = crypto.randomBytes(32).toString('hex');
  // Resolve .env relative to this file (apps/server/src|dist/index.*), walk up to repo root
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(here, '..', '..', '..', '.env');
  try {
    let current = '';
    if (fs.existsSync(envPath)) {
      current = fs.readFileSync(envPath, 'utf8');
    }
    if (/^WICK_MASTER_KEY=/m.test(current)) {
      // Replace empty value line
      current = current.replace(/^WICK_MASTER_KEY=.*$/m, `WICK_MASTER_KEY=${generated}`);
    } else {
      if (current.length && !current.endsWith('\n')) current += '\n';
      current += `WICK_MASTER_KEY=${generated}\n`;
    }
    fs.writeFileSync(envPath, current, { mode: 0o600 });
    // eslint-disable-next-line no-console
    console.log(
      `[wick] Generated WICK_MASTER_KEY and wrote it to ${envPath}. Keep this value safe — it decrypts your stored API keys.`,
    );
  } catch (err) {
    logger.error({ err }, 'failed to persist generated master key');
  }
  setMasterKey(generated);
}

async function main(): Promise<void> {
  // 1. Vault master key (config is already parsed at import time).
  ensureMasterKey();

  // 2. DB: migrate + seed (7 watchlist assets, default settings rows).
  const migrated = runMigrations();
  logger.info(
    { applied: migrated.applied, skipped: migrated.skipped.length },
    'migrations ready',
  );

  // 3. Event bus is a module-level singleton (core/event-bus.ts) — no boot
  //    step needed; SSE subscribes to it inside the API server.

  // 4. API server (includes /api/sse stream).
  const app = await buildServer();
  await app.listen({ host: config.server.host, port: config.server.port });
  logger.info(
    { host: config.server.host, port: config.server.port },
    'wick server listening',
  );

  // 5. Market data pipeline (Phase 1).
  //    Scheduler first: funding + fear-greed initial polls kick off async so
  //    the boot indicator pass usually has both. Then WS (buffers closed
  //    klines), then REST backfill; on completion flush the buffer, flip
  //    marketWarm, and run one full indicator pass so /api/market/indicators
  //    answers immediately.
  startScheduler();
  startEquityCron();
  startProtector(); // arms its SL/TP index once marketWarm fires below
  seedDefaultBots(); // two default bots on first boot (idempotent by name)
  await startBinanceWs();
  void (async () => {
    try {
      await backfillAll();
      flushKlineBuffer();
      setMarketWarm();
      startIndicatorEngine();
      computeAll();
      // 6. Bots (Phase 4): resume running bots, start cadence + trigger wakes.
      //    Strictly after marketWarm (PLAN §16.9) so nothing wakes on a
      //    half-filled candle store.
      resumeBots();
    } catch (err) {
      logger.error({ err }, 'market warm-up failed');
    }
  })();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown requested');
    try {
      stopBotScheduler();
      stopTriggerEngine();
      stopBustedCron();
      stopScheduler();
      stopProtector();
      stopEquityCron();
      stopIndicatorEngine();
      await stopBinanceWs();
      await app.close();
      db.close();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal error during startup');
  process.exit(1);
});
