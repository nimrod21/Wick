export type AssetId = number;

export type AssetType = 'crypto';

export type Timeframe = '1m' | '3m' | '15m' | '1h' | '4h' | '1d' | '1w';

export const ALL_TIMEFRAMES: readonly Timeframe[] = ['1m', '3m', '15m', '1h', '4h', '1d', '1w'] as const;

/** Watchlist entry — mirrors the `assets` table (symbol PK). */
export interface Asset {
  symbol: string;
  displayName: string;
  active: boolean;
  addedTs: number;
}
