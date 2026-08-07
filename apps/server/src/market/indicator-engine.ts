/**
 * Indicator engine — consumes closed-kline bus events (acts ONLY on candle
 * close), computes the 8-indicator set per symbol on the 1h timeframe,
 * writes `indicator_values` rows and publishes `indicator` bus events.
 *
 * Math lives in core/indicators.ts (pure). Vote rules live in ONE exported
 * const (`INDICATOR_DEFS`) keyed by indicator name — Phase 5 stats join on
 * these names 1:1. Do not rename without migrating indicator_stats.
 *
 * Boot behaviour (standard, not a dev hack): after marketWarm, `computeAll()`
 * runs one pass from the freshest closed 1h candles so bots and the API have
 * a full indicator set immediately — no waiting for the next hourly close.
 */

import type { IndicatorEvent, Vote } from '@wick/shared';
import { db } from '../db/client.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../util/logger.js';
import {
  computeATR,
  computeBBands,
  computeEMA,
  computeMACD,
  computeRSI,
  computeVolumeRatio,
  type Candle,
} from '../core/indicators.js';
import { getActiveSymbols } from '../collectors/crypto/binance-rest.js';
import { getLatestFunding } from '../collectors/macro/funding-oi.js';
import { getLatestFearGreed } from '../collectors/macro/fear-greed.js';
import { isMarketWarm } from './market-state.js';

/** The timeframe indicators vote on (IMPL-1 §1.3). */
export const INDICATOR_TF = '1h';

/** How many closed candles feed one compute pass (EMA200 needs ≥200). */
const LOOKBACK = 300;

export interface IndicatorCtx {
  /** Closed candles, oldest-first. */
  candles: Candle[];
  closes: number[];
  volumes: number[];
  /** Latest funding rate as a fraction (0.0001 = 0.01%), null if never polled. */
  funding: number | null;
  /** Latest Fear & Greed index 0–100, null if never polled. */
  fearGreed: number | null;
}

export interface IndicatorResult {
  value: number | null;
  vote: Vote | null; // null = indicator casts no directional vote (ATR)
}

/**
 * THE vote-rule table (IMPL-1 §1.3), keyed by indicator name. v1 defaults.
 * Phase 5 `indicator_stats` rows reference these exact names.
 */
export const INDICATOR_DEFS: Record<
  string,
  { rule: string; compute: (ctx: IndicatorCtx) => IndicatorResult }
> = {
  rsi14: {
    rule: 'RSI(14): <30 bull · >70 bear · else neutral',
    compute: ({ closes }) => {
      const rsi = computeRSI(closes, 14);
      if (rsi === null) return { value: null, vote: null };
      return { value: rsi, vote: rsi < 30 ? 'bull' : rsi > 70 ? 'bear' : 'neutral' };
    },
  },
  ema_trend: {
    rule: 'EMA20 vs EMA50 vs EMA200: 20>50>200 bull · 20<50<200 bear · else neutral. Value = (EMA20−EMA200)/EMA200 ×100.',
    compute: ({ closes }) => {
      const e20 = computeEMA(closes, 20);
      const e50 = computeEMA(closes, 50);
      const e200 = computeEMA(closes, 200);
      if (e20 === null || e50 === null || e200 === null) return { value: null, vote: null };
      const vote: Vote =
        e20 > e50 && e50 > e200 ? 'bull' : e20 < e50 && e50 < e200 ? 'bear' : 'neutral';
      return { value: ((e20 - e200) / e200) * 100, vote };
    },
  },
  macd: {
    rule: 'MACD(12,26,9): hist crosses >0 bull · crosses <0 bear · else neutral. Value = hist.',
    compute: ({ closes }) => {
      const cur = computeMACD(closes);
      const prev = computeMACD(closes.slice(0, -1));
      if (cur === null) return { value: null, vote: null };
      let vote: Vote = 'neutral';
      if (prev !== null) {
        if (prev.hist <= 0 && cur.hist > 0) vote = 'bull';
        else if (prev.hist >= 0 && cur.hist < 0) vote = 'bear';
      }
      return { value: cur.hist, vote };
    },
  },
  bollinger: {
    rule: 'Bollinger(20,2): close<lower bull (mean-revert) · close>upper bear · else neutral. Value = %B.',
    compute: ({ closes }) => {
      const bb = computeBBands(closes, 20, 2);
      const close = closes[closes.length - 1];
      if (bb === null || close === undefined) return { value: null, vote: null };
      const width = bb.upper - bb.lower;
      const pctB = width > 0 ? (close - bb.lower) / width : 0.5;
      const vote: Vote = close < bb.lower ? 'bull' : close > bb.upper ? 'bear' : 'neutral';
      return { value: pctB, vote };
    },
  },
  atr14: {
    rule: 'ATR(14): no vote — volatility input for triggers/slippage.',
    compute: ({ candles }) => {
      const atr = computeATR(candles, 14);
      return { value: atr, vote: null };
    },
  },
  volume_ratio: {
    rule: 'vol / SMA20(vol): >2 with green candle bull · >2 with red bear · else neutral.',
    compute: ({ candles, volumes }) => {
      const ratio = computeVolumeRatio(volumes, 20);
      const last = candles[candles.length - 1];
      if (ratio === null || !last) return { value: null, vote: null };
      let vote: Vote = 'neutral';
      if (ratio > 2) vote = last.c >= last.o ? 'bull' : 'bear';
      return { value: ratio, vote };
    },
  },
  funding: {
    rule: 'Funding rate: < −0.01% bull · > +0.05% bear · else neutral. Value is a fraction (0.0001 = 0.01%).',
    compute: ({ funding }) => {
      if (funding === null) return { value: null, vote: 'neutral' };
      const vote: Vote = funding < -0.0001 ? 'bull' : funding > 0.0005 ? 'bear' : 'neutral';
      return { value: funding, vote };
    },
  },
  fear_greed: {
    rule: 'Fear&Greed index: <25 bull · >75 bear · else neutral.',
    compute: ({ fearGreed }) => {
      if (fearGreed === null) return { value: null, vote: 'neutral' };
      const vote: Vote = fearGreed < 25 ? 'bull' : fearGreed > 75 ? 'bear' : 'neutral';
      return { value: fearGreed, vote };
    },
  },
};

export const INDICATOR_NAMES = Object.keys(INDICATOR_DEFS);

let unsubscribe: (() => void) | null = null;
let eventIdSeq = 1;

function nextEventId(): number {
  return eventIdSeq++;
}

function loadClosedCandles(symbol: string, tf: string): Candle[] {
  const rows = db
    .prepare(
      `SELECT ts, o, h, l, c, v FROM candles
        WHERE symbol = ? AND tf = ?
        ORDER BY ts DESC LIMIT ?`,
    )
    .all(symbol, tf, LOOKBACK) as Candle[];
  return rows.reverse();
}

/**
 * Compute + persist + publish the full indicator set for one symbol from the
 * freshest closed candles. `ts` of every row is the open time of the newest
 * closed candle.
 */
export function computeForSymbol(symbol: string, tf: string = INDICATOR_TF): number {
  const candles = loadClosedCandles(symbol, tf);
  if (candles.length < 30) {
    logger.warn({ symbol, tf, have: candles.length }, 'indicator-engine: not enough candles');
    return 0;
  }
  const ctx: IndicatorCtx = {
    candles,
    closes: candles.map((c) => c.c),
    volumes: candles.map((c) => c.v),
    funding: getLatestFunding(symbol)?.rate ?? null,
    fearGreed: getLatestFearGreed()?.value ?? null,
  };
  const ts = candles[candles.length - 1]!.ts;

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO indicator_values (symbol, tf, ts, name, value, vote)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  let written = 0;
  const events: IndicatorEvent[] = [];
  const tx = db.transaction(() => {
    for (const [name, def] of Object.entries(INDICATOR_DEFS)) {
      const { value, vote } = def.compute(ctx);
      const storedValue = value !== null && Number.isFinite(value) ? value : null;
      upsert.run(symbol, tf, ts, name, storedValue, vote);
      written++;
      events.push({
        id: nextEventId(),
        ts,
        source: 'indicator-engine',
        kind: 'indicator',
        symbol,
        tf: tf as IndicatorEvent['tf'],
        name,
        value: storedValue,
        vote,
      });
    }
  });
  try {
    tx();
  } catch (err) {
    logger.error({ err, symbol, tf }, 'indicator-engine: write failed');
    return 0;
  }
  for (const evt of events) eventBus.emit(evt);
  return written;
}

/**
 * One full pass over every active symbol from the freshest closed 1h
 * candles. Runs at boot right after marketWarm (standard behaviour) so
 * indicators are queryable immediately — and gives bots data right after
 * any restart.
 */
export function computeAll(tf: string = INDICATOR_TF): void {
  const symbols = getActiveSymbols();
  let total = 0;
  for (const symbol of symbols) {
    total += computeForSymbol(symbol, tf);
  }
  logger.info({ symbols: symbols.length, rows: total, tf }, 'indicator-engine: full pass complete');
}

/** Subscribe to closed 1h candle events. Persist order is guaranteed by the
 *  WS collector (candle row is written before the event is emitted). */
export function startIndicatorEngine(): void {
  if (unsubscribe) return;
  unsubscribe = eventBus.on('candle', (evt) => {
    if (!evt.closed || evt.tf !== INDICATOR_TF) return;
    if (!isMarketWarm()) return;
    try {
      computeForSymbol(evt.symbol, evt.tf);
    } catch (err) {
      logger.error({ err, symbol: evt.symbol }, 'indicator-engine: compute failed');
    }
  });
  logger.info('indicator-engine started (1h close)');
}

export function stopIndicatorEngine(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
