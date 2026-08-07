/**
 * Pure technical-analysis math. No DB, no cron, no events — the runtime
 * engine that consumes these lives in `market/indicator-engine.ts`.
 *
 * All series are oldest-first arrays.
 */

export interface Candle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** EMA series over `values`, aligned to input length.
 *  Indices 0..period-2 are NaN (undefined seed region); index period-1 is the
 *  SMA seed; indices >= period use the recursive EMA formula. */
export function computeEMASeries(values: readonly number[], period: number): number[] {
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

export function computeEMA(values: readonly number[], period: number): number | null {
  if (values.length < period) return null;
  return lastFinite(computeEMASeries(values, period));
}

export function computeRSI(closes: readonly number[], period = 14): number | null {
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

export interface MACDResult {
  line: number;
  signal: number;
  hist: number;
}

export function computeMACD(closes: readonly number[]): MACDResult | null {
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

export function computeATR(candles: readonly Candle[], period = 14): number | null {
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

export interface BBandsResult {
  mid: number;
  upper: number;
  lower: number;
}

export function computeBBands(
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

/** Last volume divided by SMA(volume, lookback) over the trailing window
 *  (current candle included). null when history is short or average is 0. */
export function computeVolumeRatio(
  volumes: readonly number[],
  lookback = 20,
): number | null {
  if (volumes.length < lookback) return null;
  const window = volumes.slice(volumes.length - lookback);
  let sum = 0;
  for (const v of window) sum += v;
  const mean = sum / lookback;
  if (mean === 0) return null;
  return volumes[volumes.length - 1]! / mean;
}
