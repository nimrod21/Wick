'use client';

import { create } from 'zustand';

// ---------- Placeholder stores (future phases expand) ----------
export const usePriceStore     = create<Record<string, never>>(() => ({}));
export const useWhaleStore     = create<Record<string, never>>(() => ({}));
export const useNewsStore      = create<Record<string, never>>(() => ({}));
export const useIndicatorStore = create<Record<string, never>>(() => ({}));
export const useAlertStore     = create<Record<string, never>>(() => ({}));

// ---------- Live-mode per-asset confirmation (Phase 10) ----------
// Tracks which assets the user has already confirmed for live trading
// this browser session. Reset on page reload by design.
interface LiveModeState {
  liveConfirmedAssets: Set<number>;
  confirmAsset: (assetId: number) => void;
  clearConfirmedAssets: () => void;
  isConfirmed: (assetId: number) => boolean;
}

export const useLiveModeStore = create<LiveModeState>((set, get) => ({
  liveConfirmedAssets: new Set<number>(),
  confirmAsset: (assetId) =>
    set((s) => {
      const next = new Set(s.liveConfirmedAssets);
      next.add(assetId);
      return { liveConfirmedAssets: next };
    }),
  clearConfirmedAssets: () => set({ liveConfirmedAssets: new Set<number>() }),
  isConfirmed: (assetId) => get().liveConfirmedAssets.has(assetId),
}));

// ---------- Unified trading workspace state ----------
export type AssetType = 'crypto' | 'stocks' | 'metals' | 'commodities';
export type Timeframe = '1m' | '3m' | '15m' | '1h' | '4h' | '1d' | '1w';

export type SelectedAsset = {
  id: number;
  symbol: string;
  displayName: string;
  type: AssetType;
};

interface TradingState {
  selectedAsset: SelectedAsset | null;
  setSelectedAsset: (asset: SelectedAsset | null) => void;
  timeframe: Timeframe;
  setTimeframe: (tf: Timeframe) => void;
  typeFilter: AssetType | 'all';
  setTypeFilter: (t: AssetType | 'all') => void;
  search: string;
  setSearch: (s: string) => void;
}

export const useTradingStore = create<TradingState>((set) => ({
  selectedAsset: null,
  setSelectedAsset: (asset) => set({ selectedAsset: asset }),
  timeframe: '1h',
  setTimeframe: (tf) => set({ timeframe: tf }),
  typeFilter: 'all',
  setTypeFilter: (t) => set({ typeFilter: t }),
  search: '',
  setSearch: (s) => set({ search: s }),
}));
