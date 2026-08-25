/**
 * FixtureMarketDataProvider — deterministic prices for tests, replay and
 * offline paper runs.
 *
 * Supports the states the risk engine has to survive: fresh quotes, stale
 * quotes, missing tickers and a closed market.
 */
import type { Clock } from '../../core/index.js';
import type { MarketCalendarStatus, PriceBar, Quote } from '../../domain/types.js';
import { marketStatus } from './marketCalendar.js';
import type { MarketDataProvider } from './MarketDataProvider.js';
import { MarketDataError } from './MarketDataProvider.js';

export interface FixtureMarketDataOptions {
  clock: Clock;
  /** ticker -> price. */
  prices?: Record<string, number>;
  /** ticker -> daily bars, oldest first. */
  bars?: Record<string, PriceBar[]>;
  staleAfterMinutes?: number;
  /** Force every quote to be this many minutes old. */
  quoteAgeMinutes?: number;
  /** Override the calendar; useful for market-closed tests. */
  forceMarketOpen?: boolean | null;
  failWith?: MarketDataError | null;
}

export class FixtureMarketDataProvider implements MarketDataProvider {
  readonly providerId = 'fixture-marketdata';

  private prices: Record<string, number>;
  private barsByTicker: Record<string, PriceBar[]>;
  private readonly clock: Clock;
  private readonly staleAfterMinutes: number;
  private quoteAgeMinutes: number;
  private forceMarketOpen: boolean | null;
  private failWith: MarketDataError | null;

  constructor(opts: FixtureMarketDataOptions) {
    this.clock = opts.clock;
    this.prices = { ...(opts.prices ?? {}) };
    this.barsByTicker = { ...(opts.bars ?? {}) };
    this.staleAfterMinutes = opts.staleAfterMinutes ?? 30;
    this.quoteAgeMinutes = opts.quoteAgeMinutes ?? 0;
    this.forceMarketOpen = opts.forceMarketOpen ?? null;
    this.failWith = opts.failWith ?? null;
  }

  setPrice(ticker: string, price: number): void {
    this.prices[ticker.toUpperCase()] = price;
  }

  setPrices(prices: Record<string, number>): void {
    for (const [t, p] of Object.entries(prices)) this.setPrice(t, p);
  }

  setQuoteAgeMinutes(minutes: number): void {
    this.quoteAgeMinutes = minutes;
  }

  setMarketOpen(open: boolean | null): void {
    this.forceMarketOpen = open;
  }

  setFailure(error: MarketDataError | null): void {
    this.failWith = error;
  }

  /** Generate a deterministic synthetic daily history ending at `price`. */
  seedHistory(ticker: string, days: number, endPrice: number, dailyDriftPct = 0, volPct = 1): void {
    const symbol = ticker.toUpperCase();
    const bars: PriceBar[] = [];
    // Walk backwards from endPrice so the final close is exactly endPrice.
    const closes: number[] = [endPrice];
    for (let i = 1; i < days; i += 1) {
      const wobble = ((i * 37) % 13) / 13 - 0.5; // deterministic pseudo-noise
      const step = (dailyDriftPct + wobble * volPct) / 100;
      const prev = closes[0]!;
      closes.unshift(prev / (1 + step));
    }
    const dayMs = 86_400_000;
    for (let i = 0; i < closes.length; i += 1) {
      const close = closes[i]!;
      const at = new Date(this.clock.nowMs() - (closes.length - 1 - i) * dayMs).toISOString();
      bars.push({
        ticker: symbol,
        at,
        open: close * 0.995,
        high: close * 1.01,
        low: close * 0.99,
        close,
        volume: 1_000_000 + ((i * 7919) % 250_000),
      });
    }
    this.barsByTicker[symbol] = bars;
    this.prices[symbol] = endPrice;
  }

  setBars(ticker: string, bars: PriceBar[]): void {
    this.barsByTicker[ticker.toUpperCase()] = bars;
    const last = bars[bars.length - 1];
    if (last) this.prices[ticker.toUpperCase()] = last.close;
  }

  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    if (this.failWith) return { healthy: false, detail: this.failWith.message };
    return { healthy: true, detail: `fixture market data, ${Object.keys(this.prices).length} tickers` };
  }

  async getQuote(ticker: string): Promise<Quote> {
    if (this.failWith) throw this.failWith;
    const symbol = ticker.toUpperCase();
    const price = this.prices[symbol];
    if (price === undefined) throw new MarketDataError(`No fixture price for ${symbol}`, 'NOT_FOUND');
    const asOf = new Date(this.clock.nowMs() - this.quoteAgeMinutes * 60_000).toISOString();
    return {
      ticker: symbol,
      price,
      asOf,
      ageMinutes: this.quoteAgeMinutes,
      stale: this.quoteAgeMinutes > this.staleAfterMinutes,
    };
  }

  async getQuotes(tickers: string[]): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    for (const t of tickers) {
      try {
        out.set(t.toUpperCase(), await this.getQuote(t));
      } catch {
        /* a missing fixture ticker is simply absent from the map */
      }
    }
    return out;
  }

  async getDailyBars(ticker: string, fromIso: string, toIso: string): Promise<PriceBar[]> {
    if (this.failWith) throw this.failWith;
    const bars = this.barsByTicker[ticker.toUpperCase()] ?? [];
    return bars.filter((b) => b.at >= fromIso && b.at <= toIso);
  }

  async getIntradayBars(ticker: string, fromIso: string, toIso: string): Promise<PriceBar[]> {
    return this.getDailyBars(ticker, fromIso, toIso);
  }

  async getMarketStatus(): Promise<MarketCalendarStatus> {
    if (this.forceMarketOpen === null) return marketStatus(this.clock);
    return {
      isOpen: this.forceMarketOpen,
      asOf: this.clock.nowIso(),
      nextOpen: null,
      nextClose: null,
      reason: this.forceMarketOpen ? 'Forced open (fixture)' : 'Forced closed (fixture)',
    };
  }
}
