'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
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

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function byName(list: IndicatorLatest[] | undefined, name: string): IndicatorLatest | null {
  if (!list) return null;
  return list.find((i) => i.name === name) ?? null;
}

function fmtCompact(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${v.toFixed(2)}%`;
}

function Pill({
  label,
  value,
  sub,
  colorCls,
  keyMissing,
}: {
  label: string;
  value: string;
  sub?: string;
  colorCls: string;
  keyMissing?: boolean;
}) {
  return (
    <div className="flex-1 bg-bg-terminal border-2 border-border-dim px-4 py-3 flex flex-col gap-1 min-w-[140px]">
      <div className="pixel-font text-[9px] text-text-secondary uppercase tracking-widest">
        {label}
      </div>
      {keyMissing ? (
        <Link
          href="/settings"
          className="pixel-font text-[9px] text-neon-amber glow px-2 py-1 border border-neon-amber inline-block self-start hover:bg-neon-amber/10"
        >
          KEY MISSING →
        </Link>
      ) : (
        <div className={`vt-font text-3xl glow ${colorCls} leading-none`}>{value}</div>
      )}
      {sub ? (
        <div className="pixel-font text-[8px] text-text-dim uppercase tracking-wider whitespace-nowrap">
          {sub}
        </div>
      ) : null}
    </div>
  );
}

function fngClassification(v: number): string {
  if (v <= 24) return 'Extreme Fear';
  if (v <= 49) return 'Fear';
  if (v === 50) return 'Neutral';
  if (v <= 74) return 'Greed';
  return 'Extreme Greed';
}

function fngColor(v: number): string {
  if (v <= 24) return 'text-neon-green';
  if (v <= 49) return 'text-neon-cyan';
  if (v <= 74) return 'text-neon-amber';
  return 'text-neon-red';
}

export function MacroStrip() {
  const { data } = useQuery<IndicatorsResponse>({
    queryKey: ['dashboard-indicators'],
    queryFn: () => api.get<IndicatorsResponse>('/api/indicators'),
    refetchInterval: 30_000,
  });

  const list = data?.indicators;
  const fng = byName(list, 'fng_crypto');
  const dxy = byName(list, 'dxy');
  const vix = byName(list, 'vix');
  const btcDom = byName(list, 'btc_dominance');

  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const fngVal = fng?.value;
  const fngCls =
    typeof fngVal === 'number' && Number.isFinite(fngVal) ? fngClassification(fngVal) : undefined;
  const fngColorCls =
    typeof fngVal === 'number' && Number.isFinite(fngVal) ? fngColor(fngVal) : 'text-text-primary';

  return (
    <div className="flex gap-3">
      <Pill
        label="F&G"
        value={fngVal !== undefined ? fngVal.toFixed(0) : '—'}
        sub={fngCls}
        colorCls={fngColorCls}
      />
      <Pill
        label="DXY"
        value={fmtCompact(dxy?.value ?? null)}
        sub="USD Idx"
        colorCls="text-neon-green"
        keyMissing={dxy?.value === undefined || dxy?.value === null}
      />
      <Pill
        label="VIX"
        value={fmtCompact(vix?.value ?? null)}
        sub="Volatility"
        colorCls="text-neon-red"
        keyMissing={vix?.value === undefined || vix?.value === null}
      />
      <Pill
        label="BTC.D"
        value={fmtPct(btcDom?.value ?? null)}
        sub="Dominance"
        colorCls="text-neon-amber"
      />
      <Pill
        label="CLOCK"
        value={now ? timeFormatter.format(now) : '—'}
        sub="Local"
        colorCls="text-neon-cyan"
      />
    </div>
  );
}

export default MacroStrip;
