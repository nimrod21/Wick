/**
 * Probability engine — computes weighted signal fusion into a bullish
 * probability score per (asset, horizon) every minute. Writes to
 * `probability_history` + `signal_readings` and emits `ProbabilityEvent`s.
 *
 * Weights live in `seed/probability_weights.json` and are hot-reloaded
 * on file change via `fs.watch`.
 *
 * Each horizon (1H, 4H, 24H) now uses a tailored subset of signals so
 * the short-term view emphasises microstructure and the long-term view
 * emphasises macro/trend.
 */

import cron, { type ScheduledTask } from 'node-cron';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import type { ProbabilityEvent } from '@cockpit/shared';
import { db } from '../db/client.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../util/logger.js';
import { nowSec } from '../util/time.js';

type Horizon = '1h' | '4h' | '24h';

const HORIZONS: readonly Horizon[] = ['1h', '4h', '24h'] as const;

export type SignalName =
  | 'fear_greed_level'
  | 'fear_greed_delta'
  | 'dxy_trend'
  | 'vix_level'
  | 'funding_rate'
  | 'open_interest_delta'
  | 'btc_dominance_trend'
  | 'whale_netflow_to_exchanges'
  | 'news_sentiment_aggregate'
  | 'price_momentum_1h'
  | 'price_momentum_4h'
  | 'price_momentum_24h'
  | 'rsi_14'
  | 'macd_histogram'
  | 'macd_line'
  | 'ema20_slope_4h'
  | 'ema200_distance';

type Weights = Record<SignalName, number>;

interface SignalReading {
  name: SignalName;
  valueNormalized: number; // -1..+1, +1 bullish
  weight: number;
  rawValue: unknown;
  asOf: number;
}

const DEFAULT_WEIGHTS: Weights = {
  fear_greed_level: 0.8,
  fear_greed_delta: 0.5,
  dxy_trend: 0.6,
  vix_level: 0.5,
  funding_rate: 0.7,
  open_interest_delta: 0.4,
  btc_dominance_trend: 0.5,
  whale_netflow_to_exchanges: 0.9,
  news_sentiment_aggregate: 0.7,
  price_momentum_1h: 0.6,
  price_momentum_4h: 0.5,
  price_momentum_24h: 0.4,
  rsi_14: 0.6,
  macd_histogram: 0.7,
  macd_line: 0.4,
  ema20_slope_4h: 0.5,
  ema200_distance: 0.5,
};

// Per-horizon signal subsets. Each horizon's score is computed from
// ONLY the signals listed here.
const HORIZON_SIGNALS: Record<Horizon, readonly SignalName[]> = {
  '1h': [
    'price_momentum_1h',
    'funding_rate',
    'open_interest_delta',
    'rsi_14',
    'macd_histogram',
  ],
  '4h': [
    'price_momentum_4h',
    'fear_greed_delta',
    'news_sentiment_aggregate',
    'ema20_slope_4h',
    'macd_line',
  ],
  '24h': [
    'price_momentum_24h',
    'dxy_trend',
    'vix_level',
    'btc_dominance_trend',
    'whale_netflow_to_exchanges',
    'fear_greed_level',
    'ema200_distance',
  ],
} as const;

// Resolve the weights file relative to this module's source/dist location.
// In dist/core/probability-engine.js -> dist/seed/probability_weights.json.
// In src/core/probability-engine.ts  -> src/seed/probability_weights.json.
function weightsFilePath(): string {
  const here = url.fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), '..', 'seed', 'probability_weights.json');
}

let currentWeights: Weights = { ...DEFAULT_WEIGHTS };
let watcher: fs.FSWatcher | null = null;
let task: ScheduledTask | null = null;
let running = false;
let eventIdSeq = 1;
let reloadTimer: NodeJS.Timeout | null = null;

function nextEventId(): number {
  return eventIdSeq++;
}

function clamp(v: number, lo: number, hi: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function safeParseWeights(text: string): Weights | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const out: Partial<Weights> = {};
    const obj = parsed as Record<string, unknown>;
    for (const k of Object.keys(DEFAULT_WEIGHTS) as SignalName[]) {
      const v = obj[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 5) {
        out[k] = v;
      } else {
        out[k] = DEFAULT_WEIGHTS[k];
      }
    }
    return out as Weights;
  } catch (err) {
    logger.error({ err }, 'probability-engine: failed to parse weights json');
    return null;
  }
}

function loadWeightsSync(): void {
  const p = weightsFilePath();
  try {
    const text = fs.readFileSync(p, 'utf8');
    const parsed = safeParseWeights(text);
    if (parsed) {
      currentWeights = parsed;
    } else {
      currentWeights = { ...DEFAULT_WEIGHTS };
    }
  } catch (err) {
    logger.warn({ err, path: p }, 'probability-engine: weights file missing, using defaults');
    currentWeights = { ...DEFAULT_WEIGHTS };
  }
}

export function reloadWeights(): Weights {
  loadWeightsSync();
  logger.info({ weights: currentWeights }, 'probability-engine: weights reloaded');
  return { ...currentWeights };
}

export function getCurrentWeights(): Weights {
  return { ...currentWeights };
}

export function getDefaultWeights(): Weights {
  return { ...DEFAULT_WEIGHTS };
}

function watchWeightsFile(): void {
  const p = weightsFilePath();
  try {
    watcher = fs.watch(p, { persistent: false }, () => {
      // Debounce: fs.watch can fire multiple events on a single write.
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        reloadWeights();
      }, 200);
    });
    watcher.on('error', (err) => {
      logger.warn({ err }, 'probability-engine: weights watcher error');
    });
  } catch (err) {
    logger.warn({ err, path: p }, 'probability-engine: unable to watch weights file');
  }
}

// ─── signal fetch helpers ─────────────────────────────────────────────

interface IndicatorLatest {
  value: number;
  ts: number;
}

const latestIndicatorStmt = db.prepare(
  `SELECT ts, value FROM indicator_readings WHERE name = ? ORDER BY ts DESC LIMIT 1`,
);

const indicatorAtOrBeforeStmt = db.prepare(
  `SELECT ts, value FROM indicator_readings WHERE name = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`,
);

const indicatorSinceStmt = db.prepare(
  `SELECT ts, value FROM indicator_readings WHERE name = ? AND ts >= ? ORDER BY ts ASC`,
);

function latestIndicator(name: string): IndicatorLatest | null {
  const r = latestIndicatorStmt.get(name) as { ts: number; value: number } | undefined;
  if (!r || !Number.isFinite(r.value)) return null;
  return { value: r.value, ts: r.ts };
}

function indicatorAtOrBefore(name: string, ts: number): IndicatorLatest | null {
  const r = indicatorAtOrBeforeStmt.get(name, ts) as
    | { ts: number; value: number }
    | undefined;
  if (!r || !Number.isFinite(r.value)) return null;
  return { value: r.value, ts: r.ts };
}

function indicatorSince(name: string, sinceTs: number): IndicatorLatest[] {
  const rows = indicatorSinceStmt.all(name, sinceTs) as Array<{ ts: number; value: number }>;
  return rows.filter((r) => Number.isFinite(r.value)).map((r) => ({ ts: r.ts, value: r.value }));
}

// Simple OLS slope (change per day) across `{ts,value}` points.
function linregSlopePerDay(points: IndicatorLatest[]): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  const t0 = points[0]!.ts;
  // Convert ts to days for numerical stability.
  const xs = points.map((p) => (p.ts - t0) / 86400);
  const ys = points.map((p) => p.value);
  const meanX = xs.reduce((s, x) => s + x, 0) / n;
  const meanY = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    num += dx * (ys[i]! - meanY);
    den += dx * dx;
  }
  if (den === 0) return null;
  return num / den; // value change per day
}

// ─── candle helpers ───────────────────────────────────────────────────

const latest1mCloseStmt = db.prepare(
  `SELECT c AS close, ts FROM candles_1m WHERE asset_id = ? ORDER BY ts DESC LIMIT 1`,
);

const closeAtOrBeforeStmt = db.prepare(
  `SELECT c AS close, ts FROM candles_1m WHERE asset_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`,
);

const rowCountCandlesStmt = db.prepare(
  `SELECT COUNT(*) AS count FROM candles_1m WHERE asset_id = ?`,
);

const avgCloseSinceStmt = db.prepare(
  `SELECT AVG(c) AS avg FROM candles_1m WHERE asset_id = ? AND ts >= ?`,
);

interface CloseTs {
  close: number;
  ts: number;
}

function latestClose(assetId: number): CloseTs | null {
  const r = latest1mCloseStmt.get(assetId) as { close: number; ts: number } | undefined;
  if (!r || !Number.isFinite(r.close)) return null;
  return { close: r.close, ts: r.ts };
}

function closeAtOrBefore(assetId: number, ts: number): CloseTs | null {
  const r = closeAtOrBeforeStmt.get(assetId, ts) as
    | { close: number; ts: number }
    | undefined;
  if (!r || !Number.isFinite(r.close)) return null;
  return { close: r.close, ts: r.ts };
}

function hasAnyCandles(assetId: number): boolean {
  const r = rowCountCandlesStmt.get(assetId) as { count: number };
  return r.count > 0;
}

function avgCloseSince(assetId: number, sinceTs: number): number | null {
  const r = avgCloseSinceStmt.get(assetId, sinceTs) as { avg: number | null } | undefined;
  if (!r || r.avg === null || !Number.isFinite(r.avg) || r.avg <= 0) return null;
  return r.avg;
}

// ─── api key presence ────────────────────────────────────────────────

const apiKeyPresentStmt = db.prepare(
  `SELECT 1 AS present FROM api_keys WHERE service = ? LIMIT 1`,
);

function hasApiKey(service: string): boolean {
  const r = apiKeyPresentStmt.get(service) as { present: number } | undefined;
  return r !== undefined;
}

// ─── whale netflow ────────────────────────────────────────────────────

interface AssetRow {
  id: number;
  symbol: string;
  display_name: string;
  type: string;
}

interface WhaleEventRow {
  ts: number;
  payload_json: string;
}

const whaleEventsSinceStmt = db.prepare(
  `SELECT ts, payload_json FROM events
     WHERE kind = 'whale_tx' AND ts >= ?`,
);

interface IgnoreAddrRow {
  chain: string;
  address: string;
}

const ignoreAddressesStmt = db.prepare(
  `SELECT chain, address FROM ignore_addresses`,
);

function symbolToChain(symbol: string): 'eth' | 'sol' | 'btc' | null {
  const upper = symbol.toUpperCase();
  if (upper.startsWith('BTC')) return 'btc';
  if (upper.startsWith('ETH')) return 'eth';
  if (upper.startsWith('SOL')) return 'sol';
  return null;
}

function whaleNetflowUsd(
  chain: 'eth' | 'sol' | 'btc',
  ignoreSet: Set<string>,
  now: number,
): number {
  const sinceTs = now - 86_400;
  const rows = whaleEventsSinceStmt.all(sinceTs) as WhaleEventRow[];
  let net = 0;
  for (const row of rows) {
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
    if (!payload) continue;
    const pChain = payload.chain;
    if (pChain !== chain) continue;
    const cp = payload.counterpart;
    if (typeof cp !== 'string' || cp.length === 0) continue;
    const cpKey = chain === 'eth' ? cp.toLowerCase() : cp;
    const key = `${chain}:${cpKey}`;
    if (!ignoreSet.has(key)) continue;
    const dir = payload.direction === 'in' ? 'in' : 'out';
    const usd = typeof payload.usdValue === 'number' ? payload.usdValue : 0;
    if (!Number.isFinite(usd) || usd === 0) continue;
    // `direction` is from the tracked whale's perspective:
    //   out → whale sent to exchange (deposit) → bearish for price, net > 0
    //   in  → whale pulled from exchange (withdrawal) → bullish, net < 0
    net += dir === 'out' ? usd : -usd;
  }
  return net;
}

// ─── news sentiment aggregate ─────────────────────────────────────────

interface NewsEventRow {
  ts: number;
  payload_json: string;
}

const newsSinceStmt = db.prepare(
  `SELECT ts, payload_json FROM events
     WHERE kind = 'news' AND ts >= ?`,
);

function baseTicker(symbol: string): string {
  const upper = symbol.toUpperCase();
  // Strip common quote-currency suffixes for crypto pairs.
  for (const suf of ['USDT', 'USD', 'USDC', 'BUSD']) {
    if (upper.endsWith(suf) && upper.length > suf.length) {
      return upper.slice(0, -suf.length);
    }
  }
  return upper;
}

function newsSentimentAggregate(
  symbol: string,
  now: number,
): { value: number; asOf: number; count: number } {
  const sinceTs = now - 6 * 3600;
  const rows = newsSinceStmt.all(sinceTs) as NewsEventRow[];
  const ticker = baseTicker(symbol);
  let weightedSum = 0;
  let weightSum = 0;
  let latestTs = 0;
  let count = 0;
  for (const row of rows) {
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
    if (!payload) continue;
    const tickers = Array.isArray(payload.tickers) ? (payload.tickers as unknown[]) : null;
    if (!tickers) continue;
    if (
      !tickers.some(
        (t) => typeof t === 'string' && t.toUpperCase() === ticker,
      )
    ) {
      continue;
    }
    const s = payload.sentiment;
    if (typeof s !== 'number' || !Number.isFinite(s)) continue;
    const ageHrs = Math.max(0, (now - row.ts) / 3600);
    // Recency weight — linear decay over 6h window.
    const w = Math.max(0, 1 - ageHrs / 6);
    weightedSum += s * w;
    weightSum += w;
    if (row.ts > latestTs) latestTs = row.ts;
    count += 1;
  }
  if (weightSum === 0) return { value: 0, asOf: now, count: 0 };
  return { value: clamp(weightedSum / weightSum, -1, 1), asOf: latestTs || now, count };
}

// ─── signal builders ──────────────────────────────────────────────────

function sFearGreedLevel(_now: number): SignalReading | null {
  const r = latestIndicator('fng_crypto');
  if (!r) return null;
  // Extreme fear (v=0) → +1 bullish contrarian; Extreme greed (v=100) → -1.
  const valueNormalized = clamp((50 - r.value) / 50, -1, 1);
  return {
    name: 'fear_greed_level',
    valueNormalized,
    weight: currentWeights.fear_greed_level,
    rawValue: r.value,
    asOf: r.ts,
  };
}

function sFearGreedDelta(now: number): SignalReading | null {
  const latest = latestIndicator('fng_crypto');
  if (!latest) return null;
  const prior = indicatorAtOrBefore('fng_crypto', now - 86_400);
  if (!prior) return null;
  const delta = latest.value - prior.value;
  const valueNormalized = clamp(Math.tanh(delta / 10), -1, 1);
  return {
    name: 'fear_greed_delta',
    valueNormalized,
    weight: currentWeights.fear_greed_delta,
    rawValue: delta,
    asOf: latest.ts,
  };
}

function sDxyTrend(now: number): SignalReading | null {
  const points = indicatorSince('dxy', now - 7 * 86_400);
  if (points.length < 2) return null;
  const slope = linregSlopePerDay(points);
  if (slope === null) return null;
  // Rising USD bearish for risk assets.
  const valueNormalized = clamp(-Math.tanh(slope / 0.5), -1, 1);
  return {
    name: 'dxy_trend',
    valueNormalized,
    weight: currentWeights.dxy_trend,
    rawValue: slope,
    asOf: points[points.length - 1]!.ts,
  };
}

function sVixLevel(_now: number): SignalReading | null {
  const r = latestIndicator('vix');
  if (!r) return null;
  // High VIX → bearish. Normalize around 20.
  const valueNormalized = clamp(-(r.value - 20) / 20, -1, 1);
  return {
    name: 'vix_level',
    valueNormalized,
    weight: currentWeights.vix_level,
    rawValue: r.value,
    asOf: r.ts,
  };
}

function sFundingRate(symbol: string): SignalReading | null {
  const r = latestIndicator(`funding_${symbol}`);
  if (!r) return null;
  // Positive funding → longs pay shorts → crowded longs → bearish mean-revert.
  const valueNormalized = clamp(-Math.tanh(r.value * 10_000), -1, 1);
  return {
    name: 'funding_rate',
    valueNormalized,
    weight: currentWeights.funding_rate,
    rawValue: r.value,
    asOf: r.ts,
  };
}

function sOpenInterestDelta(symbol: string, now: number): SignalReading | null {
  const latest = latestIndicator(`oi_${symbol}`);
  if (!latest) return null;
  const prior = indicatorAtOrBefore(`oi_${symbol}`, now - 3_600);
  if (!prior || prior.value === 0) return null;
  const deltaPct = ((latest.value - prior.value) / prior.value) * 100;
  const valueNormalized = clamp(Math.tanh(deltaPct / 10), -1, 1);
  return {
    name: 'open_interest_delta',
    valueNormalized,
    weight: currentWeights.open_interest_delta,
    rawValue: deltaPct,
    asOf: latest.ts,
  };
}

function sBtcDominanceTrend(symbol: string, now: number): SignalReading | null {
  const points = indicatorSince('btc_dominance', now - 86_400);
  if (points.length < 2) return null;
  const slope = linregSlopePerDay(points);
  if (slope === null) return null;
  const upper = symbol.toUpperCase();
  const isBtc = upper.startsWith('BTC');
  // Rising dominance helps BTC, hurts alts.
  const signed = isBtc ? Math.tanh(slope / 2) : -Math.tanh(slope / 2);
  return {
    name: 'btc_dominance_trend',
    valueNormalized: clamp(signed, -1, 1),
    weight: currentWeights.btc_dominance_trend,
    rawValue: slope,
    asOf: points[points.length - 1]!.ts,
  };
}

function sWhaleNetflow(
  symbol: string,
  ignoreSet: Set<string>,
  now: number,
): SignalReading | null {
  const chain = symbolToChain(symbol);
  if (!chain) return null;
  // If the chain API key isn't configured, we have no whale data → null rather
  // than emitting a misleading neutral 0. BTC uses Blockstream (no key needed).
  if (chain === 'eth' && !hasApiKey('etherscan')) return null;
  if (chain === 'sol' && !hasApiKey('helius')) return null;
  const net = whaleNetflowUsd(chain, ignoreSet, now);
  const valueNormalized = clamp(-Math.tanh(net / 10_000_000), -1, 1);
  return {
    name: 'whale_netflow_to_exchanges',
    valueNormalized,
    weight: currentWeights.whale_netflow_to_exchanges,
    rawValue: net,
    asOf: now,
  };
}

function sNewsSentiment(symbol: string, now: number): SignalReading | null {
  const agg = newsSentimentAggregate(symbol, now);
  if (agg.count === 0) return null;
  return {
    name: 'news_sentiment_aggregate',
    valueNormalized: clamp(agg.value, -1, 1),
    weight: currentWeights.news_sentiment_aggregate,
    rawValue: { mean: agg.value, count: agg.count },
    asOf: agg.asOf,
  };
}

function sPriceMomentum1h(assetId: number, now: number): SignalReading | null {
  const nowClose = latestClose(assetId);
  if (!nowClose) return null;
  const prior = closeAtOrBefore(assetId, now - 3_600);
  if (!prior || prior.close === 0) return null;
  const pct = ((nowClose.close - prior.close) / prior.close) * 100;
  const valueNormalized = clamp(Math.tanh(pct * 5), -1, 1);
  return {
    name: 'price_momentum_1h',
    valueNormalized,
    weight: currentWeights.price_momentum_1h,
    rawValue: pct,
    asOf: nowClose.ts,
  };
}

function sPriceMomentum4h(assetId: number, now: number): SignalReading | null {
  const nowClose = latestClose(assetId);
  if (!nowClose) return null;
  const prior = closeAtOrBefore(assetId, now - 14_400);
  if (!prior || prior.close === 0) return null;
  const pct = ((nowClose.close - prior.close) / prior.close) * 100;
  const valueNormalized = clamp(Math.tanh(pct * 3), -1, 1);
  return {
    name: 'price_momentum_4h',
    valueNormalized,
    weight: currentWeights.price_momentum_4h,
    rawValue: pct,
    asOf: nowClose.ts,
  };
}

function sPriceMomentum24h(assetId: number, now: number): SignalReading | null {
  const nowClose = latestClose(assetId);
  if (!nowClose) return null;
  const prior = closeAtOrBefore(assetId, now - 86_400);
  if (!prior || prior.close === 0) return null;
  const pct = ((nowClose.close - prior.close) / prior.close) * 100;
  const valueNormalized = clamp(Math.tanh(pct * 2), -1, 1);
  return {
    name: 'price_momentum_24h',
    valueNormalized,
    weight: currentWeights.price_momentum_24h,
    rawValue: pct,
    asOf: nowClose.ts,
  };
}

function sRsi14(symbol: string): SignalReading | null {
  const r = latestIndicator(`rsi14_${symbol}`);
  if (!r) return null;
  // Contrarian: RSI > 70 → bearish; RSI < 30 → bullish. Map 50 → 0.
  const valueNormalized = clamp((50 - r.value) / 50, -1, 1);
  return {
    name: 'rsi_14',
    valueNormalized,
    weight: currentWeights.rsi_14,
    rawValue: r.value,
    asOf: r.ts,
  };
}

function sMacdHistogram(
  assetId: number,
  symbol: string,
  now: number,
): SignalReading | null {
  const r = latestIndicator(`macd_hist_${symbol}`);
  if (!r) return null;
  const avg = avgCloseSince(assetId, now - 86_400);
  if (avg === null) return null;
  // Scale-invariant: hist / avgClose * 1000 → roughly unit-scale, then tanh.
  const valueNormalized = clamp(Math.tanh((r.value / avg) * 1000), -1, 1);
  return {
    name: 'macd_histogram',
    valueNormalized,
    weight: currentWeights.macd_histogram,
    rawValue: r.value,
    asOf: r.ts,
  };
}

function sMacdLine(
  assetId: number,
  symbol: string,
  now: number,
): SignalReading | null {
  const r = latestIndicator(`macd_${symbol}`);
  if (!r) return null;
  const avg = avgCloseSince(assetId, now - 86_400);
  if (avg === null) return null;
  const valueNormalized = clamp(Math.tanh((r.value / avg) * 200), -1, 1);
  return {
    name: 'macd_line',
    valueNormalized,
    weight: currentWeights.macd_line,
    rawValue: r.value,
    asOf: r.ts,
  };
}

function sEma20Slope4h(
  assetId: number,
  symbol: string,
  now: number,
): SignalReading | null {
  // ~4h of 1m readings.
  const points = indicatorSince(`ema20_${symbol}`, now - 14_400);
  if (points.length < 10) return null;
  const slope = linregSlopePerDay(points);
  if (slope === null) return null;
  const avg = avgCloseSince(assetId, now - 14_400);
  if (avg === null) return null;
  // slope is value/day. Normalize vs avg price: tanh((slope/avg)*100).
  const valueNormalized = clamp(Math.tanh((slope / avg) * 100), -1, 1);
  return {
    name: 'ema20_slope_4h',
    valueNormalized,
    weight: currentWeights.ema20_slope_4h,
    rawValue: slope,
    asOf: points[points.length - 1]!.ts,
  };
}

function sEma200Distance(
  assetId: number,
  symbol: string,
  _now: number,
): SignalReading | null {
  const ema = latestIndicator(`ema200_${symbol}`);
  if (!ema || ema.value <= 0) return null;
  const close = latestClose(assetId);
  if (!close) return null;
  const pct = (close.close - ema.value) / ema.value;
  // Positive pct = above EMA200 (bullish).
  const valueNormalized = clamp(Math.tanh(pct * 10), -1, 1);
  return {
    name: 'ema200_distance',
    valueNormalized,
    weight: currentWeights.ema200_distance,
    rawValue: pct,
    asOf: Math.min(ema.ts, close.ts),
  };
}

// ─── scoring ──────────────────────────────────────────────────────────

const insertProbStmt = db.prepare(
  `INSERT INTO probability_history
     (ts, asset_id, horizon, bullish_prob, confidence, contributing_json)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

const insertSignalStmt = db.prepare(
  `INSERT INTO signal_readings
     (ts, asset_id, signal, value_normalized, weight, raw_value_json)
   VALUES (?, ?, ?, ?, ?, ?)`,
);

const enabledAssetsStmt = db.prepare(
  `SELECT id, symbol, display_name, type FROM assets
     WHERE enabled = 1 AND type = 'crypto'`,
);

function buildSignal(
  name: SignalName,
  asset: AssetRow,
  ignoreSet: Set<string>,
  now: number,
): SignalReading | null {
  switch (name) {
    case 'fear_greed_level':
      return sFearGreedLevel(now);
    case 'fear_greed_delta':
      return sFearGreedDelta(now);
    case 'dxy_trend':
      return sDxyTrend(now);
    case 'vix_level':
      return sVixLevel(now);
    case 'funding_rate':
      return sFundingRate(asset.symbol);
    case 'open_interest_delta':
      return sOpenInterestDelta(asset.symbol, now);
    case 'btc_dominance_trend':
      return sBtcDominanceTrend(asset.symbol, now);
    case 'whale_netflow_to_exchanges':
      return sWhaleNetflow(asset.symbol, ignoreSet, now);
    case 'news_sentiment_aggregate':
      return sNewsSentiment(asset.symbol, now);
    case 'price_momentum_1h':
      return sPriceMomentum1h(asset.id, now);
    case 'price_momentum_4h':
      return sPriceMomentum4h(asset.id, now);
    case 'price_momentum_24h':
      return sPriceMomentum24h(asset.id, now);
    case 'rsi_14':
      return sRsi14(asset.symbol);
    case 'macd_histogram':
      return sMacdHistogram(asset.id, asset.symbol, now);
    case 'macd_line':
      return sMacdLine(asset.id, asset.symbol, now);
    case 'ema20_slope_4h':
      return sEma20Slope4h(asset.id, asset.symbol, now);
    case 'ema200_distance':
      return sEma200Distance(asset.id, asset.symbol, now);
    default: {
      // Exhaustiveness guard.
      const _exhaustive: never = name;
      return _exhaustive;
    }
  }
}

function scoreAsset(
  asset: AssetRow,
  horizon: Horizon,
  ignoreSet: Set<string>,
  now: number,
): void {
  // Skip assets with no candles yet (backfill still running).
  if (!hasAnyCandles(asset.id)) return;

  const signals: SignalReading[] = [];
  for (const name of HORIZON_SIGNALS[horizon]) {
    const s = buildSignal(name, asset, ignoreSet, now);
    if (s) signals.push(s);
  }

  if (signals.length === 0) return;

  const weighted = signals.reduce((sum, s) => sum + s.valueNormalized * s.weight, 0);
  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const weightedAvg = totalWeight > 0 ? weighted / totalWeight : 0;
  const bullishProb = 1 / (1 + Math.exp(-weightedAvg * 2));

  // Confidence = staleness × agreement
  const stalenessPerSignal = signals.map((s) =>
    Math.max(0, 1 - (now - s.asOf) / 3600),
  );
  const stalenessFactor =
    stalenessPerSignal.reduce((sum, v) => sum + v, 0) / signals.length;
  const avgSign = weightedAvg >= 0 ? 1 : -1;
  const agreementFactor =
    signals.filter((s) => Math.sign(s.valueNormalized || 0.0001) === avgSign).length /
    signals.length;
  const confidence = clamp(stalenessFactor * agreementFactor, 0, 1);

  const contributing = signals.map((s) => ({
    name: s.name,
    valueNormalized: s.valueNormalized,
    weight: s.weight,
    asOf: s.asOf,
  }));
  const contributingJson = JSON.stringify(contributing);

  try {
    const tx = db.transaction(() => {
      insertProbStmt.run(
        now,
        asset.id,
        horizon,
        bullishProb,
        confidence,
        contributingJson,
      );
      for (const s of signals) {
        insertSignalStmt.run(
          now,
          asset.id,
          s.name,
          s.valueNormalized,
          s.weight,
          JSON.stringify({ raw: s.rawValue, asOf: s.asOf }),
        );
      }
    });
    tx();
  } catch (err) {
    logger.error(
      { err, assetId: asset.id, horizon },
      'probability-engine: insert failed',
    );
    return;
  }

  const evt: ProbabilityEvent = {
    id: nextEventId(),
    ts: now,
    source: 'probability-engine',
    kind: 'probability',
    assetId: asset.id,
    horizon,
    bullishProb,
    confidence,
  };
  eventBus.emit(evt);
}

export function computeScores(): void {
  const now = nowSec();
  const assets = enabledAssetsStmt.all() as AssetRow[];
  if (assets.length === 0) return;

  const ignoreRows = ignoreAddressesStmt.all() as IgnoreAddrRow[];
  const ignoreSet = new Set<string>(
    ignoreRows.map((r) => {
      const addr = r.chain === 'eth' ? r.address.toLowerCase() : r.address;
      return `${r.chain}:${addr}`;
    }),
  );

  for (const asset of assets) {
    for (const horizon of HORIZONS) {
      try {
        scoreAsset(asset, horizon, ignoreSet, now);
      } catch (err) {
        logger.error(
          { err, assetId: asset.id, horizon },
          'probability-engine: scoreAsset failed',
        );
      }
    }
  }
}

export function startProbabilityEngine(): void {
  if (running) return;
  running = true;

  loadWeightsSync();
  watchWeightsFile();

  task = cron.schedule('0 * * * * *', () => {
    try {
      computeScores();
    } catch (err) {
      logger.error({ err }, 'probability-engine: tick failed');
    }
  });
  logger.info('probability-engine started (every 1m)');

  // Kick once so the UI has data shortly after boot.
  setTimeout(() => {
    try {
      computeScores();
    } catch (err) {
      logger.error({ err }, 'probability-engine: initial tick failed');
    }
  }, 5_000);
}

export function stopProbabilityEngine(): void {
  if (!running) return;
  running = false;
  if (task) {
    try {
      task.stop();
    } catch (err) {
      logger.error({ err }, 'probability-engine: stop failed');
    }
    task = null;
  }
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
    watcher = null;
  }
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
}

export function weightsFile(): string {
  return weightsFilePath();
}
