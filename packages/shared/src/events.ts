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

/**
 * Paper-engine fill (mirrors a `fills` row). reason: 'trade' for
 * LLM/CLI-driven fills, 'sl'|'tp' when the code protector fired.
 */
export type FillEvent = BaseEvent & {
  kind: 'fill';
  botId: number;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  price: number;          // executed price incl. slippage
  fee: number;            // USD
  slip: number;           // USD
  notional: number;       // qty × mid (pre-slip), USD
  reason: 'trade' | 'sl' | 'tp';
  decisionId: number | null;
};

/**
 * A bot decision was recorded (mirrors a `decisions` row; Phase 4).
 * `status`: 'executed' (incl. plain waits) | 'vetoed' | 'llm_failed'.
 */
export type DecisionEvent = BaseEvent & {
  kind: 'decision';
  decisionId: number;
  botId: number;
  action: 'buy' | 'sell' | 'wait';
  symbol: string | null;
  sizePct: number | null;
  confidence: number | null;
  status: 'executed' | 'vetoed' | 'llm_failed';
  triggerType: string;
  triggerDetail: string | null;
  provider: string | null;
  model: string | null;
  latencyMs: number | null;
  vetoReason: string | null;
  reasoning: string | null;
};

/**
 * Trigger-engine evaluation that matched its condition (Phase 4, PLAN §9).
 * `fired: false` means it matched but was gated (cooldown / budget / bot
 * floor) — the UI shows those dimmed. Mirrors a `trigger_log` row.
 */
export type TriggerEvent = BaseEvent & {
  kind: 'trigger';
  botId: number | null;
  type: string;              // 'rsi_cross' | 'scheduled' | ...
  priority: 1 | 2 | 3;
  symbol: string | null;
  detail: string;
  fired: boolean;
  gateReason: string | null; // why fired=false
};

/** Bot lifecycle change (running/stopped/busted/reset). */
export type BotStatusEvent = BaseEvent & {
  kind: 'bot_status';
  botId: number;
  status: 'running' | 'stopped' | 'busted';
  reason: string;
  equity: number | null;
};

export type Event =
  | TickEvent
  | CandleEvent
  | IndicatorEvent
  | FundingEvent
  | FearGreedEvent
  | MarketWarmEvent
  | FillEvent
  | OrderStatusEvent
  | DecisionEvent
  | TriggerEvent
  | BotStatusEvent;

export type EventKind = Event['kind'];

export const VALID_EVENT_KINDS: readonly EventKind[] = [
  'tick',
  'candle',
  'indicator',
  'funding',
  'fear_greed',
  'market_warm',
  'fill',
  'order_status',
  'decision',
  'trigger',
  'bot_status',
];
