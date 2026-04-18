/**
 * Snapshot job — forward-price snapshots for significant events.
 *
 * When a qualifying event lands (whale tx >= $500k, high-sentiment news,
 * etc. — see PLAN.md §12 and IMPL-3 §4.7), we insert one row per horizon
 * into `events_price_snapshots` with `captured_ts = NULL` and the event's
 * current asset price. A cron running every 30s then fills in the forward
 * price for each horizon once that horizon's time has elapsed.
 *
 * Horizons: 5m, 30m, 1h, 4h, 1d, 3d, 1w, 3w.
 *
 * Chain-representative asset mapping: whale txs don't map to a single
 * asset, so the caller passes the chain-native asset id (ETH for eth txs,
 * SOL for sol txs, BTC for btc txs). This convention is documented where
 * whale collectors invoke `scheduleSnapshot`.
 */

import cron, { type ScheduledTask } from 'node-cron';
import { db } from '../db/client.js';
import { logger } from '../util/logger.js';
import { nowSec } from '../util/time.js';

type Horizon = '5m' | '30m' | '1h' | '4h' | '1d' | '3d' | '1w' | '3w';

const HORIZON_SECONDS: Record<Horizon, number> = {
  '5m': 300,
  '30m': 1_800,
  '1h': 3_600,
  '4h': 14_400,
  '1d': 86_400,
  '3d': 259_200,
  '1w': 604_800,
  '3w': 1_814_400,
};

const HORIZONS: readonly Horizon[] = [
  '5m',
  '30m',
  '1h',
  '4h',
  '1d',
  '3d',
  '1w',
  '3w',
];

const insertSnapshotStmt = db.prepare(
  `INSERT OR IGNORE INTO events_price_snapshots
     (event_id, asset_id, horizon, captured_ts, price, pct_change, event_price)
   VALUES (?, ?, ?, NULL, NULL, NULL, ?)`,
);

const latestCloseStmt = db.prepare(
  `SELECT c AS close FROM candles_1m
    WHERE asset_id = ?
    ORDER BY ts DESC
    LIMIT 1`,
);

const pendingStmt = db.prepare(
  `SELECT eps.event_id AS event_id,
          eps.asset_id AS asset_id,
          eps.horizon  AS horizon,
          eps.event_price AS event_price,
          e.ts AS event_ts
     FROM events_price_snapshots eps
     JOIN events e ON e.id = eps.event_id
    WHERE eps.captured_ts IS NULL`,
);

const updateSnapshotStmt = db.prepare(
  `UPDATE events_price_snapshots
      SET captured_ts = ?,
          price       = ?,
          pct_change  = ?
    WHERE event_id = ? AND asset_id = ? AND horizon = ?`,
);

const markMissedStmt = db.prepare(
  `UPDATE events_price_snapshots
      SET captured_ts = -1
    WHERE event_id = ? AND asset_id = ? AND horizon = ?`,
);

let task: ScheduledTask | null = null;

/**
 * Schedule 8 forward-price snapshots for a newly-recorded event.
 *
 * @param eventId    Row id in `events`.
 * @param assetId    Asset id to track forward prices for.
 * @param eventPrice The asset's price at the moment the event fired.
 *                   Stored so pct_change can be computed when each
 *                   horizon elapses, independent of the original price
 *                   feed state at capture time.
 */
export function scheduleSnapshot(
  eventId: number,
  assetId: number,
  eventPrice: number,
): void {
  if (!Number.isFinite(eventPrice) || eventPrice <= 0) {
    logger.warn(
      { eventId, assetId, eventPrice },
      'snapshot-job: refusing to schedule with non-positive event_price',
    );
    return;
  }
  const tx = db.transaction(() => {
    for (const h of HORIZONS) {
      insertSnapshotStmt.run(eventId, assetId, h, eventPrice);
    }
  });
  try {
    tx();
  } catch (err) {
    logger.error({ err, eventId, assetId }, 'snapshot-job: scheduling failed');
  }
}

/**
 * Read the most recent 1m close for an asset. Returns null when no bars
 * are available yet (e.g. during initial backfill).
 */
export function latestClose(assetId: number): number | null {
  const row = latestCloseStmt.get(assetId) as { close: number } | undefined;
  if (!row || !Number.isFinite(row.close)) return null;
  return row.close;
}

interface PendingRow {
  event_id: number;
  asset_id: number;
  horizon: Horizon;
  event_price: number | null;
  event_ts: number;
}

function processPending(): void {
  const now = nowSec();
  const rows = pendingStmt.all() as PendingRow[];
  if (rows.length === 0) return;

  let captured = 0;
  let missed = 0;
  for (const row of rows) {
    const horizonSec = HORIZON_SECONDS[row.horizon];
    const dueAt = row.event_ts + horizonSec;
    if (now < dueAt) continue; // not yet time

    // Sentinel for irrecoverably stale snapshots — if the horizon has
    // slipped by more than 2x its length we can no longer consider the
    // capture meaningful (server was down, etc.). Mark captured_ts=-1.
    if (now - dueAt > 2 * horizonSec) {
      try {
        markMissedStmt.run(row.event_id, row.asset_id, row.horizon);
        missed += 1;
      } catch (err) {
        logger.error(
          { err, eventId: row.event_id, horizon: row.horizon },
          'snapshot-job: mark-missed failed',
        );
      }
      continue;
    }

    const price = latestClose(row.asset_id);
    if (price === null) continue; // wait for a candle to appear

    const eventPrice = row.event_price;
    const pctChange =
      eventPrice && eventPrice > 0 ? (price - eventPrice) / eventPrice : null;

    try {
      updateSnapshotStmt.run(
        now,
        price,
        pctChange,
        row.event_id,
        row.asset_id,
        row.horizon,
      );
      captured += 1;
    } catch (err) {
      logger.error(
        { err, eventId: row.event_id, horizon: row.horizon },
        'snapshot-job: capture failed',
      );
    }
  }

  if (captured > 0 || missed > 0) {
    logger.info({ captured, missed, pending: rows.length }, 'snapshot tick');
  }
}

export function startSnapshotCron(): void {
  if (task) return;
  task = cron.schedule('*/30 * * * * *', () => {
    try {
      processPending();
    } catch (err) {
      logger.error({ err }, 'snapshot-job: tick failed');
    }
  });
  logger.info('snapshot-job cron started (every 30s)');
}

export function stopSnapshotCron(): void {
  if (!task) return;
  try {
    task.stop();
  } catch (err) {
    logger.error({ err }, 'snapshot-job: stop failed');
  }
  task = null;
}

export const HORIZON_SECONDS_MAP = HORIZON_SECONDS;
