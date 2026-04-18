'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  createChart,
  ColorType,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { api } from '@/lib/api';

type Range = '1d' | '7d' | '30d' | '1y';

interface IndicatorPanelProps {
  name: string;
  displayName: string;
  colorVar?: string; // 'neon-cyan' | 'neon-green' | ...
  format?: (v: number) => string;
  subLabel?: string;
}

interface Point {
  ts: number;
  value: number;
}

interface SeriesResponse {
  name: string;
  points: Point[];
}

const RANGE_SECONDS: Record<Range, number> = {
  '1d': 24 * 3600,
  '7d': 7 * 24 * 3600,
  '30d': 30 * 24 * 3600,
  '1y': 365 * 24 * 3600,
};

const CSS_COLOR: Record<string, string> = {
  'neon-cyan': '#00ffff',
  'neon-magenta': '#ff00ff',
  'neon-green': '#39ff14',
  'neon-red': '#ff3864',
  'neon-amber': '#ffb000',
  'neon-purple': '#b967ff',
};

// Tailwind's JIT cannot see template-literal class names, so we pre-declare
// every color variant we support here.
const COLOR_TEXT_CLASS: Record<string, string> = {
  'neon-cyan': 'text-neon-cyan',
  'neon-magenta': 'text-neon-magenta',
  'neon-green': 'text-neon-green',
  'neon-red': 'text-neon-red',
  'neon-amber': 'text-neon-amber',
  'neon-purple': 'text-neon-purple',
};

function defaultFormat(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function fmtDelta(current: number, prev: number | null): { text: string; cls: string } {
  if (prev === null || !Number.isFinite(prev) || prev === 0) {
    return { text: '—', cls: 'text-text-dim' };
  }
  const pct = ((current - prev) / Math.abs(prev)) * 100;
  const sign = pct >= 0 ? '+' : '';
  return {
    text: `${sign}${pct.toFixed(2)}%`,
    cls: pct >= 0 ? 'text-neon-green' : 'text-neon-red',
  };
}

function MiniPolyline({
  points,
  color,
}: {
  points: Point[];
  color: string;
}) {
  if (points.length < 2) {
    return (
      <svg viewBox="0 0 100 24" className="w-full h-6" preserveAspectRatio="none">
        <line x1="0" y1="12" x2="100" y2="12" stroke={color} strokeWidth="1" opacity="0.4" />
      </svg>
    );
  }
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const n = points.length;
  const path = points
    .map((p, i) => {
      const x = (i / (n - 1)) * 100;
      const y = 24 - ((p.value - min) / span) * 22 - 1;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <svg viewBox="0 0 100 24" className="w-full h-6" preserveAspectRatio="none">
      <path d={path} fill="none" stroke={color} strokeWidth="1.2" />
    </svg>
  );
}

function HistoryDrawer({
  name,
  displayName,
  colorVar,
  onClose,
  format,
}: {
  name: string;
  displayName: string;
  colorVar: string;
  onClose: () => void;
  format: (v: number) => string;
}) {
  const [range, setRange] = useState<Range>('30d');

  const { data, isLoading } = useQuery<SeriesResponse>({
    queryKey: ['indicator-series', name, range],
    queryFn: () => {
      const from = Math.floor(Date.now() / 1000) - RANGE_SECONDS[range];
      return api.get<SeriesResponse>(
        `/api/indicators/${encodeURIComponent(name)}?from=${from}&limit=5000`,
      );
    },
  });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const color = CSS_COLOR[colorVar] ?? CSS_COLOR['neon-cyan']!;
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#e0e0ff',
        fontFamily: '"VT323", monospace',
        fontSize: 14,
      },
      grid: {
        vertLines: { color: '#1a2040', style: LineStyle.Dotted },
        horzLines: { color: '#1a2040', style: LineStyle.Dotted },
      },
      rightPriceScale: { borderColor: '#3a4060' },
      timeScale: { borderColor: '#3a4060', timeVisible: true, secondsVisible: false },
      crosshair: {
        vertLine: { color, labelBackgroundColor: '#0a0014' },
        horzLine: { color, labelBackgroundColor: '#0a0014' },
      },
      width: el.clientWidth,
      height: 360,
    });
    const series = chart.addLineSeries({ color, lineWidth: 2 });
    chartRef.current = chart;
    seriesRef.current = series;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [colorVar]);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart || !data?.points) return;
    const rows = data.points.map((p) => ({
      time: p.ts as UTCTimestamp,
      value: p.value,
    }));
    series.setData(rows);
    chart.timeScale().fitContent();
  }, [data]);

  const latest = data?.points[data.points.length - 1]?.value ?? null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl bg-bg-terminal border-2 border-neon-purple shadow-[0_0_20px_var(--neon-purple)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-dim">
          <div className="flex items-baseline gap-3">
            <span className="pixel-font text-[10px] text-neon-purple glow">
              {displayName.toUpperCase()}
            </span>
            <span className="vt-font text-2xl text-text-primary glow">
              {latest !== null ? format(latest) : '—'}
            </span>
          </div>
          <button
            type="button"
            className="pixel-font text-[10px] text-text-secondary hover:text-neon-red px-2 py-1 border border-border-dim"
            onClick={onClose}
          >
            X
          </button>
        </div>
        <div className="flex gap-2 px-4 py-2 border-b border-border-dim">
          {(['1d', '7d', '30d', '1y'] as const).map((r) => (
            <button
              type="button"
              key={r}
              className={`pixel-font text-[9px] px-2 py-1 border ${
                range === r
                  ? 'border-neon-purple text-neon-purple glow'
                  : 'border-border-dim text-text-secondary hover:text-neon-cyan'
              }`}
              onClick={() => setRange(r)}
            >
              {r.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="relative w-full" style={{ height: 360 }}>
          <div ref={containerRef} className="absolute inset-0" />
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="vt-font text-neon-cyan glow">LOADING…</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function IndicatorPanel({
  name,
  displayName,
  colorVar = 'neon-cyan',
  format,
  subLabel,
}: IndicatorPanelProps) {
  const [open, setOpen] = useState(false);
  const fmt = format ?? defaultFormat;

  const { data } = useQuery<SeriesResponse>({
    queryKey: ['indicator-mini', name],
    queryFn: () =>
      api.get<SeriesResponse>(`/api/indicators/${encodeURIComponent(name)}?limit=50`),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const points = data?.points ?? [];
  const current = points.length > 0 ? points[points.length - 1]!.value : null;
  const prior = points.length > 1 ? points[points.length - 2]!.value : null;

  const delta = useMemo(() => {
    if (current === null) return { text: '—', cls: 'text-text-dim' };
    return fmtDelta(current, prior);
  }, [current, prior]);

  const colorCls = COLOR_TEXT_CLASS[colorVar] ?? COLOR_TEXT_CLASS['neon-cyan']!;
  const cssColor = CSS_COLOR[colorVar] ?? CSS_COLOR['neon-cyan']!;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block w-full text-left bg-bg-terminal border-2 border-border-dim hover:border-neon-purple p-3 transition-colors"
      >
        <div className="flex items-center justify-between">
          <span className="pixel-font text-[10px] text-text-secondary uppercase">
            {displayName}
          </span>
          {subLabel ? (
            <span className="pixel-font text-[8px] text-text-dim uppercase">
              {subLabel}
            </span>
          ) : null}
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className={`vt-font text-4xl glow ${colorCls}`}>
            {current !== null ? fmt(current) : '—'}
          </span>
          <span className={`vt-font text-sm ${delta.cls}`}>{delta.text}</span>
        </div>
        <div className="mt-2">
          <MiniPolyline points={points} color={cssColor} />
        </div>
      </button>
      {open ? (
        <HistoryDrawer
          name={name}
          displayName={displayName}
          colorVar={colorVar}
          onClose={() => setOpen(false)}
          format={fmt}
        />
      ) : null}
    </>
  );
}

export default IndicatorPanel;
