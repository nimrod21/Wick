import type { AssetId, Timeframe } from './assets.js';
import type { OrderStatus } from './orders.js';

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

export type IndicatorEvent = BaseEvent & {
  kind: 'indicator';
  name: string;
  value: number;
  previous?: number;
  delta?: number;
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
  | PriceCandleEvent
  | IndicatorEvent
  | TradeTickEvent
  | OrderbookEvent
  | OrderStatusEvent;

export type EventKind = Event['kind'];

export const VALID_EVENT_KINDS: readonly EventKind[] = [
  'candle',
  'indicator',
  'trade_tick',
  'orderbook',
  'order_status',
];
