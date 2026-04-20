'use client';

import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

interface IndicatorLatest {
  name: string;
  ts: number;
  value: number;
  meta: Record<string, unknown> | null;
}

interface IndicatorsResponse {
  indicators: IndicatorLatest[];
}

interface HistoryPoint {
  ts: number;
  value: number;
  meta?: Record<string, unknown> | null;
}

interface HistoryResponse {
  points: HistoryPoint[];
}

type Direction = 'up' | 'down' | 'flat';
type Tone = 'bearish' | 'bullish' | 'neutral';

// dxy/vix poll every ~5 min → 288 samples covers ~24h
// btc_dominance every 30 min → 48 samples covers 24h
// DGS10 (FRED) is daily → limit=3 is plenty to find a prior day's value
const HISTORY_LIMIT = 300;
const DAY_SEC = 86_400;

// Which FRED series ID represents the US 10Y yield.
// fred.ts stores under the raw series_id ('DGS10'). If the key is missing,
// the row simply won't exist and we render "NOT WIRED".
const UST10Y_NAME = 'DGS10';

interface MacroRow {
  key: string;
  label: string;
  unit: '' | '%';
  tone: Tone; // interpretation: does "up" hurt risk assets?
  decimals: number;
}

const ROWS: MacroRow[] = [
  { key: 'dxy', label: 'DXY', unit: '', tone: 'bearish', decimals: 2 },
  { key: 'vix', label: 'VIX', unit: '', tone: 'bearish', decimals: 2 },
  { key: 'btc_dominance', label: 'BTC.D', unit: '%', tone: 'neutral', decimals: 2 },
  { key: UST10Y_NAME, label: '10Y TSY', unit: '%', tone: 'bearish', decimals: 2 },
];

function fmt(v: number | null | undefined, decimals: number, unit: '' | '%'): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v.toFixed(decimals)}${unit}`;
}

function fmtDelta(d: number | null, decimals: number, unit: '' | '%'): string {
  if (d === null || !Number.isFinite(d)) return '';
  const sign = d > 0 ? '+' : d < 0 ? '' : '';
  return `${sign}${d.toFixed(decimals)}${unit}`;
}

function fmtPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '';
  const sign = pct > 0 ? '+' : pct < 0 ? '' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function classify(direction: Direction, tone: Tone): string {
  if (direction === 'flat') return 'text-text-secondary';
  if (tone === 'neutral') return 'text-neon-amber';
  if (tone === 'bearish') {
    return direction === 'up' ? 'text-neon-red' : 'text-neon-green';
  }
  // tone === 'bullish' (unused today, kept for future)
  return direction === 'up' ? 'text-neon-green' : 'text-neon-red';
}

function baselineAt24hAgo(
  points: HistoryPoint[] | undefined,
  latestTs: number,
): number | null {
  if (!points || points.length === 0) return null;
  // history endpoint returns ASC (oldest first). Find the oldest point
  // within ~24h of latestTs; if all are older than 24h take the earliest
  // available so we still show a delta rather than nothing.
  const cutoff = latestTs - DAY_SEC;
  let baseline: HistoryPoint | null = null;
  for (const p of points) {
    if (p.ts >= cutoff) {
      baseline = p;
      break;
    }
  }
  if (!baseline) baseline = points[0];
  if (!baseline) return null;
  return baseline.value;
}

export function MacroWatch() {
  const { data: latestData } = useQuery<IndicatorsResponse>({
    queryKey: ['macro-watch', 'latest'],
    queryFn: () => api.get<IndicatorsResponse>('/api/indicators'),
    refetchInterval: 60_000,
  });

  const latestByName = useMemo(() => {
    const m = new Map<string, IndicatorLatest>();
    (latestData?.indicators ?? []).forEach((i) => m.set(i.name, i));
    return m;
  }, [latestData]);

  const historyQueries = useQueries({
    queries: ROWS.map((row) => ({
      queryKey: ['macro-watch', 'history', row.key],
      queryFn: () =>
        api.get<HistoryResponse>(
          `/api/indicators/history?name=${encodeURIComponent(row.key)}&limit=${HISTORY_LIMIT}`,
        ),
      refetchInterval: 60_000,
      staleTime: 30_000,
    })),
  });

  const computed = ROWS.map((row, idx) => {
    const latest = latestByName.get(row.key) ?? null;
    const latestValue = latest ? latest.value : null;
    const latestTs = latest ? latest.ts : Math.floor(Date.now() / 1000);

    const history = historyQueries[idx]?.data?.points;
    const baselineValue = baselineAt24hAgo(history, latestTs);

    let delta: number | null = null;
    let pct: number | null = null;
    let direction: Direction = 'flat';
    if (
      latestValue !== null &&
      baselineValue !== null &&
      Number.isFinite(latestValue) &&
      Number.isFinite(baselineValue)
    ) {
      delta = latestValue - baselineValue;
      pct = baselineValue !== 0 ? (delta / baselineValue) * 100 : null;
      if (delta > 0) direction = 'up';
      else if (delta < 0) direction = 'down';
    }

    return { row, latestValue, delta, pct, direction };
  });

  // Regime logic uses DXY delta + VIX level.
  const dxyRow = computed.find((c) => c.row.key === 'dxy');
  const vixRow = computed.find((c) => c.row.key === 'vix');
  const dxyDelta = dxyRow?.delta ?? null;
  const vixValue = vixRow?.latestValue ?? null;

  let regimeLabel: string;
  let regimeCls: string;
  if (dxyDelta === null || vixValue === null) {
    regimeLabel = 'INSUFFICIENT DATA';
    regimeCls = 'text-text-dim';
  } else if (dxyDelta <= 0 && vixValue < 20) {
    regimeLabel = 'RISK-ON';
    regimeCls = 'text-neon-green glow';
  } else if (dxyDelta > 0 && vixValue >= 20) {
    regimeLabel = 'RISK-OFF';
    regimeCls = 'text-neon-red glow';
  } else {
    regimeLabel = 'MIXED';
    regimeCls = 'text-neon-amber glow';
  }

  return (
    <div className="flex flex-col gap-2 border border-border-dim bg-bg-terminal p-3">
      <h3 className="pixel-font text-[10px] text-text-secondary uppercase tracking-wider">
        MACRO WATCH
      </h3>
      <ul className="flex flex-col">
        {computed.map(({ row, latestValue, delta, pct, direction }) => {
          const wired = latestValue !== null;
          const cls = classify(direction, row.tone);
          return (
            <li
              key={row.key}
              className="grid grid-cols-[70px_1fr_auto] items-center gap-2 py-1 border-b border-border-dim last:border-b-0"
            >
              <span className="pixel-font text-[9px] text-text-secondary uppercase tracking-wider">
                {row.label}
              </span>
              {wired ? (
                <span className={`vt-font text-sm tabular-nums ${cls}`}>
                  {fmt(latestValue, row.decimals, row.unit)}
                </span>
              ) : (
                <span className="pixel-font text-[8px] text-neon-amber border border-neon-amber px-2 py-0.5 inline-block justify-self-start uppercase tracking-wider">
                  NOT WIRED
                </span>
              )}
              {wired && delta !== null ? (
                <span
                  className={`vt-font text-[11px] tabular-nums text-right ${cls}`}
                >
                  {fmtDelta(delta, row.decimals, row.unit)}
                  {pct !== null ? ` / ${fmtPct(pct)}` : ''}
                </span>
              ) : (
                <span className="vt-font text-[11px] text-text-dim text-right">
                  —
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between pt-1">
        <span className="pixel-font text-[9px] text-text-secondary uppercase tracking-wider">
          REGIME
        </span>
        <span className={`pixel-font text-[10px] uppercase tracking-wider ${regimeCls}`}>
          {regimeLabel}
        </span>
      </div>
    </div>
  );
}

export default MacroWatch;
