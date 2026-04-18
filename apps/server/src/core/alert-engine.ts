/**
 * Alert engine — Phase 8.
 *
 * Subscribes to the in-process event bus. For every event, evaluates each
 * enabled `alert_rules` row against the event via the DSL from
 * `@cockpit/shared/alerts.ts`. On match + cooldown pass, inserts an
 * `alert_firings` row, updates `alert_rules.last_fired_ts`, and emits a
 * synthetic `AlertEvent` back onto the bus so SSE subscribers (and the
 * future Telegram channel) pick it up.
 *
 * Implementation notes:
 *   - Rules live in-memory; `reloadRules()` refreshes them after API writes.
 *   - `price_move` uses a per-asset rolling candle buffer so matchers
 *     never touch SQLite on the hot path.
 *   - `indicator_cross` hydrates `lastIndicatorValues` from the DB on
 *     startup so the very first event after a restart can still cross.
 *   - A global firehose limiter skips firings when >10 have fired in the
 *     last 60 seconds to avoid notification storms during market events.
 */

import { db } from '../db/client.js';
import { eventBus } from './event-bus.js';
import { logger } from '../util/logger.js';
import { nowSec } from '../util/time.js';
import type {
  AlertChannel,
  AlertCondition,
  AlertEvent,
  AlertRule,
  Event,
  PriceCandleEvent,
} from '@cockpit/shared';

interface RuleRow {
  id: number;
  name: string;
  enabled: number;
  condition_json: string;
  channels_json: string;
  cooldown_seconds: number;
  last_fired_ts: number | null;
  created_at: number;
}

interface InMemoryRule extends AlertRule {
  // kept writable so we can update last_fired_ts without re-reading DB
  lastFiredTs: number | null;
}

const PRICE_WINDOW_MAX_SAMPLES = 4096;     // cap per-asset candle buffer
const PRICE_WINDOW_RETENTION_SEC = 4 * 3600; // keep 4h max (longest DSL window)
const FIREHOSE_WINDOW_SEC = 60;
const FIREHOSE_MAX_FIRES = 10;

let rules: InMemoryRule[] = [];
const priceWindow: Map<number, Array<{ ts: number; c: number }>> = new Map();
const lastIndicatorValues: Map<string, number> = new Map();
const recentFiringTs: number[] = [];

let unsubscribe: (() => void) | null = null;
let fireSeq = 1_000_000; // synthetic ids for emitted AlertEvents

// ── Rule (de)hydration ────────────────────────────────────────────────

function parseRuleRow(r: RuleRow): InMemoryRule | null {
  let condition: AlertCondition;
  let channels: AlertChannel[];
  try {
    condition = JSON.parse(r.condition_json) as AlertCondition;
  } catch (err) {
    logger.warn({ err, id: r.id }, 'alert-engine: skipping rule with bad condition_json');
    return null;
  }
  try {
    const parsed = JSON.parse(r.channels_json);
    channels = Array.isArray(parsed)
      ? (parsed.filter((c) => c === 'browser' || c === 'telegram') as AlertChannel[])
      : [];
  } catch {
    channels = [];
  }
  return {
    id: r.id,
    name: r.name,
    enabled: r.enabled === 1,
    condition,
    channels,
    cooldownSeconds: r.cooldown_seconds,
    lastFiredTs: r.last_fired_ts,
    createdAt: r.created_at,
  };
}

export function reloadRules(): number {
  const rows = db
    .prepare(
      `SELECT id, name, enabled, condition_json, channels_json,
              cooldown_seconds, last_fired_ts, created_at
         FROM alert_rules
        WHERE enabled = 1`,
    )
    .all() as RuleRow[];
  const next: InMemoryRule[] = [];
  for (const r of rows) {
    const parsed = parseRuleRow(r);
    if (parsed) next.push(parsed);
  }
  rules = next;
  logger.info({ count: rules.length }, 'alert-engine: rules reloaded');
  return rules.length;
}

// ── Indicator hydration for `indicator_cross` ────────────────────────

function hydrateIndicatorValues(): void {
  const rows = db
    .prepare(
      `SELECT name, value FROM indicator_readings
        WHERE (name, ts) IN (
          SELECT name, MAX(ts) FROM indicator_readings GROUP BY name
        )`,
    )
    .all() as Array<{ name: string; value: number }>;
  for (const r of rows) {
    lastIndicatorValues.set(r.name, r.value);
  }
  logger.debug(
    { count: lastIndicatorValues.size },
    'alert-engine: hydrated last indicator values',
  );
}

// ── Price-move rolling window ─────────────────────────────────────────

function recordCandle(evt: PriceCandleEvent): void {
  // Only track 1m candles (or whichever timeframe gives best granularity).
  // Higher timeframes are aggregates and would double-count.
  if (evt.timeframe !== '1m') return;
  const buf = priceWindow.get(evt.assetId) ?? [];
  buf.push({ ts: evt.ts, c: evt.c });
  // Trim by retention window + hard cap.
  const cutoff = evt.ts - PRICE_WINDOW_RETENTION_SEC;
  while (buf.length && buf[0]!.ts < cutoff) buf.shift();
  if (buf.length > PRICE_WINDOW_MAX_SAMPLES) {
    buf.splice(0, buf.length - PRICE_WINDOW_MAX_SAMPLES);
  }
  priceWindow.set(evt.assetId, buf);
}

function computePriceMovePct(
  assetId: number,
  windowSec: number,
  latestClose: number,
): number | null {
  const buf = priceWindow.get(assetId);
  if (!buf || buf.length === 0) return null;
  const cutoff = buf[buf.length - 1]!.ts - windowSec;
  // Walk backwards to find the oldest sample within the window.
  let basis: number | null = null;
  for (let i = buf.length - 1; i >= 0; i--) {
    const s = buf[i]!;
    if (s.ts <= cutoff) {
      basis = s.c;
      break;
    }
    basis = s.c; // fallback = oldest sample we've seen so far
  }
  if (basis === null || basis === 0) return null;
  return ((latestClose - basis) / basis) * 100;
}

// ── Matchers ──────────────────────────────────────────────────────────

function compareOp(a: number, op: '>' | '<' | '>=' | '<=', b: number): boolean {
  switch (op) {
    case '>':
      return a > b;
    case '<':
      return a < b;
    case '>=':
      return a >= b;
    case '<=':
      return a <= b;
  }
}

function matchDirectional(
  pct: number,
  threshold: number,
  dir: 'up' | 'down' | 'either',
): boolean {
  const absT = Math.abs(threshold);
  if (dir === 'up') return pct >= absT;
  if (dir === 'down') return pct <= -absT;
  return Math.abs(pct) >= absT;
}

function matchesCondition(
  condition: AlertCondition,
  event: Event,
): { match: boolean; context?: Record<string, unknown> } {
  switch (condition.type) {
    case 'price_move': {
      if (event.kind !== 'candle') return { match: false };
      if (event.assetId !== condition.assetId) return { match: false };
      const pct = computePriceMovePct(
        condition.assetId,
        condition.windowSeconds,
        event.c,
      );
      if (pct === null) return { match: false };
      const hit = matchDirectional(pct, condition.pctChange, condition.direction);
      return {
        match: hit,
        context: hit ? { pctChange: pct, windowSeconds: condition.windowSeconds, close: event.c } : undefined,
      };
    }
    case 'price_level': {
      if (event.kind !== 'candle') return { match: false };
      if (event.assetId !== condition.assetId) return { match: false };
      const hit = compareOp(event.c, condition.operator, condition.value);
      return { match: hit, context: hit ? { close: event.c, threshold: condition.value } : undefined };
    }
    case 'whale_tx': {
      if (event.kind !== 'whale_tx') return { match: false };
      if (condition.chain && event.chain !== condition.chain) return { match: false };
      if (event.usdValue < condition.minUsd) return { match: false };
      if (
        condition.direction &&
        condition.direction !== 'either' &&
        event.direction !== condition.direction
      ) {
        return { match: false };
      }
      if (
        condition.addressFilter &&
        condition.addressFilter.length > 0 &&
        !condition.addressFilter.includes(event.address)
      ) {
        return { match: false };
      }
      return {
        match: true,
        context: {
          chain: event.chain,
          address: event.address,
          usdValue: event.usdValue,
          direction: event.direction,
          txHash: event.txHash,
        },
      };
    }
    case 'news': {
      if (event.kind !== 'news') return { match: false };
      const title = event.title?.toLowerCase() ?? '';
      if (condition.tickers && condition.tickers.length > 0) {
        const hit = (event.tickers ?? []).some((t) => condition.tickers!.includes(t));
        if (!hit) return { match: false };
      }
      if (condition.minSentimentAbs != null) {
        if (Math.abs(event.sentiment ?? 0) < condition.minSentimentAbs) {
          return { match: false };
        }
      }
      if (condition.keywordsAny && condition.keywordsAny.length > 0) {
        const hit = condition.keywordsAny.some((k) => title.includes(k.toLowerCase()));
        if (!hit) return { match: false };
      }
      if (condition.keywordsAll && condition.keywordsAll.length > 0) {
        const hit = condition.keywordsAll.every((k) => title.includes(k.toLowerCase()));
        if (!hit) return { match: false };
      }
      return {
        match: true,
        context: {
          title: event.title,
          url: event.url,
          tickers: event.tickers,
          sentiment: event.sentiment,
        },
      };
    }
    case 'indicator_level': {
      if (event.kind !== 'indicator') return { match: false };
      if (event.name !== condition.name) return { match: false };
      const hit = compareOp(event.value, condition.operator, condition.value);
      return {
        match: hit,
        context: hit ? { name: event.name, value: event.value, threshold: condition.value } : undefined,
      };
    }
    case 'indicator_cross': {
      if (event.kind !== 'indicator') return { match: false };
      if (event.name !== condition.name) return { match: false };
      // Prefer the event's own `previous` if present, else the in-memory last value.
      const prev = event.previous ?? lastIndicatorValues.get(event.name);
      if (prev === undefined || prev === null) return { match: false };
      const v = event.value;
      const hit =
        (condition.direction === 'up' &&
          prev < condition.threshold &&
          v >= condition.threshold) ||
        (condition.direction === 'down' &&
          prev > condition.threshold &&
          v <= condition.threshold);
      return {
        match: hit,
        context: hit
          ? { name: event.name, previous: prev, current: v, threshold: condition.threshold }
          : undefined,
      };
    }
    case 'probability': {
      if (event.kind !== 'probability') return { match: false };
      if (event.assetId !== condition.assetId) return { match: false };
      if (event.horizon !== condition.horizon) return { match: false };
      const hit = compareOp(event.bullishProb, condition.operator, condition.value);
      return {
        match: hit,
        context: hit
          ? {
              assetId: event.assetId,
              horizon: event.horizon,
              bullishProb: event.bullishProb,
              threshold: condition.value,
            }
          : undefined,
      };
    }
  }
}

// ── Firehose limiter ──────────────────────────────────────────────────

function firehoseAllows(now: number): boolean {
  const cutoff = now - FIREHOSE_WINDOW_SEC;
  while (recentFiringTs.length && recentFiringTs[0]! < cutoff) {
    recentFiringTs.shift();
  }
  if (recentFiringTs.length >= FIREHOSE_MAX_FIRES) {
    return false;
  }
  return true;
}

function recordFirehose(now: number): void {
  recentFiringTs.push(now);
}

// ── Fire ──────────────────────────────────────────────────────────────

const insertFiringStmt = db.prepare(
  `INSERT INTO alert_firings (rule_id, ts, payload_json, delivered_json)
   VALUES (?, ?, ?, ?)`,
);
const updateLastFiredStmt = db.prepare(
  `UPDATE alert_rules SET last_fired_ts = ? WHERE id = ?`,
);

function fireRule(rule: InMemoryRule, ts: number, context: Record<string, unknown>): void {
  const payload = {
    ruleName: rule.name,
    conditionType: rule.condition.type,
    context,
  };
  const delivered: Partial<Record<AlertChannel, 'ok' | 'failed'>> = {};
  if (rule.channels.includes('browser')) delivered.browser = 'ok';
  if (rule.channels.includes('telegram')) delivered.telegram = 'failed'; // TODO: real delivery
  try {
    insertFiringStmt.run(rule.id, ts, JSON.stringify(payload), JSON.stringify(delivered));
    updateLastFiredStmt.run(ts, rule.id);
  } catch (err) {
    logger.error({ err, ruleId: rule.id }, 'alert-engine: failed to persist firing');
  }
  rule.lastFiredTs = ts;

  const evt: AlertEvent = {
    id: fireSeq++,
    ts,
    source: 'alert-engine',
    kind: 'alert',
    ruleId: rule.id,
    ruleName: rule.name,
    payload,
  };
  try {
    eventBus.emit(evt);
  } catch (err) {
    logger.error({ err, ruleId: rule.id }, 'alert-engine: eventBus emit failed');
  }

  logger.info(
    { ruleId: rule.id, name: rule.name, type: rule.condition.type },
    'alert fired',
  );
}

// ── Hot path ──────────────────────────────────────────────────────────

function onEvent(event: Event): void {
  // Maintain the price-window buffer regardless of rule activity.
  if (event.kind === 'candle') {
    recordCandle(event);
  }
  // Capture the latest indicator value for future `indicator_cross` events.
  if (event.kind === 'indicator') {
    // NB: update *after* we've run matchers so cross detection has a true `previous`.
  }

  // Skip alert-engine's own events to avoid recursion.
  if (event.kind === 'alert') return;

  const ts = nowSec();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (
      rule.lastFiredTs !== null &&
      rule.lastFiredTs + rule.cooldownSeconds > ts
    ) {
      continue;
    }
    let result: { match: boolean; context?: Record<string, unknown> };
    try {
      result = matchesCondition(rule.condition, event);
    } catch (err) {
      logger.warn({ err, ruleId: rule.id }, 'alert-engine: matcher threw');
      continue;
    }
    if (!result.match) continue;

    if (!firehoseAllows(ts)) {
      logger.warn(
        { ruleId: rule.id, windowSec: FIREHOSE_WINDOW_SEC, cap: FIREHOSE_MAX_FIRES },
        'alert-engine: firehose throttle engaged — skipping fire',
      );
      continue;
    }
    recordFirehose(ts);
    fireRule(rule, ts, result.context ?? {});
  }

  // Now update the indicator last-value cache so the *next* event sees this
  // one as its `previous`.
  if (event.kind === 'indicator') {
    lastIndicatorValues.set(event.name, event.value);
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────

let pollHandle: NodeJS.Timeout | null = null;

export function startAlertEngine(): void {
  hydrateIndicatorValues();
  reloadRules();

  unsubscribe = eventBus.onAny((event) => {
    try {
      onEvent(event);
    } catch (err) {
      logger.error({ err }, 'alert-engine: onEvent failed');
    }
  });

  // Lightweight safety net — reload rules every 30s so out-of-band DB
  // edits (e.g. a future CLI) are eventually picked up even if the API
  // forgets to call `reloadRules()`.
  pollHandle = setInterval(() => {
    try {
      reloadRules();
    } catch (err) {
      logger.warn({ err }, 'alert-engine: periodic reload failed');
    }
  }, 30_000);
  pollHandle.unref?.();

  logger.info('alert-engine: started');
}

export function stopAlertEngine(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  rules = [];
  priceWindow.clear();
  lastIndicatorValues.clear();
  recentFiringTs.length = 0;
  logger.info('alert-engine: stopped');
}

// Exposed for tests / diagnostics.
export function __getAlertEngineState(): {
  ruleCount: number;
  priceWindowSizes: Array<{ assetId: number; samples: number }>;
  lastIndicatorNames: string[];
  recentFirings: number;
} {
  return {
    ruleCount: rules.length,
    priceWindowSizes: [...priceWindow.entries()].map(([assetId, buf]) => ({
      assetId,
      samples: buf.length,
    })),
    lastIndicatorNames: [...lastIndicatorValues.keys()],
    recentFirings: recentFiringTs.length,
  };
}
