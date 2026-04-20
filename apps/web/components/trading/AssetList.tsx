'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useEventStream } from '@/lib/sse';
import { useTradingStore, type AssetType } from '@/lib/store';

type ServerAssetKind = 'crypto' | 'stock' | 'etf' | 'forex' | 'commodity' | 'index';

interface Asset {
  id: number;
  symbol: string;
  displayName: string;
  type: ServerAssetKind;
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

// Maps server-side asset kind to our 4 top-level frontend categories.
// Commodity symbols XAU/XAG are "metals", everything else commodity is "commodities".
// Stocks and ETFs are grouped under "stocks". Crypto → crypto.
// forex/index are hidden from the workspace list (return null).
function toAssetType(a: Asset): AssetType | null {
  if (a.type === 'crypto') return 'crypto';
  if (a.type === 'stock' || a.type === 'etf') return 'stocks';
  if (a.type === 'commodity') {
    const s = a.symbol.toUpperCase();
    if (s.startsWith('XAU') || s.startsWith('XAG')) return 'metals';
    return 'commodities';
  }
  return null;
}

const TYPE_BADGE: Record<AssetType, string> = {
  crypto: 'C',
  stocks: 'S',
  metals: 'M',
  commodities: 'O',
};

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

interface NormalizedAsset {
  id: number;
  symbol: string;
  displayName: string;
  type: AssetType;
}

interface AssetRowProps {
  asset: NormalizedAsset;
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
    ? 'grid grid-cols-[20px_1fr_auto] items-center gap-2 px-3 py-2 cursor-pointer border-l-2 border-neon-cyan bg-bg-elevated w-full text-left'
    : 'grid grid-cols-[20px_1fr_auto] items-center gap-2 px-3 py-2 cursor-pointer border-l-2 border-transparent hover:border-neon-cyan hover:bg-bg-elevated w-full text-left';

  return (
    <button type="button" onClick={onSelect} className={rowCls}>
      <span className="pixel-font text-[9px] text-text-dim border border-border-dim w-5 h-5 flex items-center justify-center leading-none">
        {TYPE_BADGE[asset.type]}
      </span>
      <span className="flex flex-col min-w-0">
        <span className="pixel-font text-[10px] text-text-primary truncate">
          {asset.symbol}
        </span>
        <span className="vt-font text-[13px] text-text-secondary truncate leading-tight">
          {asset.displayName}
        </span>
      </span>
      <span className="flex flex-col items-end">
        <span className="vt-font text-[14px] text-text-primary tabular-nums">{priceStr}</span>
        <span className={`vt-font text-[12px] leading-tight tabular-nums ${changeColor}`}>{changeStr}</span>
      </span>
    </button>
  );
}

const TYPE_PILLS: ReadonlyArray<{ value: AssetType | 'all'; label: string }> = [
  { value: 'all',         label: 'ALL' },
  { value: 'crypto',      label: 'CRYPTO' },
  { value: 'stocks',      label: 'STOCKS' },
  { value: 'metals',      label: 'METALS' },
  { value: 'commodities', label: 'COMMOD' },
];

export function AssetList() {
  const typeFilter = useTradingStore((s) => s.typeFilter);
  const setTypeFilter = useTradingStore((s) => s.setTypeFilter);
  const search = useTradingStore((s) => s.search);
  const setSearch = useTradingStore((s) => s.setSearch);
  const selectedAsset = useTradingStore((s) => s.selectedAsset);
  const setSelectedAsset = useTradingStore((s) => s.setSelectedAsset);

  const { data: assetsData } = useQuery<AssetsResponse>({
    queryKey: ['assets-all'],
    queryFn: () => api.get<AssetsResponse>('/api/assets'),
    staleTime: 300_000,
  });

  const normalized = useMemo<NormalizedAsset[]>(() => {
    const raw = assetsData?.assets ?? [];
    const out: NormalizedAsset[] = [];
    for (const a of raw) {
      if (a.enabled === false) continue;
      const t = toAssetType(a);
      if (!t) continue;
      out.push({ id: a.id, symbol: a.symbol, displayName: a.displayName, type: t });
    }
    return out;
  }, [assetsData]);

  const filtered = useMemo<NormalizedAsset[]>(() => {
    const s = search.trim().toLowerCase();
    return normalized.filter((a) => {
      if (typeFilter !== 'all' && a.type !== typeFilter) return false;
      if (!s) return true;
      return (
        a.symbol.toLowerCase().includes(s) ||
        a.displayName.toLowerCase().includes(s)
      );
    });
  }, [normalized, typeFilter, search]);

  const assetIds = useMemo(() => filtered.map((a) => a.id), [filtered]);

  const { lastEvent } = useEventStream(['trade_tick'], { assetIds });

  const [lastPrices, setLastPrices] = useState<Record<number, number>>({});

  useEffect(() => {
    if (!isTradeTick(lastEvent)) return;
    const { assetId, price } = lastEvent;
    setLastPrices((prev) => ({ ...prev, [assetId]: price }));
  }, [lastEvent]);

  const pillCls = (active: boolean) =>
    active
      ? 'pixel-font text-[8px] px-1.5 py-1 border border-neon-cyan text-neon-cyan glow flex-1 text-center'
      : 'pixel-font text-[8px] px-1.5 py-1 border border-border-dim text-text-dim hover:border-neon-cyan hover:text-neon-cyan flex-1 text-center';

  return (
    <div className="flex flex-col border border-border-dim bg-bg-terminal h-full">
      <div className="p-2 border-b border-border-dim shrink-0 flex flex-col gap-2">
        <div className="flex gap-1">
          {TYPE_PILLS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setTypeFilter(p.value)}
              className={pillCls(typeFilter === p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search…"
          className="w-full px-2 py-1 bg-bg-void border border-border-dim text-text-primary vt-font text-sm focus:outline-none focus:border-neon-cyan"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        {filtered.length === 0 ? (
          <div className="vt-font text-text-dim text-sm px-3 py-2">
            {assetsData ? 'NO MATCHES' : 'LOADING…'}
          </div>
        ) : (
          filtered.map((a) => (
            <AssetRow
              key={a.id}
              asset={a}
              livePrice={lastPrices[a.id]}
              active={selectedAsset?.id === a.id}
              onSelect={() =>
                setSelectedAsset({
                  id: a.id,
                  symbol: a.symbol,
                  displayName: a.displayName,
                  type: a.type,
                })
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

export default AssetList;
