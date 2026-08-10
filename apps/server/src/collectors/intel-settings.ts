/**
 * Runtime thresholds for the intel collectors + their indicators.
 *
 * One `settings` row (`intel.thresholds`) so everything here is editable at
 * runtime through the existing settings API — same shape as
 * `guards.defaults` / `triggers.thresholds`. Defaults are seeded by
 * db/migrate.ts (INSERT OR IGNORE, so user edits are never overwritten);
 * this reader also falls back to the defaults if the row is missing or
 * unparseable, so a bad hand-edit degrades to sane values instead of a crash.
 */

import { db } from '../db/client.js';
import { logger } from '../util/logger.js';

export interface IntelThresholds {
  /** Minimum BTC moved by a watched address for a whale_moves row. */
  whale_btc_min: number;
  /** Net 24h exchange flow (USD) that flips whale_flow off neutral. */
  whale_flow_usd: number;
  /** |mean 24h sentiment| that flips news_sentiment off neutral. */
  news_sentiment_abs: number;
  /** Headline-rate ratio (last 1h vs 7d hourly baseline) considered a burst. */
  news_burst_ratio: number;
  /** Day-change % that flips each macro indicator off neutral. */
  macro_move_pct: { gold: number; oil: number; dxy: number; vix: number };

  // ── notification triggers (IMPL-3b) ──────────────────────────────────
  // Separate from the indicator thresholds above on purpose: an indicator
  // may lean bearish long before a move is worth waking a bot for.
  /** USD size of a single whale move that fires `whale_big_move`. */
  whale_big_move_usd: number;
  /** Headline-rate ratio that fires `news_burst`. */
  news_burst_trigger_ratio: number;
  /** |day-change %| per macro symbol that fires `macro_shock`. */
  macro_shock_pct: { gold: number; oil: number; silver: number; dxy: number; vix: number };
  /** Per-type kill switch for the three intel triggers. */
  notify: { whale_big_move: boolean; news_burst: boolean; macro_shock: boolean };
}

export const INTEL_DEFAULTS: IntelThresholds = {
  whale_btc_min: 50,
  whale_flow_usd: 10_000_000,
  news_sentiment_abs: 0.25,
  news_burst_ratio: 2,
  macro_move_pct: { gold: 1, oil: 2, dxy: 0.5, vix: 10 },
  whale_big_move_usd: 25_000_000,
  news_burst_trigger_ratio: 3,
  macro_shock_pct: { gold: 2, oil: 3, silver: 3, dxy: 1, vix: 15 },
  notify: { whale_big_move: true, news_burst: true, macro_shock: true },
};

export const INTEL_SETTINGS_KEY = 'intel.thresholds';

export function getIntelThresholds(): IntelThresholds {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(INTEL_SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row) return INTEL_DEFAULTS;
  try {
    const parsed = JSON.parse(row.value) as Partial<IntelThresholds>;
    return {
      ...INTEL_DEFAULTS,
      ...parsed,
      macro_move_pct: { ...INTEL_DEFAULTS.macro_move_pct, ...(parsed.macro_move_pct ?? {}) },
      macro_shock_pct: { ...INTEL_DEFAULTS.macro_shock_pct, ...(parsed.macro_shock_pct ?? {}) },
      notify: { ...INTEL_DEFAULTS.notify, ...(parsed.notify ?? {}) },
    };
  } catch (err) {
    logger.warn({ err }, 'intel.thresholds unparseable — using defaults');
    return INTEL_DEFAULTS;
  }
}
