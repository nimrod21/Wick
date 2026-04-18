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

export type TradeTickEvent = BaseEvent & {
  kind: 'trade_tick';
  assetId: AssetId;
  price: number;
  qty: number;
  side: 'buy' | 'sell';
};

export type OrderbookLevel = [price: number, qty: number];

export type OrderbookEvent = BaseEvent & {
  kind: 'orderbook';
  assetId: AssetId;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
};

export type ProbabilityEvent = BaseEvent & {
  kind: 'probability';
  assetId: AssetId;
  horizon: '1h' | '4h' | '24h';
  bullishProb: number;
  confidence: number;
  // contributingSignals omitted from streamed event for size; re-fetch via API if needed
};

export type Event =
  | PriceCandleEvent
  | WhaleTxEvent
  | NewsEvent
  | IndicatorEvent
  | AlertEvent
  | TradeTickEvent
  | OrderbookEvent
  | ProbabilityEvent;

export type EventKind = Event['kind'];
