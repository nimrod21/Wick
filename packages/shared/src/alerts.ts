import type { AssetId } from './assets.js';
import type { ProbabilityHorizon } from './probability.js';

export type AlertChannel = 'browser' | 'telegram';

export type AlertCondition =
  | { type: 'price_move'; assetId: AssetId; pctChange: number; windowSeconds: number; direction: 'up' | 'down' | 'either' }
  | { type: 'price_level'; assetId: AssetId; operator: '>' | '<' | '>=' | '<='; value: number }
  | { type: 'whale_tx'; chain?: 'eth' | 'sol' | 'btc'; minUsd: number; direction?: 'in' | 'out' | 'either'; addressFilter?: string[] }
  | { type: 'news'; keywordsAny?: string[]; keywordsAll?: string[]; tickers?: string[]; minSentimentAbs?: number }
  | { type: 'indicator_level'; name: string; operator: '>' | '<'; value: number }
  | { type: 'indicator_cross'; name: string; direction: 'up' | 'down'; threshold: number }
  | { type: 'probability'; assetId: AssetId; horizon: ProbabilityHorizon; operator: '>' | '<'; value: number };

export interface AlertRule {
  id: number;
  name: string;
  enabled: boolean;
  condition: AlertCondition;
  channels: AlertChannel[];
  cooldownSeconds: number;
  lastFiredTs: number | null;
  createdAt: number;
}

export interface AlertFiring {
  id: number;
  ruleId: number;
  ts: number;
  payload: unknown;
  delivered: Partial<Record<AlertChannel, 'ok' | 'failed'>> | null;
}
