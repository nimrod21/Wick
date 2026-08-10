/**
 * Indicator stats & adaptive weights (IMPL-3 §5.2, PLAN §11.2).
 *
 * Every 4h `outcome` event replays the decision's snapshot: each indicator's
 * vote is scored hit/miss against the realised direction, per (bot, indicator).
 * A daily cron turns those hit-rates into weights and toggles.
 *
 * SLOW BY DESIGN — the floors below are LOCKED (PLAN §11, IMPL-3 pitfall #3).
 * Do not tune them down to see movement sooner:
 *   - no weight moves at all until samples >= 30
 *   - multiplicative update with alpha 0.1, clamped to [0.25, 2.0]
 *   - auto-disable only at samples >= 100 AND smoothed hit-rate < 0.45
 *
 * Disabled indicators are NOT deleted: they stay in `snapshot_json` marked
 * `shadow: true` so their votes keep accumulating, and they are excluded from
 * the prompt. Every 4th week a re-trial window lets a recovered indicator
 * earn its way back in (regimes change).
 *
 * Indicator names join 1:1 on `INDICATOR_DEFS` keys — this module never
 * rewrites them (IMPL-3 pitfall #5).
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { OutcomeEvent } from '@wick/shared';
import { db } from '../db/client.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../util/logger.js';
import { nowMs } from '../util/time.js';

// ── locked constants (PLAN §11) ────────────────────────────────────────

/** No weight moves below this many samples. LOCKED. */
export const SAMPLE_FLOOR = 30;
/** Auto-disable is only considered from this many samples. LOCKED. */
export const DISABLE_FLOOR = 100;
/** Auto-disable below this smoothed hit-rate. LOCKED. */
export const DISABLE_HIT_RATE = 0.45;
/** Multiplicative update rate. LOCKED. */
export const ALPHA = 0.1;
export const WEIGHT_MIN = 0.25;
export const WEIGHT_MAX = 2.0;

/** Dead band: a move smaller than this has no direction to be right about. */
export const DIRECTION_BAND_PCT = 0.3;

/** Re-trial: a disabled indicator may be re-enabled during 1 week in 4. */
const WEEK_MS = 7 * 86_400_000;
/** Samples needed inside the recent window before a re-trial can re-enable. */
export const RETRIAL_MIN_SAMPLES = 30;
/** Recent smoothed hit-rate a disabled indicator must reach to come back. */
export const RETRIAL_HIT_RATE = 0.5;
/** How many recent evaluated decisions the re-trial check replays. */
const RETRIAL_SCAN = 200;

// ── math ───────────────────────────────────────────────────────────────

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Laplace-smoothed hit-rate (PLAN §11): (hits + 1) / (samples + 2). */
export function laplaceHitRate(hits: number, samples: number): number {
  return (hits + 1) / (samples + 2);
}

/**
 * Did this vote call the direction? `null` means "skip this sample":
 * a neutral/absent vote, or a move inside the ±0.3% dead band.
 */
export function voteHit(vote: string | null | undefined, fwdRetPct: number): boolean | null {
  if (vote !== 'bull' && vote !== 'bear') return null;
  if (Math.abs(fwdRetPct) <= DIRECTION_BAND_PCT) return null;
  return vote === 'bull' ? fwdRetPct > 0 : fwdRetPct < 0;
}

/**
 * Re-trial weeks are a fixed 1-in-4 cadence on the UTC week counter, so the
 * window is derivable from the clock alone — `indicator_stats` keeps exactly
 * the columns PLAN §6 specifies (no disabled-at bookkeeping column).
 */
export function isRetrialWeek(ts: number = nowMs()): boolean {
  return Math.floor(ts / WEEK_MS) % 4 === 3;
}

// ── reads ──────────────────────────────────────────────────────────────

export interface IndicatorStatRow {
  bot_id: number;
  indicator: string;
  samples: number;
  hits: number;
  weight: number;
  enabled: number;
  updated_ts: number;
}

export interface IndicatorStatView {
  indicator: string;
  samples: number;
  hits: number;
  weight: number;
  enabled: boolean;
  /** Laplace-smoothed; null until the indicator has any sample at all. */
  hitRate: number | null;
  updatedTs: number;
}

function toView(row: IndicatorStatRow): IndicatorStatView {
  return {
    indicator: row.indicator,
    samples: row.samples,
    hits: row.hits,
    weight: row.weight,
    enabled: row.enabled === 1,
    hitRate: row.samples > 0 ? laplaceHitRate(row.hits, row.samples) : null,
    updatedTs: row.updated_ts,
  };
}

export function listIndicatorStats(botId: number): IndicatorStatView[] {
  const rows = db
    .prepare('SELECT * FROM indicator_stats WHERE bot_id = ? ORDER BY indicator')
    .all(botId) as IndicatorStatRow[];
  return rows.map(toView);
}

/** Lookup keyed by indicator name — what the snapshot builder reads. */
export function getIndicatorStats(botId: number): Map<string, IndicatorStatView> {
  return new Map(listIndicatorStats(botId).map((v) => [v.indicator, v]));
}

// ── writes: one sample per (indicator, evaluated 4h decision) ──────────

interface SnapshotIndicatorLike {
  name?: unknown;
  vote?: unknown;
}

function snapshotIndicators(snapshotJson: string | null): Array<{ name: string; vote: string | null }> {
  if (!snapshotJson) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshotJson);
  } catch {
    return [];
  }
  const raw = (parsed as { indicators?: unknown } | null)?.indicators;
  if (!Array.isArray(raw)) return [];
  const out: Array<{ name: string; vote: string | null }> = [];
  for (const entry of raw as SnapshotIndicatorLike[]) {
    if (typeof entry?.name !== 'string') continue;
    out.push({ name: entry.name, vote: typeof entry.vote === 'string' ? entry.vote : null });
  }
  return out;
}

/**
 * Fold one evaluated decision into the bot's indicator stats. Disabled
 * (shadow) indicators are recorded exactly like enabled ones — that is what
 * makes a re-trial possible. Returns how many samples were added.
 */
export function recordOutcomeVotes(
  decisionId: number,
  botId: number,
  fwdRetPct: number,
  ts: number = nowMs(),
): number {
  const row = db.prepare('SELECT snapshot_json FROM decisions WHERE id = ?').get(decisionId) as
    | { snapshot_json: string | null }
    | undefined;
  if (!row) return 0;
  const indicators = snapshotIndicators(row.snapshot_json);
  if (indicators.length === 0) return 0;

  const upsert = db.prepare(
    `INSERT INTO indicator_stats (bot_id, indicator, samples, hits, weight, enabled, updated_ts)
     VALUES (?, ?, 1, ?, 1.0, 1, ?)
     ON CONFLICT(bot_id, indicator) DO UPDATE SET
       samples    = samples + 1,
       hits       = hits + excluded.hits,
       updated_ts = excluded.updated_ts`,
  );

  let added = 0;
  const tx = db.transaction(() => {
    for (const ind of indicators) {
      const hit = voteHit(ind.vote, fwdRetPct);
      if (hit === null) continue; // neutral vote or dead-band move
      upsert.run(botId, ind.name, hit ? 1 : 0, ts);
      added += 1;
    }
  });
  tx();
  return added;
}

// ── daily recompute: weights, auto-disable, re-trial ───────────────────

/** Replay recent evaluated decisions for one indicator (re-trial check). */
export function recentVoteRecord(
  botId: number,
  indicator: string,
  scan: number = RETRIAL_SCAN,
): { samples: number; hits: number } {
  const rows = db
    .prepare(
      `SELECT d.snapshot_json AS snapshot_json, o.fwd_ret_pct AS fwd_ret_pct
         FROM decisions d
         JOIN outcomes o ON o.decision_id = d.id AND o.horizon = '4h'
        WHERE d.bot_id = ? AND d.snapshot_json IS NOT NULL
        ORDER BY d.ts DESC LIMIT ?`,
    )
    .all(botId, scan) as Array<{ snapshot_json: string; fwd_ret_pct: number | null }>;

  let samples = 0;
  let hits = 0;
  for (const r of rows) {
    if (r.fwd_ret_pct === null) continue;
    const found = snapshotIndicators(r.snapshot_json).find((i) => i.name === indicator);
    if (!found) continue;
    const hit = voteHit(found.vote, r.fwd_ret_pct);
    if (hit === null) continue;
    samples += 1;
    if (hit) hits += 1;
  }
  return { samples, hits };
}

/** UTC day bucket — one weight-history row per indicator per day. */
function dayBucket(ts: number): number {
  return Math.floor(ts / 86_400_000) * 86_400_000;
}

/**
 * Append the post-pass weight of every (bot, indicator) to
 * `indicator_weight_history` so the UI can draw weight evolution — the stats
 * table itself only ever holds the current value. Bucketed to the UTC day and
 * written with INSERT OR REPLACE, so re-running a recompute on the same day
 * overwrites its own row instead of appending a duplicate.
 */
function appendWeightHistory(ts: number, botId?: number): number {
  const rows = (
    botId === undefined
      ? db.prepare('SELECT bot_id, indicator, weight FROM indicator_stats').all()
      : db.prepare('SELECT bot_id, indicator, weight FROM indicator_stats WHERE bot_id = ?').all(botId)
  ) as Array<{ bot_id: number; indicator: string; weight: number }>;
  if (rows.length === 0) return 0;

  const day = dayBucket(ts);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO indicator_weight_history (bot_id, indicator, ts, weight)
     VALUES (?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const r of rows) insert.run(r.bot_id, r.indicator, day, r.weight);
  });
  tx();
  return rows.length;
}

export interface RecomputeChange {
  botId: number;
  indicator: string;
  kind: 'weight' | 'disabled' | 're-enabled';
  from: number;
  to: number;
  hitRate: number;
  samples: number;
}

/**
 * PLAN §11.2 daily pass. Weight moves ONLY at samples >= 30; auto-disable
 * only at samples >= 100 with hit-rate < 0.45; during a re-trial week a
 * disabled indicator whose RECENT record has recovered comes back.
 */
export function recomputeWeights(ts: number = nowMs(), botId?: number): RecomputeChange[] {
  const rows = (
    botId === undefined
      ? db.prepare('SELECT * FROM indicator_stats ORDER BY bot_id, indicator').all()
      : db
          .prepare('SELECT * FROM indicator_stats WHERE bot_id = ? ORDER BY indicator')
          .all(botId)
  ) as IndicatorStatRow[];

  const changes: RecomputeChange[] = [];
  const setWeight = db.prepare(
    'UPDATE indicator_stats SET weight = ?, updated_ts = ? WHERE bot_id = ? AND indicator = ?',
  );
  const setEnabled = db.prepare(
    'UPDATE indicator_stats SET enabled = ?, updated_ts = ? WHERE bot_id = ? AND indicator = ?',
  );
  const retrial = isRetrialWeek(ts);

  for (const row of rows) {
    const hitRate = laplaceHitRate(row.hits, row.samples);

    if (row.enabled === 0) {
      if (!retrial) continue;
      const recent = recentVoteRecord(row.bot_id, row.indicator);
      if (recent.samples < RETRIAL_MIN_SAMPLES) continue;
      const recentRate = laplaceHitRate(recent.hits, recent.samples);
      if (recentRate < RETRIAL_HIT_RATE) continue;
      setEnabled.run(1, ts, row.bot_id, row.indicator);
      changes.push({
        botId: row.bot_id,
        indicator: row.indicator,
        kind: 're-enabled',
        from: 0,
        to: 1,
        hitRate: recentRate,
        samples: recent.samples,
      });
      continue;
    }

    // Auto-disable supersedes the weight move for this pass.
    if (row.samples >= DISABLE_FLOOR && hitRate < DISABLE_HIT_RATE) {
      setEnabled.run(0, ts, row.bot_id, row.indicator);
      changes.push({
        botId: row.bot_id,
        indicator: row.indicator,
        kind: 'disabled',
        from: 1,
        to: 0,
        hitRate,
        samples: row.samples,
      });
      continue;
    }

    if (row.samples < SAMPLE_FLOOR) continue; // frozen — the floor is locked
    const next = clamp(row.weight * (1 + ALPHA * (hitRate - 0.5)), WEIGHT_MIN, WEIGHT_MAX);
    if (next === row.weight) continue;
    setWeight.run(next, ts, row.bot_id, row.indicator);
    changes.push({
      botId: row.bot_id,
      indicator: row.indicator,
      kind: 'weight',
      from: row.weight,
      to: next,
      hitRate,
      samples: row.samples,
    });
  }

  // History is appended for EVERY indicator, not just the ones that moved —
  // a flat line while a weight is frozen below the sample floor is exactly
  // what the Track-record chart has to show.
  let historyRows = 0;
  try {
    historyRows = appendWeightHistory(ts, botId);
  } catch (err) {
    // Never let bookkeeping fail the recompute itself.
    logger.error({ err }, 'indicator stats: weight history append failed');
  }

  if (changes.length > 0 || historyRows > 0) {
    logger.info(
      { changes: changes.length, historyRows, retrialWeek: retrial },
      'indicator stats: daily recompute applied',
    );
  }
  return changes;
}

// ── lifecycle ──────────────────────────────────────────────────────────

let unsubscribe: (() => void) | null = null;
let task: ScheduledTask | null = null;

export function startIndicatorStats(): void {
  if (!unsubscribe) {
    unsubscribe = eventBus.on('outcome', (evt: OutcomeEvent) => {
      if (evt.horizon !== '4h') return;
      try {
        recordOutcomeVotes(evt.decisionId, evt.botId, evt.fwdRetPct, evt.ts);
      } catch (err) {
        logger.error({ err, decision: evt.decisionId }, 'indicator stats: record failed');
      }
    });
  }
  if (!task) {
    // Daily at 00:05 UTC, before the journal's lesson pass reads the table.
    task = cron.schedule('5 0 * * *', () => {
      try {
        recomputeWeights();
      } catch (err) {
        logger.error({ err }, 'indicator stats: daily recompute failed');
      }
    });
  }
  logger.info('indicator stats started (4h outcomes + daily recompute)');
}

export function stopIndicatorStats(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (task) {
    task.stop();
    task = null;
  }
}
