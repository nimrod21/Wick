'use client';

import { IndicatorPanel } from '@/components/indicators/IndicatorPanel';
import { FearGreedGauge } from '@/components/indicators/FearGreedGauge';

// Funding rate is stored as a fraction (e.g. 0.0001 = 0.01%). The funding
// endpoint also stashes `nextFundingTime` in meta, but the mini-chart panel
// doesn't show it — only the drawer does. Good enough for MVP.
function fmtFundingPct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(4)}%`;
}

function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `${v.toFixed(2)}%`;
}

function fmtCompact(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}K`;
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function fmtDollar(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return `$${fmtCompact(v)}`;
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="pixel-font text-[11px] text-neon-purple glow uppercase tracking-wider mt-6 mb-3 border-b border-border-dim pb-2">
      {children}
    </h2>
  );
}

export default function IndicatorsPage() {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h1 className="pixel-font text-neon-purple glow text-xs">INDICATORS</h1>
        <span className="vt-font text-text-secondary text-sm">
          Macro + crypto signals • live
        </span>
      </div>

      <SectionHeader>Crypto</SectionHeader>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <FearGreedGauge />
        <IndicatorPanel
          name="btc_dominance"
          displayName="BTC Dominance"
          colorVar="neon-amber"
          format={fmtPct}
        />
        <IndicatorPanel
          name="funding_BTCUSDT"
          displayName="BTC Funding"
          colorVar="neon-cyan"
          format={fmtFundingPct}
          subLabel="Perp"
        />
        <IndicatorPanel
          name="funding_ETHUSDT"
          displayName="ETH Funding"
          colorVar="neon-cyan"
          format={fmtFundingPct}
          subLabel="Perp"
        />
        <IndicatorPanel
          name="funding_SOLUSDT"
          displayName="SOL Funding"
          colorVar="neon-cyan"
          format={fmtFundingPct}
          subLabel="Perp"
        />
        <IndicatorPanel
          name="oi_BTCUSDT"
          displayName="BTC Open Interest"
          colorVar="neon-magenta"
          format={fmtCompact}
        />
        <IndicatorPanel
          name="oi_ETHUSDT"
          displayName="ETH Open Interest"
          colorVar="neon-magenta"
          format={fmtCompact}
        />
        <IndicatorPanel
          name="oi_SOLUSDT"
          displayName="SOL Open Interest"
          colorVar="neon-magenta"
          format={fmtCompact}
        />
      </div>

      <SectionHeader>Macro</SectionHeader>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <IndicatorPanel
          name="dxy"
          displayName="DXY"
          colorVar="neon-green"
          format={fmtCompact}
          subLabel="USD Index"
        />
        <IndicatorPanel
          name="vix"
          displayName="VIX"
          colorVar="neon-red"
          format={fmtCompact}
          subLabel="Volatility"
        />
        <IndicatorPanel
          name="CPIAUCSL"
          displayName="CPI"
          colorVar="neon-amber"
          format={fmtCompact}
          subLabel="Price Index"
        />
        <IndicatorPanel
          name="DGS10"
          displayName="10Y Treasury"
          colorVar="neon-cyan"
          format={fmtPct}
          subLabel="Yield"
        />
        <IndicatorPanel
          name="DFF"
          displayName="Fed Funds"
          colorVar="neon-cyan"
          format={fmtPct}
          subLabel="Rate"
        />
        <IndicatorPanel
          name="UNRATE"
          displayName="Unemployment"
          colorVar="neon-amber"
          format={fmtPct}
          subLabel="US"
        />
        <IndicatorPanel
          name="DCOILWTICO"
          displayName="WTI Crude"
          colorVar="neon-green"
          format={fmtDollar}
          subLabel="Spot"
        />
      </div>
    </div>
  );
}
