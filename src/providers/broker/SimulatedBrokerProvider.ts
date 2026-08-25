/**
 * SimulatedBrokerProvider — an in-process broker for tests and offline paper
 * runs.
 *
 * It implements the full BrokerProvider contract, including the failure modes
 * the system must survive: rejections, partial fills, market closed,
 * insufficient funds, auth failure, rate limiting and duplicate client order
 * ids. Nothing about the calling code changes between this and Alpaca.
 */
import type { Clock } from '../../core/index.js';
import { centsToDollars, randomId } from '../../core/index.js';
import type { TradingMode } from '../../domain/types.js';
import type { MarketDataProvider } from '../marketdata/MarketDataProvider.js';
import type {
  BrokerAccount,
  BrokerAsset,
  BrokerOrder,
  BrokerOrderRequest,
  BrokerPosition,
  BrokerProvider,
} from './BrokerProvider.js';
import { BrokerError } from './BrokerProvider.js';

export interface SimulatedBrokerOptions {
  clock: Clock;
  marketData: MarketDataProvider;
  mode?: TradingMode;
  accountEquity?: number;
  accountCash?: number;
  /** Tickers the simulated broker will trade. Default: anything priced. */
  tradableTickers?: string[];
  /** Fill behaviour: immediate, partial-then-complete, or never. */
  fillMode?: 'IMMEDIATE' | 'PARTIAL' | 'NEVER';
  /** Fraction filled on the first poll when fillMode is PARTIAL. */
  partialFraction?: number;
  /** Slippage applied to the market price, in basis points. */
  slippageBps?: number;
  /** Force the next submit to fail with this error. */
  failWith?: BrokerError | null;
  /** Fail only submissions, leaving reads working. */
  failSubmitsWith?: BrokerError | null;
  marketOpen?: boolean;
}

interface SimOrder extends BrokerOrder {
  requestedQuantity: number | null;
  requestedNotionalCents: number | null;
  pollCount: number;
}

export class SimulatedBrokerProvider implements BrokerProvider {
  readonly brokerId = 'simulated';
  readonly mode: TradingMode;

  private readonly clock: Clock;
  private readonly marketData: MarketDataProvider;
  private readonly orders = new Map<string, SimOrder>();
  private readonly byClientId = new Map<string, string>();
  private readonly positions = new Map<string, BrokerPosition>();

  private accountEquity: number;
  private accountCash: number;
  private tradableTickers: Set<string> | null;
  fillMode: 'IMMEDIATE' | 'PARTIAL' | 'NEVER';
  private partialFraction: number;
  private slippageBps: number;
  private failWith: BrokerError | null;
  private failSubmitsWith: BrokerError | null;
  private marketOpen: boolean;

  /** Instrumentation for tests: how many submissions actually reached here. */
  submitCount = 0;

  constructor(opts: SimulatedBrokerOptions) {
    this.clock = opts.clock;
    this.marketData = opts.marketData;
    this.mode = opts.mode ?? 'PAPER';
    this.accountEquity = opts.accountEquity ?? 100_000;
    this.accountCash = opts.accountCash ?? 100_000;
    this.tradableTickers = opts.tradableTickers ? new Set(opts.tradableTickers.map((t) => t.toUpperCase())) : null;
    this.fillMode = opts.fillMode ?? 'IMMEDIATE';
    this.partialFraction = opts.partialFraction ?? 0.5;
    this.slippageBps = opts.slippageBps ?? 0;
    this.failWith = opts.failWith ?? null;
    this.failSubmitsWith = opts.failSubmitsWith ?? null;
    this.marketOpen = opts.marketOpen ?? true;
  }

  setFailure(error: BrokerError | null): void {
    this.failWith = error;
  }

  setSubmitFailure(error: BrokerError | null): void {
    this.failSubmitsWith = error;
  }

  setFillMode(mode: 'IMMEDIATE' | 'PARTIAL' | 'NEVER'): void {
    this.fillMode = mode;
  }

  setMarketOpen(open: boolean): void {
    this.marketOpen = open;
  }

  setSlippageBps(bps: number): void {
    this.slippageBps = bps;
  }

  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    if (this.failWith) return { healthy: false, detail: this.failWith.message };
    return { healthy: true, detail: `simulated ${this.mode} broker` };
  }

  async getAccount(): Promise<BrokerAccount> {
    this.throwIfFailing();
    return {
      accountId: 'sim-account',
      equity: this.accountEquity,
      cash: this.accountCash,
      buyingPower: this.accountCash,
      tradingBlocked: false,
      patternDayTrader: false,
      mode: this.mode,
    };
  }

  async getAsset(ticker: string): Promise<BrokerAsset | null> {
    this.throwIfFailing();
    const symbol = ticker.toUpperCase();
    if (this.tradableTickers && !this.tradableTickers.has(symbol)) return null;
    return { ticker: symbol, tradable: true, fractionable: true, exchange: 'SIM', name: symbol };
  }

  async listTradableAssets(): Promise<BrokerAsset[]> {
    this.throwIfFailing();
    const tickers = this.tradableTickers ? [...this.tradableTickers] : [];
    return tickers.map((t) => ({ ticker: t, tradable: true, fractionable: true, exchange: 'SIM', name: t }));
  }

  async submitOrder(req: BrokerOrderRequest): Promise<BrokerOrder> {
    this.throwIfFailing();
    if (this.failSubmitsWith) throw this.failSubmitsWith;

    // Idempotency: the same client order id never creates a second order.
    const existingId = this.byClientId.get(req.clientOrderId);
    if (existingId) {
      const existing = this.orders.get(existingId);
      if (existing) return { ...existing };
      throw new BrokerError('Duplicate client order id', 'DUPLICATE');
    }

    if (!this.marketOpen) throw new BrokerError('Market is closed', 'MARKET_CLOSED');

    const symbol = req.ticker.toUpperCase();
    if (this.tradableTickers && !this.tradableTickers.has(symbol)) {
      throw new BrokerError(`Asset ${symbol} is not tradable`, 'REJECTED');
    }

    const notionalDollars = req.notionalCents !== undefined ? centsToDollars(req.notionalCents) : null;
    if (req.side === 'BUY' && notionalDollars !== null && notionalDollars > this.accountCash) {
      throw new BrokerError('Insufficient buying power', 'INSUFFICIENT_FUNDS');
    }

    this.submitCount += 1;
    const now = this.clock.nowIso();
    const order: SimOrder = {
      brokerOrderId: randomId('sim'),
      clientOrderId: req.clientOrderId,
      ticker: symbol,
      side: req.side,
      status: 'NEW',
      submittedQuantity: req.quantity ?? null,
      submittedNotionalCents: req.notionalCents ?? null,
      filledQuantity: 0,
      filledAvgPrice: null,
      submittedAt: now,
      updatedAt: now,
      rejectReason: null,
      requestedQuantity: req.quantity ?? null,
      requestedNotionalCents: req.notionalCents ?? null,
      pollCount: 0,
    };
    this.orders.set(order.brokerOrderId, order);
    this.byClientId.set(req.clientOrderId, order.brokerOrderId);

    if (this.fillMode === 'IMMEDIATE') await this.progressFill(order, 1);
    return { ...order };
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrder | null> {
    this.throwIfFailing();
    const order = this.orders.get(brokerOrderId);
    if (!order) return null;
    if (order.status === 'NEW' || order.status === 'PENDING' || order.status === 'PARTIALLY_FILLED') {
      order.pollCount += 1;
      if (this.fillMode === 'PARTIAL') {
        await this.progressFill(order, order.pollCount === 1 ? this.partialFraction : 1);
      } else if (this.fillMode === 'IMMEDIATE') {
        await this.progressFill(order, 1);
      }
    }
    return { ...order };
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null> {
    const id = this.byClientId.get(clientOrderId);
    return id ? this.getOrder(id) : null;
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    this.throwIfFailing();
    const order = this.orders.get(brokerOrderId);
    if (!order) return;
    if (order.status === 'FILLED' || order.status === 'CANCELLED' || order.status === 'REJECTED') return;
    order.status = 'CANCELLED';
    order.updatedAt = this.clock.nowIso();
  }

  async listOpenOrders(): Promise<BrokerOrder[]> {
    this.throwIfFailing();
    return [...this.orders.values()]
      .filter((o) => o.status === 'NEW' || o.status === 'PENDING' || o.status === 'PARTIALLY_FILLED')
      .map((o) => ({ ...o }));
  }

  async listPositions(): Promise<BrokerPosition[]> {
    this.throwIfFailing();
    return [...this.positions.values()].map((p) => ({ ...p }));
  }

  async isMarketOpen(): Promise<boolean> {
    // A real broker outage takes the clock endpoint down with everything else.
    this.throwIfFailing();
    return this.marketOpen;
  }

  /* --------------------------------------------------------------- fills */

  private async progressFill(order: SimOrder, targetFraction: number): Promise<void> {
    const quote = await this.marketData.getQuote(order.ticker).catch(() => null);
    if (!quote) {
      order.status = 'REJECTED';
      order.rejectReason = 'No market price available';
      order.updatedAt = this.clock.nowIso();
      return;
    }

    const slip = 1 + (order.side === 'BUY' ? this.slippageBps : -this.slippageBps) / 10_000;
    const price = quote.price * slip;

    const totalQuantity =
      order.requestedQuantity ??
      (order.requestedNotionalCents !== null ? centsToDollars(order.requestedNotionalCents) / price : 0);

    const target = Number((totalQuantity * targetFraction).toFixed(6));
    const newlyFilled = Math.max(0, target - order.filledQuantity);
    if (newlyFilled <= 0) return;

    const prevNotional = (order.filledAvgPrice ?? 0) * order.filledQuantity;
    order.filledQuantity = Number((order.filledQuantity + newlyFilled).toFixed(6));
    order.filledAvgPrice = Number(((prevNotional + newlyFilled * price) / order.filledQuantity).toFixed(6));
    order.status = order.filledQuantity >= totalQuantity - 1e-9 ? 'FILLED' : 'PARTIALLY_FILLED';
    order.updatedAt = this.clock.nowIso();

    const signed = order.side === 'BUY' ? newlyFilled : -newlyFilled;
    const existing = this.positions.get(order.ticker);
    const newQuantity = Number(((existing?.quantity ?? 0) + signed).toFixed(6));
    if (Math.abs(newQuantity) < 1e-9) {
      this.positions.delete(order.ticker);
    } else {
      const prevQty = existing?.quantity ?? 0;
      const prevAvg = existing?.averageEntryPrice ?? price;
      const avg = signed > 0 ? (prevQty * prevAvg + newlyFilled * price) / newQuantity : prevAvg;
      this.positions.set(order.ticker, {
        ticker: order.ticker,
        quantity: newQuantity,
        averageEntryPrice: Number(avg.toFixed(6)),
        marketValue: Number((newQuantity * price).toFixed(2)),
      });
    }
    this.accountCash -= signed * price;
  }

  private throwIfFailing(): void {
    if (this.failWith) throw this.failWith;
  }
}
