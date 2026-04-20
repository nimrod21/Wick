'use client';

import { useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useTradingStore, type TradingType } from '@/lib/store';

type AssetKind = 'crypto' | 'stock' | 'commodity' | 'etf';

interface Asset {
  id: number;
  symbol: string;
  displayName: string;
  type: AssetKind;
  enabled: boolean;
  tradeableVia?: string;
  tradeableSymbol?: string;
}

interface AssetsResponse {
  assets: Asset[];
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

interface AssetListProps {
  tradingType: TradingType;
  assetTypes: AssetKind[];
  /**
   * Optional post-fetch filter. If provided, only assets whose symbol
   * satisfies the predicate are rendered. Used by metals/commodities tabs
   * to narrow down the `commodity` asset type to a specific pair (e.g. XAU/USD).
   */
  symbolFilter?: (symbol: string) => boolean;
}

interface PriceInfo {
  last: number | null;
  change24h: number | null;
}

function formatPrice(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

function formatPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

export function AssetList({
  tradingType,
  assetTypes,
  symbolFilter,
}: AssetListProps) {
  const [query, setQuery] = useState('');
  const activeId = useTradingStore((s) => s.activeAsset[tradingType]);
  const setSelectedAsset = useTradingStore((s) => s.setSelectedAsset);

  const assetsKey = useMemo(() => ['assets-list', ...assetTypes], [assetTypes]);

  const { data: assetsData } = useQuery({
    queryKey: assetsKey,
    queryFn: async () => {
      const results = await Promise.all(
        assetTypes.map((t) => api.get<AssetsResponse>(`/api/assets?type=${encodeURIComponent(t)}`)),
      );
      const merged: Asset[] = [];
      for (const r of results) {
        if (r && Array.isArray(r.assets)) merged.push(...r.assets);
      }
      return merged;
    },
    staleTime: 60_000,
  });

  const assets = useMemo<Asset[]>(() => {
    let list = (assetsData ?? []).filter((a) => a.enabled !== false);
    if (symbolFilter) list = list.filter((a) => symbolFilter(a.symbol));
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (a) =>
        a.symbol.toLowerCase().includes(q) ||
        a.displayName.toLowerCase().includes(q),
    );
  }, [assetsData, query, symbolFilter]);

  const priceQueries = useQueries({
    queries: assets.map((a) => ({
      queryKey: ['asset-price-24h', a.id],
      queryFn: () =>
        api.get<CandlesResponse>(
          `/api/candles?assetId=${a.id}&timeframe=1h&limit=25`,
        ),
      staleTime: 30_000,
      refetchInterval: 30_000,
    })),
  });

  const priceMap = useMemo<Record<number, PriceInfo>>(() => {
    const out: Record<number, PriceInfo> = {};
    assets.forEach((a, idx) => {
      const q = priceQueries[idx];
      const candles = q?.data?.candles ?? [];
      if (candles.length === 0) {
        out[a.id] = { last: null, change24h: null };
        return;
      }
      const last = candles[candles.length - 1]?.close ?? null;
      const ago = candles[0]?.close ?? null;
      const change =
        last !== null && ago !== null && ago !== 0
          ? ((last - ago) / ago) * 100
          : null;
      out[a.id] = { last, change24h: change };
    });
    return out;
  }, [assets, priceQueries]);

  return (
    <div className="flex flex-col gap-1 p-2 border border-border-dim bg-bg-terminal overflow-y-auto max-h-full min-h-[400px]">
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="SEARCH…"
        className="bg-bg-void border border-border-dim px-2 py-1 text-text-primary text-sm mb-2"
      />

      {assets.length === 0 ? (
        <div className="vt-font text-text-dim text-sm px-2 py-1">
          {assetsData ? 'NO MATCHES' : 'LOADING…'}
        </div>
      ) : (
        assets.map((a) => {
          const active = a.id === activeId;
          const info = priceMap[a.id] ?? { last: null, change24h: null };
          const changeColor =
            info.change24h === null
              ? 'text-text-dim'
              : info.change24h >= 0
                ? 'text-neon-green'
                : 'text-neon-red';
          const priceBase = 'vt-font text-[14px]';
          const priceColor =
            info.change24h === null
              ? 'text-text-primary'
              : Math.abs(info.change24h) >= 5
                ? 'text-neon-cyan'
                : info.change24h >= 0
                  ? 'text-neon-green'
                  : 'text-neon-red';
          const rowCls = active
            ? 'px-2 py-1 cursor-pointer border-l-2 border-neon-cyan bg-bg-elevated flex items-center justify-between gap-2'
            : 'px-2 py-1 cursor-pointer border-l-2 border-transparent hover:border-neon-cyan hover:bg-bg-elevated flex items-center justify-between gap-2';

          return (
            <button
              key={a.id}
              type="button"
              onClick={() =>
                setSelectedAsset(tradingType, {
                  id: a.id,
                  symbol: a.symbol,
                  displayName: a.displayName,
                })
              }
              className={rowCls}
            >
              <span className="flex flex-col items-start min-w-0">
                <span className="pixel-font text-[10px] text-text-primary truncate">
                  {a.symbol}
                </span>
                <span className="vt-font text-[14px] text-text-secondary truncate">
                  {a.displayName}
                </span>
              </span>
              <span className="flex flex-col items-end min-w-0">
                <span className={`${priceBase} ${priceColor}`}>
                  {formatPrice(info.last)}
                </span>
                <span className={`vt-font text-[12px] ${changeColor}`}>
                  {formatPct(info.change24h)}
                </span>
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}

export default AssetList;
