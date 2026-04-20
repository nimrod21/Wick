'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useEventStream } from '@/lib/sse';

interface MarketStatsProps {
  assetId: number | null;
}

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CandlesResponse {
  candles: Candle[];
}

interface TradeTick {
  kind: 'trade_tick';
  assetId?: number;
  price: number;
  qty: number;
  side: 'buy' | 'sell';
  ts: number;
}

function isTradeTick(e: unknown): e is TradeTick {
  if (!e || typeof e !== 'object') return false;
  const o = e as { kind?: unknown; price?: unknown };
  return o.kind === 'trade_tick' && typeof o.price === 'number';
}

function fmtPrice(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function fmtVolume(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

function fmtPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

export function MarketStats({ assetId }: MarketStatsProps) {
  const [livePrice, setLivePrice] = useState<number | null>(null);

  const { data } = useQuery({
    queryKey: ['market-stats-24h', assetId],
    queryFn: () =>
      api.get<CandlesResponse>(
        `/api/candles?assetId=${assetId}&timeframe=1h&limit=24`,
      ),
    enabled: assetId !== null,
    refetchInterval: 60_000,
    staleTime: 60_000,
  });

  const { lastEvent } = useEventStream(['trade_tick'], {
    assetIds: assetId !== null ? [assetId] : undefined,
  });

  useEffect(() => {
    if (!lastEvent || !isTradeTick(lastEvent)) return;
    if (
      assetId !== null &&
      typeof lastEvent.assetId === 'number' &&
      lastEvent.assetId !== assetId
    ) {
      return;
    }
    setLivePrice(lastEvent.price);
  }, [lastEvent, assetId]);

  useEffect(() => {
    setLivePrice(null);
  }, [assetId]);

  const stats = useMemo(() => {
    const candles = data?.candles ?? [];
    if (candles.length === 0) {
      return { high: null, low: null, volume: null, change: null, lastClose: null };
    }
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    for (const c of candles) {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
      volume += c.volume;
    }
    const firstOpen = candles[0]?.open ?? null;
    const lastClose = candles[candles.length - 1]?.close ?? null;
    const change =
      firstOpen !== null && lastClose !== null && firstOpen !== 0
        ? ((lastClose - firstOpen) / firstOpen) * 100
        : null;
    return {
      high: Number.isFinite(high) ? high : null,
      low: Number.isFinite(low) ? low : null,
      volume,
      change,
      lastClose,
    };
  }, [data]);

  if (assetId === null) {
    return null;
  }

  const currentPrice = livePrice ?? stats.lastClose;
  const directionColor =
    stats.change === null
      ? 'text-neon-cyan'
      : stats.change >= 0
        ? 'text-neon-green'
        : 'text-neon-red';
  const changeColor =
    stats.change === null
      ? 'text-text-secondary'
      : stats.change >= 0
        ? 'text-neon-green'
        : 'text-neon-red';

  return (
    <div className="flex gap-8 items-center px-4 py-2 border border-border-dim bg-bg-terminal">
      <div className="flex flex-col">
        <span className="pixel-font text-[8px] text-text-secondary uppercase">Price</span>
        <span className={`vt-font text-lg glow ${directionColor}`}>
          {fmtPrice(currentPrice)}
        </span>
      </div>
      <div className="flex flex-col">
        <span className="pixel-font text-[8px] text-text-secondary uppercase">24h Change</span>
        <span className={`vt-font text-lg ${changeColor}`}>{fmtPct(stats.change)}</span>
      </div>
      <div className="flex flex-col">
        <span className="pixel-font text-[8px] text-text-secondary uppercase">24h High</span>
        <span className="vt-font text-lg text-text-primary">{fmtPrice(stats.high)}</span>
      </div>
      <div className="flex flex-col">
        <span className="pixel-font text-[8px] text-text-secondary uppercase">24h Low</span>
        <span className="vt-font text-lg text-text-primary">{fmtPrice(stats.low)}</span>
      </div>
      <div className="flex flex-col">
        <span className="pixel-font text-[8px] text-text-secondary uppercase">24h Volume</span>
        <span className="vt-font text-lg text-text-primary">{fmtVolume(stats.volume)}</span>
      </div>
    </div>
  );
}

export default MarketStats;
