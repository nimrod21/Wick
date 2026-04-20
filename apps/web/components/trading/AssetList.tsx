'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useEventStream } from '@/lib/sse';
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

interface TradeTickStreamEvent {
  kind: 'trade_tick';
  assetId: number;
  price: number;
}

function isTradeTick(ev: unknown): ev is TradeTickStreamEvent {
  if (!ev || typeof ev !== 'object') return false;
  const e = ev as Record<string, unknown>;
  return (
    e.kind === 'trade_tick' &&
    typeof e.assetId === 'number' &&
    typeof e.price === 'number'
  );
}

function pickDecimals(n: number): number {
  const abs = Math.abs(n);
  if (abs >= 1000) return 2;
  if (abs >= 1) return 2;
  return 4;
}

function formatPrice(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  return n.toFixed(pickDecimals(n));
}

interface AssetRowProps {
  asset: Asset;
  livePrice: number | undefined;
  active: boolean;
  onSelect: () => void;
}

function AssetRow({ asset, livePrice, active, onSelect }: AssetRowProps) {
  const { data } = useQuery<CandlesResponse>({
    queryKey: ['asset-list-24h', asset.id],
    queryFn: () =>
      api.get<CandlesResponse>(
        `/api/candles?assetId=${asset.id}&timeframe=1h&limit=24`,
      ),
    staleTime: 60_000,
  });

  const closeAt24hAgo = data?.candles?.[0]?.open ?? null;

  let changeStr = '—';
  let changeColor = 'text-text-dim';
  if (
    livePrice !== undefined &&
    Number.isFinite(livePrice) &&
    closeAt24hAgo !== null &&
    Number.isFinite(closeAt24hAgo) &&
    closeAt24hAgo !== 0
  ) {
    const pct = ((livePrice - closeAt24hAgo) / closeAt24hAgo) * 100;
    const sign = pct >= 0 ? '+' : '';
    changeStr = `${sign}${pct.toFixed(2)}%`;
    changeColor = pct >= 0 ? 'text-neon-green' : 'text-neon-red';
  }

  const priceStr = formatPrice(livePrice);

  const rowCls = active
    ? 'px-2 py-1 cursor-pointer border-l-2 border-neon-cyan bg-bg-elevated flex items-center justify-between gap-2'
    : 'px-2 py-1 cursor-pointer border-l-2 border-transparent hover:border-neon-cyan hover:bg-bg-elevated flex items-center justify-between gap-2';

  return (
    <button type="button" onClick={onSelect} className={rowCls}>
      <span className="flex flex-col items-start min-w-0">
        <span className="pixel-font text-[10px] text-text-primary truncate">
          {asset.symbol}
        </span>
        <span className="vt-font text-[14px] text-text-secondary truncate">
          {asset.displayName}
        </span>
      </span>
      <span className="flex flex-col items-end min-w-0">
        <span className="vt-font text-[14px] text-text-primary">{priceStr}</span>
        <span className={`vt-font text-[12px] ${changeColor}`}>{changeStr}</span>
      </span>
    </button>
  );
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

  const assetIds = useMemo(() => assets.map((a) => a.id), [assets]);

  const { lastEvent } = useEventStream(['trade_tick'], { assetIds });

  const [lastPrices, setLastPrices] = useState<Record<number, number>>({});

  useEffect(() => {
    if (!isTradeTick(lastEvent)) return;
    const { assetId, price } = lastEvent;
    setLastPrices((prev) => ({ ...prev, [assetId]: price }));
  }, [lastEvent]);

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
        assets.map((a) => (
          <AssetRow
            key={a.id}
            asset={a}
            livePrice={lastPrices[a.id]}
            active={a.id === activeId}
            onSelect={() =>
              setSelectedAsset(tradingType, {
                id: a.id,
                symbol: a.symbol,
                displayName: a.displayName,
              })
            }
          />
        ))
      )}
    </div>
  );
}

export default AssetList;
