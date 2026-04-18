import type { AssetId } from './assets.js';

export type ProbabilityHorizon = '1h' | '4h' | '24h';

export type SignalName =
  | 'fear_greed_level'
  | 'fear_greed_delta'
  | 'dxy_trend'
  | 'vix_level'
  | 'funding_rate'
  | 'open_interest_delta'
  | 'btc_dominance_trend'
  | 'whale_netflow_to_exchanges'
  | 'news_sentiment_aggregate'
  | 'price_momentum_1h'
  | 'price_momentum_24h';

export interface SignalReading {
  name: SignalName;
  valueNormalized: number; // -1..+1 where +1 = bullish
  weight: number;
  rawValue: unknown;
  asOf: number; // unix seconds
}

export interface ProbabilityScore {
  assetId: AssetId;
  horizon: ProbabilityHorizon;
  bullishProb: number;      // 0..1
  confidence: number;       // 0..1
  contributingSignals: SignalReading[];
  computedAt: number;
}

export type ProbabilityWeights = Record<SignalName, number>;
