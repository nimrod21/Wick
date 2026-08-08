/**
 * Data hygiene (IMPL-4 §7.3). Wick is meant to run for months on one box, so
 * three chores run themselves:
 *
 *   nightly 03:20 — prune 1m candles older than 14d and trigger_log rows older
 *                   than 30d, then write a rotated backup of the DB (×3).
 *   weekly  Sun 03:40 — VACUUM, SKIPPED if a fill landed in the last minute
 *                   (IMPL-4 pitfall: VACUUM takes an exclusive lock).
 *
 * Only 1m candles are pruned — 15m/1h/4h/1d are tiny and the evaluator prices
 * decisions off the 1h series, which must stay complete. Decisions, fills,
 * outcomes and journal rows are NEVER pruned: that history is the product.
 *
 * SSE clients need no GC pass — `api/sse.ts` unsubscribes on the socket's
 * 'close' event, so a dropped browser tab releases its bus subscription
 * immediately.
 */

import fs from 'node:fs';
import path from 'node:path';
import cron, { type ScheduledTask } from 'node-cron';
import { db, DB_PATH } from '../db/client.js';
import { logger } from '../util/logger.js';
import { nowMs } from '../util/time.js';

export const CANDLE_1M_RETENTION_MS = 14 * 86_400_000;
export const TRIGGER_LOG_RETENTION_MS = 30 * 86_400_000;
/** A fill this recently means the engine is active — don't take the lock. */
export const VACUUM_FILL_QUIET_MS = 60_000;
export const BACKUP_KEEP = 3;

export const BACKUP_DIR = path.join(path.dirname(DB_PATH), 'backups');

export interface PruneResult {
  candles1m: number;
  triggerLog: number;
}

/** Delete aged rows. Idempotent, cheap, safe to run any time. */
export function prune(ts: number = nowMs()): PruneResult {
  const candles = db
    .prepare("DELETE FROM candles WHERE tf = '1m' AND ts < ?")
    .run(ts - CANDLE_1M_RETENTION_MS);
  const triggers = db
    .prepare('DELETE FROM trigger_log WHERE ts < ?')
    .run(ts - TRIGGER_LOG_RETENTION_MS);
  const result = { candles1m: candles.changes, triggerLog: triggers.changes };
  if (result.candles1m > 0 || result.triggerLog > 0) {
    logger.info(result, 'hygiene: pruned aged rows');
  }
  return result;
}

/**
 * Online backup (better-sqlite3 `backup()` — WAL-safe, no writer lock) into
 * `data/backups/`, keeping the newest BACKUP_KEEP files. Returns the file
 * written, or null on failure (a failed backup must never take the app down).
 */
export async function backup(ts: number = nowMs()): Promise<string | null> {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date(ts).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const dest = path.join(BACKUP_DIR, `wick-${stamp}.db`);
    await db.backup(dest);

    const stale = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('wick-') && f.endsWith('.db'))
      .sort()
      .reverse()
      .slice(BACKUP_KEEP);
    for (const f of stale) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, f));
      } catch (err) {
        logger.warn({ err, file: f }, 'hygiene: could not remove old backup');
      }
    }
    logger.info({ dest, rotated: stale.length }, 'hygiene: backup written');
    return dest;
  } catch (err) {
    logger.error({ err }, 'hygiene: backup failed');
    return null;
  }
}

/** VACUUM unless a fill landed within VACUUM_FILL_QUIET_MS. */
export function vacuumIfQuiet(ts: number = nowMs()): 'vacuumed' | 'skipped' {
  const row = db.prepare('SELECT MAX(ts) AS m FROM fills').get() as { m: number | null };
  if (row.m !== null && ts - row.m < VACUUM_FILL_QUIET_MS) {
    logger.info({ lastFillAgoMs: ts - row.m }, 'hygiene: VACUUM skipped, recent fill');
    return 'skipped';
  }
  db.exec('VACUUM');
  logger.info('hygiene: VACUUM complete');
  return 'vacuumed';
}

// ── lifecycle ──────────────────────────────────────────────────────────

const tasks: ScheduledTask[] = [];

export function startHygiene(): void {
  if (tasks.length > 0) return;
  tasks.push(
    cron.schedule('20 3 * * *', () => {
      try {
        prune();
        void backup();
      } catch (err) {
        logger.error({ err }, 'hygiene: nightly pass failed');
      }
    }),
  );
  tasks.push(
    cron.schedule('40 3 * * 0', () => {
      try {
        vacuumIfQuiet();
      } catch (err) {
        logger.error({ err }, 'hygiene: weekly VACUUM failed');
      }
    }),
  );
  logger.info('hygiene started (nightly prune+backup 03:20, weekly VACUUM Sun 03:40)');
}

export function stopHygiene(): void {
  for (const t of tasks) {
    try {
      t.stop();
    } catch (err) {
      logger.error({ err }, 'hygiene: stop failed');
    }
  }
  tasks.length = 0;
}
