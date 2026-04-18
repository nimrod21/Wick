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
import {
  backfillHistorical,
  aggregateAll,
  startAggregationCron,
  stopAggregationCron,
} from './collectors/crypto/binance-rest.js';
import {
  startBinanceWs,
  stopBinanceWs,
} from './collectors/crypto/binance-ws.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import {
  startTwelveData,
  stopTwelveData,
} from './collectors/stocks/twelvedata.js';
import {
  startFinnhubNews,
  stopFinnhubNews,
} from './collectors/stocks/finnhub.js';
import { startYahoo, stopYahoo } from './collectors/stocks/yahoo.js';
import {
  startEtherscan,
  stopEtherscan,
} from './collectors/onchain/eth-etherscan.js';
import { startHelius, stopHelius } from './collectors/onchain/sol-helius.js';
import {
  startBlockstream,
  stopBlockstream,
} from './collectors/onchain/btc-blockstream.js';
import {
  startSnapshotCron,
  stopSnapshotCron,
} from './core/snapshot-job.js';
import { startAlertEngine, stopAlertEngine } from './core/alert-engine.js';
import {
  startProbabilityEngine,
  stopProbabilityEngine,
} from './core/probability-engine.js';
import { startFearGreed, stopFearGreed } from './collectors/macro/fear-greed.js';
import { startDxyVix, stopDxyVix } from './collectors/macro/dxy-vix.js';
import { startFundingOi, stopFundingOi } from './collectors/macro/funding-oi.js';
import {
  startBtcDominance,
  stopBtcDominance,
} from './collectors/macro/btc-dominance.js';
import { startFred, stopFred } from './collectors/macro/fred.js';
import { startRssNews, stopRssNews } from './collectors/news/rss.js';
import {
  startCryptoPanic,
  stopCryptoPanic,
} from './collectors/news/cryptopanic.js';
import {
  startFillScanCron,
  stopFillScanCron,
} from './execution/paper-mode.js';
import { orderManager } from './execution/order-manager.js';
import {
  reconcileCcxtOnBoot,
  stopCcxtPolls,
} from './execution/crypto-ccxt.js';

import cryptoWatchlist from './seed/crypto_watchlist.json' with { type: 'json' };
import stockWatchlist from './seed/stock_watchlist.json' with { type: 'json' };
import commodityWatchlist from './seed/commodity_watchlist.json' with { type: 'json' };
import whaleAddressesSeed from './seed/whale_addresses.json' with { type: 'json' };
import ignoreAddressesSeed from './seed/ignore_addresses.json' with { type: 'json' };

interface SeedAsset {
  symbol: string;
  display_name: string;
  type: 'crypto' | 'stock' | 'etf' | 'forex' | 'commodity' | 'index';
  exchange?: string | null;
  tradeable_via?: 'ccxt' | 'alpaca' | null;
  tradeable_symbol?: string | null;
}

interface SeedWhale {
  chain: 'eth' | 'sol' | 'btc';
  address: string;
  label?: string | null;
  tags?: string[];
}

interface SeedIgnore {
  chain: 'eth' | 'sol' | 'btc';
  address: string;
  label?: string | null;
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

function loadWhaleSeedsIfEmpty(): void {
  const { count } = db
    .prepare('SELECT COUNT(*) AS count FROM whale_addresses')
    .get() as { count: number };
  if (count === 0) {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO whale_addresses
         (chain, address, label, tags_json, added_at, enabled)
       VALUES (?, ?, ?, ?, ?, 1)`,
    );
    const tx = db.transaction((rows: SeedWhale[]) => {
      const ts = nowSec();
      for (const r of rows) {
        const addr = r.chain === 'eth' ? r.address.toLowerCase() : r.address;
        insert.run(
          r.chain,
          addr,
          r.label ?? null,
          r.tags ? JSON.stringify(r.tags) : null,
          ts,
        );
      }
    });
    tx(whaleAddressesSeed as SeedWhale[]);
    logger.info(
      { inserted: (whaleAddressesSeed as SeedWhale[]).length },
      'seed whale_addresses loaded',
    );
  } else {
    logger.info({ count }, 'whale_addresses populated — skipping seed');
  }

  const { count: ignoreCount } = db
    .prepare('SELECT COUNT(*) AS count FROM ignore_addresses')
    .get() as { count: number };
  if (ignoreCount === 0) {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO ignore_addresses (chain, address, label)
       VALUES (?, ?, ?)`,
    );
    const tx = db.transaction((rows: SeedIgnore[]) => {
      for (const r of rows) {
        const addr = r.chain === 'eth' ? r.address.toLowerCase() : r.address;
        insert.run(r.chain, addr, r.label ?? null);
      }
    });
    tx(ignoreAddressesSeed as SeedIgnore[]);
    logger.info(
      { inserted: (ignoreAddressesSeed as SeedIgnore[]).length },
      'seed ignore_addresses loaded',
    );
  } else {
    logger.info({ count: ignoreCount }, 'ignore_addresses populated — skipping seed');
  }
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
  loadWhaleSeedsIfEmpty();

  const app = await buildServer();
  await app.listen({ host: config.server.host, port: config.server.port });
  logger.info(
    { host: config.server.host, port: config.server.port },
    'cockpit server listening',
  );

  const heartbeat = startHeartbeat();
  logger.info('heartbeat cron started (every 10s)');

  // Phase 2 wave 1: crypto collectors.
  // 1) Kick off historical backfill (non-blocking). When it finishes,
  //    aggregate the last 90 days once to populate higher timeframes.
  void backfillHistorical()
    .then(async () => {
      logger.info('backfill finished; running one-shot aggregation over 90d');
      const ninetyDays = 90 * 24 * 3600;
      await aggregateAll(nowSec() - ninetyDays);
    })
    .catch((err) => {
      logger.error({ err }, 'backfill/aggregate pipeline failed');
    });

  // 2) Hourly cron keeps higher timeframes up-to-date as new 1m bars arrive.
  startAggregationCron();

  // 3) WS collector: connect and subscribe to every enabled binance asset.
  //    Awaited so any immediate errors surface during boot.
  try {
    await startBinanceWs();
  } catch (err) {
    logger.error({ err }, 'binance ws failed to start (non-fatal)');
  }

  // Phase 3: non-crypto collectors + cron scheduler.
  // Each start() is safe to call even if its API key is missing — the
  // collector just no-ops. The scheduler drives the per-minute/per-5-min
  // ticks independently.
  try {
    startTwelveData();
    startFinnhubNews();
    startYahoo();
    startScheduler();
  } catch (err) {
    logger.error({ err }, 'phase-3 collectors failed to start (non-fatal)');
  }

  // Phase 4: whale tracker collectors + snapshot-job cron.
  try {
    startEtherscan();
    startHelius();
    startBlockstream();
    startSnapshotCron();
  } catch (err) {
    logger.error({ err }, 'phase-4 collectors failed to start (non-fatal)');
  }

  // Phase 6: macro / crypto indicators. Idempotent — `startScheduler` also
  // wires these up, so double-calls are no-ops.
  try {
    startFearGreed();
    startDxyVix();
    startFundingOi();
    startBtcDominance();
    startFred();
  } catch (err) {
    logger.error({ err }, 'phase-6 collectors failed to start (non-fatal)');
  }

  // Phase 5: news collectors. Idempotent — `startScheduler` also starts
  // them, so double-calls are no-ops.
  try {
    startRssNews();
    startCryptoPanic();
  } catch (err) {
    logger.error({ err }, 'phase-5 collectors failed to start (non-fatal)');
  }

  // Phase 7: probability engine — runs after collectors so signals have
  // at least a chance to have data. Scores assets every minute.
  try {
    startProbabilityEngine();
  } catch (err) {
    logger.error({ err }, 'phase-7 probability engine failed to start (non-fatal)');
  }

  // Phase 8: alert engine — subscribes to the event bus and fires on
  // matching rules. Must start *after* collectors so it begins buffering
  // candles for the `price_move` rolling window.
  try {
    startAlertEngine();
  } catch (err) {
    logger.error({ err }, 'phase-8 alert engine failed to start (non-fatal)');
  }

  // Phase 9: paper-mode fill-scan cron (crosses queued limit/stop orders
  // against the latest 1m candle) + order-manager watcher for live
  // brokers (polls ccxt/alpaca for status on open orders).
  try {
    startFillScanCron();
    orderManager.start();
  } catch (err) {
    logger.error({ err }, 'phase-9 execution layer failed to start (non-fatal)');
  }

  // Phase 10: ccxt boot-time reconciliation. Best-effort; skipped when
  // no binance key is present. Non-blocking so we don't delay listen().
  void reconcileCcxtOnBoot().catch((err) => {
    logger.warn({ err }, 'ccxt reconcile failed (non-fatal)');
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown requested');
    try {
      heartbeat.stop();
      stopScheduler();
      stopAggregationCron();
      stopTwelveData();
      stopFinnhubNews();
      stopYahoo();
      stopEtherscan();
      stopHelius();
      stopBlockstream();
      stopSnapshotCron();
      stopFearGreed();
      stopDxyVix();
      stopFundingOi();
      stopBtcDominance();
      stopFred();
      stopRssNews();
      stopCryptoPanic();
      stopProbabilityEngine();
      stopAlertEngine();
      stopFillScanCron();
      orderManager.stop();
      stopCcxtPolls();
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
