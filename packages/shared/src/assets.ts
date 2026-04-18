export type AssetId = number;

export type AssetType = 'crypto' | 'stock' | 'etf' | 'forex' | 'commodity' | 'index';

export type Timeframe = '1m' | '3m' | '15m' | '1h' | '4h' | '1d' | '1w';

export const ALL_TIMEFRAMES: readonly Timeframe[] = ['1m', '3m', '15m', '1h', '4h', '1d', '1w'] as const;

export interface Asset {
  id: AssetId;
  symbol: string;
  displayName: string;
  type: AssetType;
  exchange: string | null;
  tradeableVia: 'ccxt' | 'alpaca' | null;
  tradeableSymbol: string | null;
  metadata: Record<string, unknown> | null;
  enabled: boolean;
  createdAt: number;
}
