/**
 * MarketDataProvider — Northstar's market-data seam.
 *
 * The X strategy consumes prices ONLY through this interface. There is exactly
 * one price vendor integration in Northstar (Tiingo); this bot does not add a
 * second one. Alpaca is a broker here, not a data source.
 *
 * Staleness is a first-class concept: every quote carries its age, because the
 * risk engine refuses to trade on stale marks.
 */
import type { MarketCalendarStatus, PriceBar, Quote } from '../../domain/types.js';

export class MarketDataError extends Error {
  constructor(
    message: string,
    readonly kind: 'AUTH' | 'RATE_LIMIT' | 'NETWORK' | 'NOT_FOUND' | 'BAD_RESPONSE' | 'UNAVAILABLE',
  ) {
    super(message);
    this.name = 'MarketDataError';
  }
}

export interface MarketDataProvider {
  readonly providerId: string;
  healthCheck(): Promise<{ healthy: boolean; detail: string }>;
  /** Latest price for a ticker, with staleness computed against the Clock. */
  getQuote(ticker: string): Promise<Quote>;
  getQuotes(tickers: string[]): Promise<Map<string, Quote>>;
  /** Daily bars, inclusive of both ends where data exists. */
  getDailyBars(ticker: string, fromIso: string, toIso: string): Promise<PriceBar[]>;
  /** Intraday bars where the vendor plan supports them; may return []. */
  getIntradayBars(ticker: string, fromIso: string, toIso: string, minutes: number): Promise<PriceBar[]>;
  /** Whether the US equity market is open right now. */
  getMarketStatus(): Promise<MarketCalendarStatus>;
}
