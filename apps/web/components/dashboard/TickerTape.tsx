'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useEventStream } from '@/lib/sse';

interface Asset {
  id: number;
  symbol: string;
  displayName: string;
  type: string;
  enabled: boolean;
}

interface AssetsResponse {
  assets: Asset[];
}

interface Candle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface CandlesResponse {
  candles: Candle[];
}

interface IndicatorPoint {
  ts: number;
  value: number;
  meta: Record<string, unknown> | null;
}

interface IndicatorSeriesResponse {
  name: string;
  points: IndicatorPoint[];
}

interface TradeTickEvent {
  kind: 'trade_tick';
  assetId: number;
  price: number;
}

type PriceMap = Record<number, number>;

const CRYPTO_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'ADAUSDT',
  'BNBUSDT',
  'LTCUSDT',
  'XRPUSDT',
] as const;

const MACRO_SYMBOLS = ['SPY', 'QQQ', 'DXY', 'GOLD', 'VIX'] as const;

// Some macro symbols are tracked as indicators rather than tradable assets.
// Map a symbol to its canonical indicator name (lower-case).
const MACRO_INDICATOR_NAMES: Record<string, string> = {
  DXY: 'dxy',
  GOLD: 'gold',
  VIX: 'vix',
  SPY: 'spy',
  QQQ: 'qqq',
};

function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v >= 1000) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function changeColor(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return 'text-text-dim';
  if (pct > 0) return 'text-neon-green';
  if (pct < 0) return 'text-neon-red';
  return 'text-text-dim';
}

function fmtPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '—';
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function AssetTickerItem({
  asset,
  livePrice,
}: {
  asset: Asset;
  livePrice: number | undefined;
}) {
  const { data } = useQuery<CandlesResponse>({
    queryKey: ['ticker-candles', asset.id],
    queryFn: () =>
      api.get<CandlesResponse>(
        `/api/candles?assetId=${asset.id}&timeframe=1h&limit=24`,
      ),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

  const candles = data?.candles ?? [];
  const baselineOpen = candles[0]?.o ?? null;
  const lastClose = candles[candles.length - 1]?.c ?? null;
  const price = livePrice ?? lastClose ?? null;
  const pct =
    price !== null && baselineOpen !== null && baselineOpen > 0
      ? ((price - baselineOpen) / baselineOpen) * 100
      : null;

  const loaded = price !== null;

  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <span className="pixel-font text-[10px] text-text-secondary">
        {asset.symbol}
      </span>
      <span className="vt-font text-sm text-text-primary">
        {fmtPrice(price)}
      </span>
      <span className={`vt-font text-sm ${loaded ? changeColor(pct) : 'text-text-dim'}`}>
        {fmtPct(pct)}
      </span>
    </span>
  );
}

function MacroIndicatorItem({ symbol }: { symbol: string }) {
  const indicatorName = MACRO_INDICATOR_NAMES[symbol] ?? symbol.toLowerCase();

  const { data } = useQuery<IndicatorSeriesResponse>({
    queryKey: ['ticker-indicator', indicatorName],
    queryFn: () =>
      api.get<IndicatorSeriesResponse>(
        `/api/indicators/${encodeURIComponent(indicatorName)}?limit=2`,
      ),
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    retry: false,
  });

  const points = data?.points ?? [];
  const latest = points[points.length - 1] ?? null;
  const prev = points.length >= 2 ? points[0] ?? null : null;
  const value =
    latest && Number.isFinite(latest.value) ? latest.value : null;
  const prevVal =
    prev && Number.isFinite(prev.value) ? prev.value : null;
  const pct =
    value !== null && prevVal !== null && prevVal !== 0
      ? ((value - prevVal) / prevVal) * 100
      : null;

  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <span className="pixel-font text-[10px] text-text-secondary">{symbol}</span>
      <span className="vt-font text-sm text-text-primary">{fmtPrice(value)}</span>
      <span className={`vt-font text-sm ${value !== null ? changeColor(pct) : 'text-text-dim'}`}>
        {value === null ? '—' : fmtPct(pct)}
      </span>
    </span>
  );
}

interface TickerEntry {
  key: string;
  kind: 'asset' | 'macro';
  symbol: string;
  asset?: Asset;
}

export function TickerTape() {
  const { data: assetsData } = useQuery<AssetsResponse>({
    queryKey: ['ticker-assets'],
    queryFn: () => api.get<AssetsResponse>('/api/assets'),
    staleTime: 300_000,
  });

  const allAssets = assetsData?.assets ?? [];

  // Build an ordered list: 7 crypto, then 5 macro. Each crypto slot
  // resolves to a matching asset row (if any); macro slots are always
  // indicator queries (with graceful fallback inside the component).
  const entries: TickerEntry[] = useMemo(() => {
    const out: TickerEntry[] = [];
    for (const sym of CRYPTO_SYMBOLS) {
      const match = allAssets.find((a) => a.symbol === sym);
      if (match) {
        out.push({ key: `asset-${match.id}`, kind: 'asset', symbol: sym, asset: match });
      } else {
        out.push({ key: `macro-${sym}`, kind: 'macro', symbol: sym });
      }
    }
    for (const sym of MACRO_SYMBOLS) {
      const match = allAssets.find((a) => a.symbol === sym);
      if (match) {
        out.push({ key: `asset-${match.id}`, kind: 'asset', symbol: sym, asset: match });
      } else {
        out.push({ key: `macro-${sym}`, kind: 'macro', symbol: sym });
      }
    }
    return out;
  }, [allAssets]);

  const subscribedIds = useMemo(
    () =>
      entries
        .filter((e) => e.kind === 'asset' && e.asset)
        .map((e) => e.asset!.id),
    [entries],
  );

  // Live price map fed by SSE trade_tick events.
  const [priceMap, setPriceMap] = useState<PriceMap>({});
  const { lastEvent } = useEventStream(['trade_tick'], { assetIds: subscribedIds });

  useEffect(() => {
    if (!lastEvent) return;
    const evt = lastEvent as TradeTickEvent;
    if (evt.kind !== 'trade_tick') return;
    if (typeof evt.assetId !== 'number' || typeof evt.price !== 'number') return;
    setPriceMap((prev) => {
      if (prev[evt.assetId] === evt.price) return prev;
      return { ...prev, [evt.assetId]: evt.price };
    });
  }, [lastEvent]);

  const row = (
    <>
      {entries.map((e) => {
        if (e.kind === 'asset' && e.asset) {
          return (
            <AssetTickerItem
              key={e.key}
              asset={e.asset}
              livePrice={priceMap[e.asset.id]}
            />
          );
        }
        return <MacroIndicatorItem key={e.key} symbol={e.symbol} />;
      })}
    </>
  );

  // If we truly have zero entries (API returned nothing yet), show a
  // placeholder; we still render the scroller so the layout doesn't jump.
  const isEmpty = entries.length === 0;

  return (
    <div className="relative overflow-hidden border-y-2 border-border-dim bg-bg-terminal h-10">
      <style
        dangerouslySetInnerHTML={{
          __html: `@keyframes ticker-scroll { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }`,
        }}
      />
      {isEmpty ? (
        <div className="flex items-center h-full px-3">
          <span className="pixel-font text-[10px] text-text-dim">
            LIVE TICKER — DATA WARMING UP
          </span>
        </div>
      ) : (
        <div
          className="absolute top-0 left-0 flex gap-8 items-center h-full px-3 animate-[ticker-scroll_60s_linear_infinite] hover:[animation-play-state:paused]"
        >
          {row}
          {row}
        </div>
      )}
    </div>
  );
}

export default TickerTape;
