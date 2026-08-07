/**
 * Classical technical-analysis engine. Every minute, for each enabled crypto
 * asset, pull recent 1m candles and compute a standard indicator set
 * (EMA/RSI/MACD/ATR/Bollinger/OBV/volume z-score). Results are persisted to
 * `indicator_readings` and broadcast as IndicatorEvents.
 */

import cron, { type ScheduledTask } from 'node-cron';
import type { IndicatorEvent } from '@wick/shared';
import { db } from '../db/client.js';
import { eventBus } from '../core/event-bus.js';
import { logger } from '../util/logger.js';
import { nowSec } from '../util/time.js';

interface AssetRow {
  id: number;
  symbol: string;
}

interface Candle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const enabledAssetsStmt = db.prepare(
  `SELECT id, symbol FROM assets WHERE enabled = 1 AND type = 'crypto'`,
);

const candlesStmt = db.prepare(
  `SELECT ts, o, h, l, c, v FROM candles_1m WHERE asset_id = ? ORDER BY ts DESC LIMIT 500`,
);

const insertReadingStmt = db.prepare(
  `INSERT OR REPLACE INTO indicator_readings (name, ts, value) VALUES (?, ?, ?)`,
);

// ─── pure compute helpers ─────────────────────────────────────────────

/** EMA series over `values`, aligned to input length.
 *  Indices 0..period-2 are NaN (undefined seed region); index period-1 is the
 *  SMA seed; indices >= period use the recursive EMA formula. */
function computeEMASeries(values: readonly number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(Number.NaN);
  if (values.length < period || period <= 0) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = k * values[i]! + (1 - k) * prev;
    out[i] = prev;
  }
  return out;
}

function lastFinite(series: readonly number[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i]!;
    if (Number.isFinite(v)) return v;
  }
  return null;
}

function computeEMA(values: readonly number[], period: number): number | null {
  if (values.length < period) return null;
  return lastFinite(computeEMASeries(values, period));
}

function computeRSI(closes: readonly number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  // Wilder's smoothing: alpha = 1/period applied to subsequent bars.
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) {
    if (avgGain === 0) return 50;
    return 100;
  }
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

interface MACDResult {
  line: number;
  signal: number;
  hist: number;
}

function computeMACD(closes: readonly number[]): MACDResult | null {
  if (closes.length < 26 + 9) return null;
  const ema12 = computeEMASeries(closes, 12);
  const ema26 = computeEMASeries(closes, 26);
  const macdSeries: number[] = new Array(closes.length).fill(Number.NaN);
  for (let i = 0; i < closes.length; i++) {
    const a = ema12[i]!;
    const b = ema26[i]!;
    if (Number.isFinite(a) && Number.isFinite(b)) macdSeries[i] = a - b;
  }
  // Condense the defined portion of the MACD line so EMA9 seeds from its first real value.
  const firstDefined = macdSeries.findIndex((v) => Number.isFinite(v));
  if (firstDefined < 0) return null;
  const macdTail = macdSeries.slice(firstDefined);
  if (macdTail.length < 9) return null;
  const signalSeries = computeEMASeries(macdTail, 9);
  const line = lastFinite(macdSeries);
  const signal = lastFinite(signalSeries);
  if (line === null || signal === null) return null;
  return { line, signal, hist: line - signal };
}

function computeATR(candles: readonly Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prev.c),
      Math.abs(cur.l - prev.c),
    );
    trs.push(tr);
  }
  if (trs.length < period) return null;
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i]!;
  atr /= period;
  // Wilder's smoothing over remaining TRs.
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
  }
  return atr;
}

interface BBandsResult {
  mid: number;
  upper: number;
  lower: number;
}

function computeBBands(
  closes: readonly number[],
  period = 20,
  mult = 2,
): BBandsResult | null {
  if (closes.length < period) return null;
  const window = closes.slice(closes.length - period);
  let sum = 0;
  for (const v of window) sum += v;
  const mid = sum / period;
  let varSum = 0;
  for (const v of window) {
    const d = v - mid;
    varSum += d * d;
  }
  const stdev = Math.sqrt(varSum / period);
  return {
    mid,
    upper: mid + mult * stdev,
    lower: mid - mult * stdev,
  };
}

function computeOBV(candles: readonly Candle[]): number | null {
  if (candles.length < 2) return null;
  let obv = 0;
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i]!;
    const prev = candles[i - 1]!;
    if (cur.c > prev.c) obv += cur.v;
    else if (cur.c < prev.c) obv -= cur.v;
  }
  return obv;
}

function computeVolZ(volumes: readonly number[], lookback = 60): number | null {
  if (volumes.length < lookback) return null;
  const window = volumes.slice(volumes.length - lookback);
  let sum = 0;
  for (const v of window) sum += v;
  const mean = sum / lookback;
  let varSum = 0;
  for (const v of window) {
    const d = v - mean;
    varSum += d * d;
  }
  const stdev = Math.sqrt(varSum / lookback);
  if (stdev === 0) return null;
  const current = volumes[volumes.length - 1]!;
  return (current - mean) / stdev;
}

// ─── scheduler state ──────────────────────────────────────────────────

let task: ScheduledTask | null = null;
let running = false;
let evtSeq = 1;

function nextEventId(): number {
  return evtSeq++;
}

function writeAndEmit(ts: number, name: string, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  try {
    insertReadingStmt.run(name, ts, value);
  } catch (err) {
    logger.error({ err, name }, 'ta-engine: insert failed');
    return false;
  }
  const evt: IndicatorEvent = {
    id: nextEventId(),
    ts,
    source: 'ta-engine',
    kind: 'indicator',
    name,
    value,
  };
  eventBus.emit(evt);
  return true;
}

export function tick(): void {
  const now = nowSec();
  const assets = enabledAssetsStmt.all() as AssetRow[];
  let totalWritten = 0;

  for (const a of assets) {
    const rowsDesc = candlesStmt.all(a.id) as Candle[];
    if (rowsDesc.length < 30) continue;
    const candles = rowsDesc.slice().reverse();
    const closes = candles.map((c) => c.c);
    const volumes = candles.map((c) => c.v);
    const sym = a.symbol;

    let written = 0;

    const ema20 = computeEMA(closes, 20);
    if (ema20 !== null && writeAndEmit(now, `ema20_${sym}`, ema20)) written++;

    const ema50 = computeEMA(closes, 50);
    if (ema50 !== null && writeAndEmit(now, `ema50_${sym}`, ema50)) written++;

    const ema200 = computeEMA(closes, 200);
    if (ema200 !== null && writeAndEmit(now, `ema200_${sym}`, ema200)) written++;

    const rsi = computeRSI(closes, 14);
    if (rsi !== null && writeAndEmit(now, `rsi14_${sym}`, rsi)) written++;

    const macd = computeMACD(closes);
    if (macd !== null) {
      if (writeAndEmit(now, `macd_${sym}`, macd.line)) written++;
      if (writeAndEmit(now, `macd_signal_${sym}`, macd.signal)) written++;
      if (writeAndEmit(now, `macd_hist_${sym}`, macd.hist)) written++;
    }

    const atr = computeATR(candles, 14);
    if (atr !== null && writeAndEmit(now, `atr14_${sym}`, atr)) written++;

    const bb = computeBBands(closes, 20, 2);
    if (bb !== null) {
      if (writeAndEmit(now, `bb_mid_${sym}`, bb.mid)) written++;
      if (writeAndEmit(now, `bb_upper_${sym}`, bb.upper)) written++;
      if (writeAndEmit(now, `bb_lower_${sym}`, bb.lower)) written++;
    }

    const obv = computeOBV(candles);
    if (obv !== null && writeAndEmit(now, `obv_${sym}`, obv)) written++;

    const volZ = computeVolZ(volumes, 60);
    if (volZ !== null && writeAndEmit(now, `vol_z_${sym}`, volZ)) written++;

    totalWritten += written;
  }

  logger.info({ assets: assets.length, written: totalWritten }, 'ta-engine: tick complete');
}

export function startIndicators(): void {
  if (running) return;
  running = true;
  task = cron.schedule('0 * * * * *', () => {
    try {
      tick();
    } catch (err) {
      logger.error({ err }, 'ta-engine: tick failed');
    }
  });
  logger.info('ta-engine started (every 1m)');
  setTimeout(() => {
    try {
      tick();
    } catch (err) {
      logger.error({ err }, 'ta-engine: initial tick failed');
    }
  }, 7_000);
}

export function stopIndicators(): void {
  if (!running) return;
  running = false;
  if (task) {
    try {
      task.stop();
    } catch (err) {
      logger.error({ err }, 'ta-engine: stop failed');
    }
    task = null;
  }
}
