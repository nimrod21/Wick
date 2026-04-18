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

// ---------- Trading sub-tabs + timeframes ----------
export type TradingType = 'crypto' | 'metals' | 'commodities' | 'stocks';
export type Timeframe = '1m' | '3m' | '15m' | '1h' | '4h' | '1d' | '1w';

interface TradingState {
  activeAsset: Record<TradingType, number | null>;
  setActiveAsset: (t: TradingType, id: number | null) => void;
  timeframe: Record<TradingType, Timeframe>;
  setTimeframe: (t: TradingType, tf: Timeframe) => void;
}

export const useTradingStore = create<TradingState>((set) => ({
  activeAsset: {
    crypto: null,
    metals: null,
    commodities: null,
    stocks: null,
  },
  setActiveAsset: (t, id) =>
    set((s) => ({ activeAsset: { ...s.activeAsset, [t]: id } })),
  timeframe: {
    crypto: '1h',
    metals: '1h',
    commodities: '1h',
    stocks: '1h',
  },
  setTimeframe: (t, tf) =>
    set((s) => ({ timeframe: { ...s.timeframe, [t]: tf } })),
}));
