'use client';

import { create } from 'zustand';

// ---------- Placeholder stores (future phases expand) ----------
export const usePriceStore     = create<Record<string, never>>(() => ({}));
export const useWhaleStore     = create<Record<string, never>>(() => ({}));
export const useNewsStore      = create<Record<string, never>>(() => ({}));
export const useIndicatorStore = create<Record<string, never>>(() => ({}));
export const useAlertStore     = create<Record<string, never>>(() => ({}));

// ---------- Active asset per trading sub-tab ----------
export type TradingType = 'crypto' | 'metals' | 'commodities' | 'stocks';

interface TradingState {
  activeAsset: Record<TradingType, number | null>;
  setActiveAsset: (t: TradingType, id: number | null) => void;
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
}));
