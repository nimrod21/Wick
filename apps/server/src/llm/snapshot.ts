/**
 * Snapshot builder (task 3.6 support): assembles a real PLAN §8 snapshot
 * from the live DB + in-memory macro caches. Phase 4's bot-runner passes
 * real bot state; the `ask` CLI (and anything bot-less) gets neutral
 * placeholders — weights 1.0 / hit-rate "n/a" until Phase 5 fills them.
 */
import { db } from '../db/client.js';
import { getLatestFunding } from '../collectors/macro/funding-oi.js';
import { getLatestFearGreed } from '../collectors/macro/fear-greed.js';
import { INDICATOR_TF } from '../market/indicator-engine.js';
import { getIndicatorStats } from '../learn/indicator-stats.js';
import type { Snapshot, SnapshotCandle, SnapshotIndicator, SnapshotPastDecision } from './prompt.js';

export interface BotSnapshotState {
  position: Snapshot['position'];
  account: Snapshot['account'];
  lastDecisions: SnapshotPastDecision[];
  lessons: string[];
  triggerReason: string;
  guardState: string;
}

/** Neutral bot state for bot-less callers (the ask CLI). */
export function placeholderBotState(): BotSnapshotState {
  return {
    position: null,
    account: { cash: 1000, equity: 1000, drawdownPct: 0, fees7d: 0, grossPnl7d: 0 },
    lastDecisions: [],
    lessons: [],
    triggerReason: 'Woken by: manual ask (CLI).',
    guardState: '6 trades left today, no cooldown active.',
  };
}

export class SnapshotDataError extends Error {}

/**
 * Build a snapshot for `symbol`. Throws SnapshotDataError when the market
 * tables are empty (server never booted / never backfilled).
 *
 * `botId` pulls that bot's learned `indicator_stats` into every indicator
 * (weight, hit-rate, samples, shadow flag). Bot-less callers (the `ask` CLI)
 * pass null and get neutral weight 1.0 / hit-rate n/a.
 */
export function buildSnapshot(
  symbol: string,
  botState: BotSnapshotState = placeholderBotState(),
  botId: number | null = null,
): Snapshot {
  const candleRows = db
    .prepare(
      'SELECT ts, o, h, l, c, v FROM candles WHERE symbol = ? AND tf = ? ORDER BY ts DESC LIMIT 24',
    )
    .all(symbol, INDICATOR_TF) as SnapshotCandle[];
  if (candleRows.length === 0) {
    throw new SnapshotDataError(
      `no ${INDICATOR_TF} candles for ${symbol} — boot the server once so collectors backfill market data`,
    );
  }
  const candles1h = candleRows.reverse();

  const latestTsRow = db
    .prepare('SELECT MAX(ts) AS ts FROM indicator_values WHERE symbol = ? AND tf = ?')
    .get(symbol, INDICATOR_TF) as { ts: number | null };
  if (latestTsRow.ts === null) {
    throw new SnapshotDataError(
      `no indicator values for ${symbol} — boot the server once so the indicator engine runs`,
    );
  }
  const indicatorRows = db
    .prepare(
      'SELECT name, value, vote FROM indicator_values WHERE symbol = ? AND tf = ? AND ts = ? ORDER BY name',
    )
    .all(symbol, INDICATOR_TF, latestTsRow.ts) as Array<{
    name: string;
    value: number | null;
    vote: string | null;
  }>;

  // Learned trust (PLAN §11.2). An indicator with no stats row yet is neutral
  // (weight 1.0, hit-rate n/a) — a fresh bot trusts everything equally.
  // Auto-disabled indicators stay in the snapshot as `shadow` so their votes
  // keep being recorded; the prompt drops them.
  const stats = botId === null ? null : getIndicatorStats(botId);
  const indicators: SnapshotIndicator[] = indicatorRows.map((r) => {
    const stat = stats?.get(r.name);
    return {
      name: r.name,
      value: r.value,
      vote: r.vote,
      weight: stat?.weight ?? 1.0,
      hitRate: stat?.hitRate ?? null,
      samples: stat?.samples ?? 0,
      shadow: stat ? !stat.enabled : false,
    };
  });

  return {
    symbol,
    ts: Date.now(),
    candles1h,
    indicators,
    funding: getLatestFunding(symbol)?.rate ?? null,
    fearGreed: getLatestFearGreed()?.value ?? null,
    position: botState.position,
    account: botState.account,
    lastDecisions: botState.lastDecisions,
    lessons: botState.lessons,
    triggerReason: botState.triggerReason,
    guardState: botState.guardState,
  };
}
