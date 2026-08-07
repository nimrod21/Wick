import type { AssetId, Timeframe } from './assets.js';
import type { OrderStatus } from './orders.js';

export type Vote = 'bull' | 'bear' | 'neutral';

export type BaseEvent = {
  id: number;
  ts: number;                 // UTC unix milliseconds
  source: string;
  severity?: number;          // 0..100
};

/** Live trade tick (from Binance @trade stream). Not persisted. */
export type TickEvent = BaseEvent & {
  kind: 'tick';
  symbol: string;
  price: number;
  qty: number;
  side: 'buy' | 'sell';
};

/**
 * Candle event. `closed: true` means the kline is final and has been
 * persisted to the `candles` table; `closed: false` is a forming candle
 * (UI updates only — never persisted, never used for indicators).
 * `ts` is the candle OPEN time (ms).
 */
export type CandleEvent = BaseEvent & {
  kind: 'candle';
  symbol: string;
  tf: Timeframe;
  o: number; h: number; l: number; c: number; v: number;
  closed: boolean;
};

/** Computed indicator row (mirrors `indicator_values`). vote null = no directional read (e.g. ATR). */
export type IndicatorEvent = BaseEvent & {
  kind: 'indicator';
  symbol: string;
  tf: Timeframe;
  name: string;
  value: number | null;
  vote: Vote | null;
};

/** Funding-rate poll result (fapi.binance.com premiumIndex). rate is a fraction (0.0001 = 0.01%). */
export type FundingEvent = BaseEvent & {
  kind: 'funding';
  symbol: string;
  rate: number;
  nextFundingTime: number;
};

/** Fear & Greed index poll result (alternative.me). */
export type FearGreedEvent = BaseEvent & {
  kind: 'fear_greed';
  value: number;
  classification: string;
};

/** Fired once per boot when historical backfill completes (PLAN §16.9). */
export type MarketWarmEvent = BaseEvent & {
  kind: 'market_warm';
};

export type OrderStatusEvent = BaseEvent & {
  kind: 'order_status';
  orderId: number;
  clientOrderId: string;
  assetId: AssetId;
  status: OrderStatus;
  filledQty: number;
  avgFillPrice: number | null;
};

export type Event =
  | TickEvent
  | CandleEvent
  | IndicatorEvent
  | FundingEvent
  | FearGreedEvent
  | MarketWarmEvent
  | OrderStatusEvent;

export type EventKind = Event['kind'];

export const VALID_EVENT_KINDS: readonly EventKind[] = [
  'tick',
  'candle',
  'indicator',
  'funding',
  'fear_greed',
  'market_warm',
  'order_status',
];
