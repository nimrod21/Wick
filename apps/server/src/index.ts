import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';
import { config, setMasterKey } from './config.js';
import { logger } from './util/logger.js';
import { nowSec } from './util/time.js';
import { db } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { eventBus } from './core/event-bus.js';
import { buildServer } from './api/server.js';
import type { IndicatorEvent } from '@cockpit/shared';

import cryptoWatchlist from './seed/crypto_watchlist.json' with { type: 'json' };
import stockWatchlist from './seed/stock_watchlist.json' with { type: 'json' };
import commodityWatchlist from './seed/commodity_watchlist.json' with { type: 'json' };

interface SeedAsset {
  symbol: string;
  display_name: string;
  type: 'crypto' | 'stock' | 'etf' | 'forex' | 'commodity' | 'index';
  exchange?: string | null;
  tradeable_via?: 'ccxt' | 'alpaca' | null;
  tradeable_symbol?: string | null;
}

function ensureMasterKey(): void {
  if (config.masterKey && config.masterKey.length >= 32) return;
  const generated = crypto.randomBytes(32).toString('hex');
  const envPath = path.join(process.cwd(), '.env');
  try {
    let current = '';
    if (fs.existsSync(envPath)) {
      current = fs.readFileSync(envPath, 'utf8');
    }
    if (/^COCKPIT_MASTER_KEY=/m.test(current)) {
      // Replace empty value line
      current = current.replace(/^COCKPIT_MASTER_KEY=.*$/m, `COCKPIT_MASTER_KEY=${generated}`);
    } else {
      if (current.length && !current.endsWith('\n')) current += '\n';
      current += `COCKPIT_MASTER_KEY=${generated}\n`;
    }
    fs.writeFileSync(envPath, current, { mode: 0o600 });
    // eslint-disable-next-line no-console
    console.log(
      `[cockpit] Generated COCKPIT_MASTER_KEY and wrote it to ${envPath}. Keep this value safe — it decrypts your stored API keys.`,
    );
  } catch (err) {
    logger.error({ err }, 'failed to persist generated master key');
  }
  setMasterKey(generated);
}

function loadSeedsIfEmpty(): void {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM assets').get() as {
    count: number;
  };
  if (count > 0) {
    logger.info({ count }, 'assets table populated — skipping seed load');
    return;
  }

  const all: SeedAsset[] = [
    ...(cryptoWatchlist as SeedAsset[]),
    ...(stockWatchlist as SeedAsset[]),
    ...(commodityWatchlist as SeedAsset[]),
  ];

  const insert = db.prepare(
    `INSERT OR IGNORE INTO assets
       (symbol, display_name, type, exchange, tradeable_via, tradeable_symbol,
        metadata_json, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?)`,
  );

  const tx = db.transaction((rows: SeedAsset[]) => {
    const ts = nowSec();
    for (const r of rows) {
      insert.run(
        r.symbol,
        r.display_name,
        r.type,
        r.exchange ?? null,
        r.tradeable_via ?? null,
        r.tradeable_symbol ?? null,
        ts,
      );
    }
  });
  tx(all);
  logger.info({ inserted: all.length }, 'seed watchlists loaded');
}

function startHeartbeat(): cron.ScheduledTask {
  let seq = 1;
  // "every 10 seconds" cron expression (6-field, with seconds)
  const task = cron.schedule('*/10 * * * * *', () => {
    const evt: IndicatorEvent = {
      id: seq++,
      ts: nowSec(),
      source: 'system',
      severity: 0,
      kind: 'indicator',
      name: 'heartbeat',
      value: Math.random(),
    };
    eventBus.emit(evt);
  });
  return task;
}

async function main(): Promise<void> {
  ensureMasterKey();

  const migrated = runMigrations();
  logger.info(
    { applied: migrated.applied, skipped: migrated.skipped.length },
    'migrations ready',
  );

  loadSeedsIfEmpty();

  const app = await buildServer();
  await app.listen({ host: config.server.host, port: config.server.port });
  logger.info(
    { host: config.server.host, port: config.server.port },
    'cockpit server listening',
  );

  const heartbeat = startHeartbeat();
  logger.info('heartbeat cron started (every 10s)');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown requested');
    try {
      heartbeat.stop();
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
