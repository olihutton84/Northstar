/**
 * AlpacaBrokerProvider — reusable Alpaca adapter for Northstar.
 *
 * Credential rules enforced here:
 *   - the mode is fixed at construction and cannot change afterwards
 *   - PAPER and LIVE credentials come from disjoint environment variables and
 *     are never merged (see config/env.ts)
 *   - a LIVE instance refuses to point at a paper host, and vice versa
 *   - keys are never logged, never persisted, never returned by the API layer
 */
import type { Clock, Logger } from '../../core/index.js';
import { centsToDollars } from '../../core/index.js';
import type { TradingMode } from '../../domain/types.js';
import type { AlpacaCredentials } from '../../config/env.js';
import type {
  BrokerAccount,
  BrokerAsset,
  BrokerOrder,
  BrokerOrderRequest,
  BrokerPosition,
  BrokerProvider,
} from './BrokerProvider.js';
import { BrokerError } from './BrokerProvider.js';

interface AlpacaOrderPayload {
  id: string;
  client_order_id: string;
  symbol: string;
  side: string;
  status: string;
  qty?: string | null;
  notional?: string | null;
  filled_qty?: string | null;
  filled_avg_price?: string | null;
  submitted_at?: string;
  updated_at?: string;
  failed_at?: string | null;
  canceled_at?: string | null;
  expired_at?: string | null;
}

const STATUS_MAP: Record<string, BrokerOrder['status']> = {
  new: 'NEW',
  accepted: 'NEW',
  pending_new: 'PENDING',
  accepted_for_bidding: 'PENDING',
  partially_filled: 'PARTIALLY_FILLED',
  filled: 'FILLED',
  done_for_day: 'EXPIRED',
  canceled: 'CANCELLED',
  expired: 'EXPIRED',
  replaced: 'CANCELLED',
  pending_cancel: 'PENDING',
  pending_replace: 'PENDING',
  rejected: 'REJECTED',
  suspended: 'PENDING',
  calculated: 'PENDING',
  stopped: 'PENDING',
  held: 'PENDING',
};

export interface AlpacaBrokerOptions {
  credentials: AlpacaCredentials;
  clock: Clock;
  logger: Logger;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export class AlpacaBrokerProvider implements BrokerProvider {
  readonly brokerId = 'alpaca';
  readonly mode: TradingMode;

  private readonly keyId: string;
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: AlpacaBrokerOptions) {
    const c = opts.credentials;
    if (!c.keyId || !c.secretKey) throw new Error('AlpacaBrokerProvider requires credentials.');

    const looksPaper = c.baseUrl.includes('paper-api');
    if (c.mode === 'LIVE' && looksPaper) {
      throw new Error('LIVE broker constructed against a paper endpoint — refusing to start.');
    }
    if (c.mode === 'PAPER' && !looksPaper) {
      throw new Error('PAPER broker constructed against a non-paper endpoint — refusing to start.');
    }

    this.mode = c.mode;
    this.keyId = c.keyId;
    this.secretKey = c.secretKey;
    this.baseUrl = c.baseUrl.replace(/\/$/, '');
    this.clock = opts.clock;
    this.log = opts.logger.child(`alpaca:${c.mode.toLowerCase()}`);
    this.doFetch = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.requestTimeoutMs ?? 15_000;
  }

  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    try {
      const account = await this.getAccount();
      return {
        healthy: !account.tradingBlocked,
        detail: account.tradingBlocked ? 'Alpaca account trading is blocked' : `Alpaca ${this.mode} reachable`,
      };
    } catch (e) {
      return { healthy: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async getAccount(): Promise<BrokerAccount> {
    const a = await this.request<Record<string, unknown>>('GET', '/v2/account');
    return {
      accountId: String(a['id'] ?? ''),
      equity: Number(a['equity'] ?? 0),
      cash: Number(a['cash'] ?? 0),
      buyingPower: Number(a['buying_power'] ?? 0),
      tradingBlocked: a['trading_blocked'] === true || a['account_blocked'] === true,
      patternDayTrader: a['pattern_day_trader'] === true,
      mode: this.mode,
    };
  }

  async getAsset(ticker: string): Promise<BrokerAsset | null> {
    try {
      const a = await this.request<Record<string, unknown>>('GET', `/v2/assets/${encodeURIComponent(ticker.toUpperCase())}`);
      return {
        ticker: String(a['symbol'] ?? ticker).toUpperCase(),
        tradable: a['tradable'] === true,
        fractionable: a['fractionable'] === true,
        exchange: String(a['exchange'] ?? ''),
        name: String(a['name'] ?? ''),
      };
    } catch (e) {
      if (e instanceof BrokerError && e.kind === 'NOT_FOUND') return null;
      throw e;
    }
  }

  async listTradableAssets(): Promise<BrokerAsset[]> {
    const rows = await this.request<Record<string, unknown>[]>(
      'GET',
      '/v2/assets?status=active&asset_class=us_equity',
    );
    return (rows ?? [])
      .filter((a) => a['tradable'] === true)
      .map((a) => ({
        ticker: String(a['symbol'] ?? '').toUpperCase(),
        tradable: true,
        fractionable: a['fractionable'] === true,
        exchange: String(a['exchange'] ?? ''),
        name: String(a['name'] ?? ''),
      }));
  }

  async submitOrder(req: BrokerOrderRequest): Promise<BrokerOrder> {
    if (req.quantity === undefined && req.notionalCents === undefined) {
      throw new BrokerError('Order requires either quantity or notionalCents', 'REJECTED');
    }
    if (req.quantity !== undefined && req.notionalCents !== undefined) {
      throw new BrokerError('Order must specify exactly one of quantity or notionalCents', 'REJECTED');
    }

    const body: Record<string, unknown> = {
      symbol: req.ticker.toUpperCase(),
      side: req.side.toLowerCase(),
      type: 'market',
      time_in_force: 'day',
      client_order_id: req.clientOrderId,
    };
    if (req.quantity !== undefined) body['qty'] = String(req.quantity);
    if (req.notionalCents !== undefined) body['notional'] = centsToDollars(req.notionalCents).toFixed(2);

    try {
      const order = await this.request<AlpacaOrderPayload>('POST', '/v2/orders', body);
      this.log.info('order submitted', {
        clientOrderId: req.clientOrderId,
        brokerOrderId: order.id,
        ticker: req.ticker,
        side: req.side,
      });
      return this.toBrokerOrder(order);
    } catch (e) {
      // A duplicate client_order_id means we already submitted this exact
      // order. Return the existing one rather than retrying into a double buy.
      if (e instanceof BrokerError && e.kind === 'DUPLICATE') {
        const existing = await this.getOrderByClientId(req.clientOrderId);
        if (existing) {
          this.log.warn('duplicate client order id; returning existing order', {
            clientOrderId: req.clientOrderId,
          });
          return existing;
        }
      }
      throw e;
    }
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null> {
    try {
      const o = await this.request<AlpacaOrderPayload>(
        'GET',
        `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
      );
      return this.toBrokerOrder(o);
    } catch (e) {
      if (e instanceof BrokerError && e.kind === 'NOT_FOUND') return null;
      throw e;
    }
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrder | null> {
    try {
      const o = await this.request<AlpacaOrderPayload>('GET', `/v2/orders/${encodeURIComponent(brokerOrderId)}`);
      return this.toBrokerOrder(o);
    } catch (e) {
      if (e instanceof BrokerError && e.kind === 'NOT_FOUND') return null;
      throw e;
    }
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    try {
      await this.request<void>('DELETE', `/v2/orders/${encodeURIComponent(brokerOrderId)}`);
    } catch (e) {
      // Already terminal is not a failure to cancel.
      if (e instanceof BrokerError && (e.kind === 'NOT_FOUND' || e.kind === 'REJECTED')) return;
      throw e;
    }
  }

  async listOpenOrders(): Promise<BrokerOrder[]> {
    const rows = await this.request<AlpacaOrderPayload[]>('GET', '/v2/orders?status=open&limit=200');
    return (rows ?? []).map((o) => this.toBrokerOrder(o));
  }

  async listPositions(): Promise<BrokerPosition[]> {
    const rows = await this.request<Record<string, unknown>[]>('GET', '/v2/positions');
    return (rows ?? []).map((p) => ({
      ticker: String(p['symbol'] ?? '').toUpperCase(),
      quantity: Number(p['qty'] ?? 0),
      averageEntryPrice: Number(p['avg_entry_price'] ?? 0),
      marketValue: Number(p['market_value'] ?? 0),
    }));
  }

  async isMarketOpen(): Promise<boolean> {
    const c = await this.request<Record<string, unknown>>('GET', '/v2/clock');
    return c['is_open'] === true;
  }

  private toBrokerOrder(o: AlpacaOrderPayload): BrokerOrder {
    const status = STATUS_MAP[String(o.status).toLowerCase()] ?? 'PENDING';
    return {
      brokerOrderId: String(o.id),
      clientOrderId: String(o.client_order_id ?? ''),
      ticker: String(o.symbol ?? '').toUpperCase(),
      side: String(o.side).toLowerCase() === 'sell' ? 'SELL' : 'BUY',
      status,
      submittedQuantity: o.qty === null || o.qty === undefined ? null : Number(o.qty),
      submittedNotionalCents:
        o.notional === null || o.notional === undefined ? null : Math.round(Number(o.notional) * 100),
      filledQuantity: Number(o.filled_qty ?? 0),
      filledAvgPrice: o.filled_avg_price ? Number(o.filled_avg_price) : null,
      submittedAt: o.submitted_at ? new Date(o.submitted_at).toISOString() : this.clock.nowIso(),
      updatedAt: o.updated_at ? new Date(o.updated_at).toISOString() : this.clock.nowIso(),
      rejectReason: status === 'REJECTED' ? 'Rejected by broker' : null,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'APCA-API-KEY-ID': this.keyId,
          'APCA-API-SECRET-KEY': this.secretKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (e) {
      throw new BrokerError(`Alpaca request failed: ${e instanceof Error ? e.message : String(e)}`, 'NETWORK', true);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 || res.status === 403) throw new BrokerError('Alpaca authentication failed', 'AUTH');
    if (res.status === 404) throw new BrokerError('Alpaca resource not found', 'NOT_FOUND');
    if (res.status === 429) throw new BrokerError('Alpaca rate limit exceeded', 'RATE_LIMIT', true);
    if (res.status >= 500) throw new BrokerError(`Alpaca unavailable (${res.status})`, 'UNAVAILABLE', true);

    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return undefined as T;
    }

    let payload: unknown;
    const text = await res.text();
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      if (res.ok) return undefined as T;
      throw new BrokerError(`Alpaca returned a non-JSON body (${res.status})`, 'BAD_RESPONSE');
    }

    if (!res.ok) {
      const message = String((payload as Record<string, unknown> | null)?.['message'] ?? `Alpaca returned ${res.status}`);
      const lower = message.toLowerCase();
      if (res.status === 422 && lower.includes('client_order_id')) throw new BrokerError(message, 'DUPLICATE');
      if (lower.includes('insufficient')) throw new BrokerError(message, 'INSUFFICIENT_FUNDS');
      if (lower.includes('market is closed') || lower.includes('outside of market hours')) {
        throw new BrokerError(message, 'MARKET_CLOSED');
      }
      throw new BrokerError(message, 'REJECTED');
    }

    return payload as T;
  }
}
