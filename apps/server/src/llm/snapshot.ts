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
 */
export function buildSnapshot(symbol: string, botState: BotSnapshotState = placeholderBotState()): Snapshot {
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

  // Phase 5 supplies real weights/hit-rates from indicator_stats; until then
  // every enabled indicator carries weight 1.0 and hit-rate n/a.
  const indicators: SnapshotIndicator[] = indicatorRows.map((r) => ({
    name: r.name,
    value: r.value,
    vote: r.vote,
    weight: 1.0,
    hitRate: null,
  }));

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
