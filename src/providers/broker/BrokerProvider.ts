/**
 * BrokerProvider — the only route to a broker.
 *
 * Strategy code never calls Alpaca HTTP endpoints. It builds a TradeProposal,
 * the risk engine rules on it, and the OrderRouter (the sole caller of this
 * interface) submits it. Swapping brokers means writing another implementation.
 */
import type { Cents } from '../../core/index.js';
import type { TradingMode } from '../../domain/types.js';

export interface BrokerOrderRequest {
  /** Idempotency key. Re-submitting the same key must not create a 2nd order. */
  clientOrderId: string;
  ticker: string;
  side: 'BUY' | 'SELL';
  /** Exactly one of quantity or notionalCents. */
  quantity?: number;
  notionalCents?: Cents;
  type: 'MARKET';
  timeInForce: 'DAY';
}

export interface BrokerOrder {
  brokerOrderId: string;
  clientOrderId: string;
  ticker: string;
  side: 'BUY' | 'SELL';
  status: 'NEW' | 'PENDING' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED';
  submittedQuantity: number | null;
  submittedNotionalCents: Cents | null;
  filledQuantity: number;
  filledAvgPrice: number | null;
  submittedAt: string;
  updatedAt: string;
  rejectReason: string | null;
}

export interface BrokerPosition {
  ticker: string;
  quantity: number;
  averageEntryPrice: number;
  marketValue: number;
}

export interface BrokerAccount {
  accountId: string;
  /** Whole-account figures. NEVER treat these as the strategy's capital. */
  equity: number;
  cash: number;
  buyingPower: number;
  tradingBlocked: boolean;
  patternDayTrader: boolean;
  mode: TradingMode;
}

export interface BrokerAsset {
  ticker: string;
  tradable: boolean;
  fractionable: boolean;
  exchange: string;
  name: string;
}

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly kind:
      | 'AUTH'
      | 'RATE_LIMIT'
      | 'NETWORK'
      | 'REJECTED'
      | 'INSUFFICIENT_FUNDS'
      | 'MARKET_CLOSED'
      | 'NOT_FOUND'
      | 'DUPLICATE'
      | 'BAD_RESPONSE'
      | 'UNAVAILABLE',
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}

export interface BrokerProvider {
  readonly brokerId: string;
  readonly mode: TradingMode;
  healthCheck(): Promise<{ healthy: boolean; detail: string }>;
  getAccount(): Promise<BrokerAccount>;
  getAsset(ticker: string): Promise<BrokerAsset | null>;
  listTradableAssets(): Promise<BrokerAsset[]>;
  submitOrder(req: BrokerOrderRequest): Promise<BrokerOrder>;
  getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null>;
  getOrder(brokerOrderId: string): Promise<BrokerOrder | null>;
  cancelOrder(brokerOrderId: string): Promise<void>;
  listOpenOrders(): Promise<BrokerOrder[]>;
  listPositions(): Promise<BrokerPosition[]>;
  isMarketOpen(): Promise<boolean>;
}
