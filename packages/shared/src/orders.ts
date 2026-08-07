import type { AssetId } from './assets.js';

// Phase 2 rewires this — paper is the only broker in Wick (no live execution).
export type BrokerName = 'paper';
export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';
export type OrderStatus =
  | 'pending'
  | 'submitted'
  | 'partial'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'expired';

export interface PlaceOrderRequest {
  assetId: AssetId;
  side: OrderSide;
  type: OrderType;
  qty: number;
  limitPrice?: number;
  stopPrice?: number;
  confirmed: boolean; // frontend confirmation modal sets this
  /**
   * Set by the frontend when the user has confirmed the first live-mode
   * order for a given asset in the current session. The server tracks
   * per-asset confirmation in memory (resets on restart) and will reject
   * the first order for an unconfirmed asset unless this flag is true.
   */
  firstPerAssetConfirmed?: boolean;
}

export interface Order {
  id: number;
  clientOrderId: string;
  broker: BrokerName;
  assetId: AssetId;
  side: OrderSide;
  type: OrderType;
  qty: number;
  limitPrice: number | null;
  stopPrice: number | null;
  status: OrderStatus;
  avgFillPrice: number | null;
  filledQty: number;
  submittedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  brokerOrderId: string | null;
  error: string | null;
}

export interface Position {
  id: number;
  broker: BrokerName;
  assetId: AssetId;
  qty: number;
  avgEntryPrice: number;
  realizedPnl: number;
  updatedAt: number;
}

export interface AccountBalance {
  broker: BrokerName;
  cash: number;
  equity: number;
  buyingPower: number;
  currency: string;
}

export interface Broker {
  placeOrder(req: PlaceOrderRequest): Promise<Order>;
  cancelOrder(clientOrderId: string): Promise<void>;
  getOrder(clientOrderId: string): Promise<Order>;
  listOpenOrders(): Promise<Order[]>;
  getPositions(): Promise<Position[]>;
  getAccountBalance(): Promise<AccountBalance>;
}
