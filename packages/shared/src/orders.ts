import type { AssetId } from './assets.js';

export type BrokerName = 'paper' | 'ccxt' | 'alpaca';
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
