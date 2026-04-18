import type { AssetId, Timeframe } from './assets.js';

export type BaseEvent = {
  id: number;
  ts: number;                 // unix seconds UTC
  source: string;
  severity?: number;          // 0..100
};

export type PriceCandleEvent = BaseEvent & {
  kind: 'candle';
  assetId: AssetId;
  timeframe: Timeframe;
  o: number; h: number; l: number; c: number; v: number;
};

export type WhaleTxEvent = BaseEvent & {
  kind: 'whale_tx';
  chain: 'eth' | 'sol' | 'btc';
  address: string;
  direction: 'in' | 'out';
  token: string;
  amount: number;
  usdValue: number;
  counterpart?: string;
  txHash: string;
  label?: string;
};

export type NewsEvent = BaseEvent & {
  kind: 'news';
  title: string;
  url: string;
  summary?: string;
  tickers: string[];
  sentiment?: number;         // -1..+1
};

export type IndicatorEvent = BaseEvent & {
  kind: 'indicator';
  name: string;
  value: number;
  previous?: number;
  delta?: number;
};

export type AlertEvent = BaseEvent & {
  kind: 'alert';
  ruleId: number;
  ruleName: string;
  payload: unknown;
};

export type Event = PriceCandleEvent | WhaleTxEvent | NewsEvent | IndicatorEvent | AlertEvent;

export type EventKind = Event['kind'];
