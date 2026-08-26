/**
 * CachingMarketDataProvider — a request-reducing decorator over the real
 * market-data provider.
 *
 * The problem it solves is specific. Price data is only ever fetched for a
 * *candidate* security (one that already survived filtering, resolution and
 * duplicate suppression), but within a single scan several candidates each ask
 * for the benchmark's history, and a security under event watch is re-scored
 * every 60 seconds. Without a cache that is one vendor request per candidate
 * per scan, for data that changes once a day.
 *
 * Two independent freshness budgets, both operational rather than strategic:
 *
 *   quoteCacheSeconds     how long a last price may be reused   (default 45s)
 *   historyRefreshMinutes how long a bar series may be reused   (default 60m)
 *
 * The one rule that must not be broken: a cached quote must never *look*
 * fresher than it is. `ageMinutes` and `stale` are recomputed from the vendor's
 * own `asOf` on every read, so a quote served from cache reports the same age
 * the risk engine would have seen had it gone to the vendor. Caching reduces
 * requests; it never launders staleness.
 *
 * `providerId` passes straight through, so the startup banner and the readiness
 * check still report the underlying vendor rather than the wrapper.
 */
import type { Clock, Logger } from '../../core/index.js';
import type { MarketCalendarStatus, PriceBar, Quote } from '../../domain/types.js';
import type { MarketDataProvider } from './MarketDataProvider.js';

interface QuoteEntry {
  quote: Quote;
  fetchedAtMs: number;
}

interface BarsEntry {
  fromDay: string;
  toDay: string;
  bars: PriceBar[];
  fetchedAtMs: number;
}

export interface MarketDataCacheStats {
  quoteHits: number;
  quoteMisses: number;
  barHits: number;
  barMisses: number;
  /** Vendor requests avoided, as a share of all lookups. */
  hitRatePct: number;
  cachedTickers: number;
}

export interface CachingMarketDataOptions {
  delegate: MarketDataProvider;
  clock: Clock;
  logger: Logger;
  quoteCacheSeconds: number;
  historyRefreshMinutes: number;
  /** Optional cap on distinct tickers held in memory. */
  maxTickers?: number;
  /** Must match the delegate's own threshold so re-aging agrees with it. */
  staleAfterMinutes?: number;
}

export class CachingMarketDataProvider implements MarketDataProvider {
  private readonly delegate: MarketDataProvider;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly quoteTtlMs: number;
  private readonly historyTtlMs: number;
  private readonly maxTickers: number;
  private readonly staleAfterMinutes: number;

  private readonly quotes = new Map<string, QuoteEntry>();
  private readonly bars = new Map<string, BarsEntry>();

  private quoteHits = 0;
  private quoteMisses = 0;
  private barHits = 0;
  private barMisses = 0;

  constructor(opts: CachingMarketDataOptions) {
    this.delegate = opts.delegate;
    this.clock = opts.clock;
    this.log = opts.logger.child('marketdata:cache');
    this.quoteTtlMs = Math.max(0, opts.quoteCacheSeconds) * 1000;
    this.historyTtlMs = Math.max(0, opts.historyRefreshMinutes) * 60_000;
    this.maxTickers = opts.maxTickers ?? 500;
    this.staleAfterMinutes = opts.staleAfterMinutes ?? 30;
  }

  /** The underlying vendor's identity, unchanged. */
  get providerId(): string {
    return this.delegate.providerId;
  }

  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    return this.delegate.healthCheck();
  }

  async getMarketStatus(): Promise<MarketCalendarStatus> {
    return this.delegate.getMarketStatus();
  }

  /* ------------------------------------------------------------- quotes --- */

  /**
   * Re-age a cached quote against the current clock.
   *
   * The price and `asOf` are the vendor's; only the derived age is recomputed.
   * A quote that was fresh when fetched and has since gone stale is reported as
   * stale, exactly as an uncached read would report it.
   */
  private reage(quote: Quote): Quote {
    const ageMinutes = Math.max(0, (this.clock.nowMs() - new Date(quote.asOf).getTime()) / 60_000);
    return {
      ...quote,
      ageMinutes,
      // Staleness only ever ratchets on: a quote the vendor already called
      // stale cannot become fresh by sitting in a cache.
      stale: quote.stale || ageMinutes > this.staleAfterMinutes,
    };
  }

  async getQuote(ticker: string): Promise<Quote> {
    const map = await this.getQuotes([ticker]);
    const q = map.get(ticker.toUpperCase());
    if (q) return q;
    // Preserve the delegate's own error semantics rather than inventing one.
    return this.delegate.getQuote(ticker);
  }

  async getQuotes(tickers: string[]): Promise<Map<string, Quote>> {
    const nowMs = this.clock.nowMs();
    const out = new Map<string, Quote>();
    const misses: string[] = [];

    for (const raw of tickers) {
      const ticker = raw.toUpperCase();
      if (out.has(ticker) || misses.includes(ticker)) continue;
      const entry = this.quotes.get(ticker);
      if (entry && nowMs - entry.fetchedAtMs < this.quoteTtlMs) {
        this.quoteHits += 1;
        out.set(ticker, this.reage(entry.quote));
      } else {
        misses.push(ticker);
      }
    }

    // No misses means no vendor request at all. This is the whole point.
    if (misses.length === 0) return out;

    this.quoteMisses += misses.length;
    const fetched = await this.delegate.getQuotes(misses);
    for (const [ticker, quote] of fetched) {
      this.quotes.set(ticker, { quote, fetchedAtMs: nowMs });
      out.set(ticker, quote);
    }
    this.evict(this.quotes);
    return out;
  }

  /* --------------------------------------------------------------- bars --- */

  private barsKey(ticker: string, minutes: number | null): string {
    return `${ticker.toUpperCase()}|${minutes ?? 'D'}`;
  }

  /**
   * Serve a bar range from a wider cached range when one is fresh enough.
   *
   * The common case is the benchmark series: every candidate in a scan asks for
   * roughly the same window, so the first request pays and the rest slice.
   */
  private cachedBars(key: string, fromIso: string, toIso: string): PriceBar[] | null {
    const entry = this.bars.get(key);
    if (!entry) return null;
    if (this.clock.nowMs() - entry.fetchedAtMs >= this.historyTtlMs) return null;

    const fromDay = fromIso.slice(0, 10);
    const toDay = toIso.slice(0, 10);
    if (entry.fromDay > fromDay || entry.toDay < toDay) return null;

    return entry.bars.filter((b) => b.at >= fromIso && b.at.slice(0, 10) <= toDay);
  }

  async getDailyBars(ticker: string, fromIso: string, toIso: string): Promise<PriceBar[]> {
    const key = this.barsKey(ticker, null);
    const hit = this.cachedBars(key, fromIso, toIso);
    if (hit !== null) {
      this.barHits += 1;
      return hit;
    }

    this.barMisses += 1;
    const bars = await this.delegate.getDailyBars(ticker, fromIso, toIso);
    this.store(key, fromIso, toIso, bars);
    return bars;
  }

  async getIntradayBars(ticker: string, fromIso: string, toIso: string, minutes: number): Promise<PriceBar[]> {
    const key = this.barsKey(ticker, minutes);
    const hit = this.cachedBars(key, fromIso, toIso);
    if (hit !== null) {
      this.barHits += 1;
      return hit;
    }

    this.barMisses += 1;
    const bars = await this.delegate.getIntradayBars(ticker, fromIso, toIso, minutes);
    this.store(key, fromIso, toIso, bars);
    return bars;
  }

  /**
   * Keep the WIDEST window seen for a series, not the newest.
   *
   * A narrow later request must not shrink the cache and force the next wide
   * request back to the vendor.
   */
  private store(key: string, fromIso: string, toIso: string, bars: PriceBar[]): void {
    const fromDay = fromIso.slice(0, 10);
    const toDay = toIso.slice(0, 10);
    const existing = this.bars.get(key);

    if (existing && existing.fromDay <= fromDay && existing.toDay >= toDay && bars.length < existing.bars.length) {
      // A subset arrived; refresh the timestamp but keep the wider series.
      existing.fetchedAtMs = this.clock.nowMs();
      return;
    }

    this.bars.set(key, { fromDay, toDay, bars, fetchedAtMs: this.clock.nowMs() });
    this.evict(this.bars);
  }

  private evict(map: Map<string, { fetchedAtMs: number }>): void {
    if (map.size <= this.maxTickers) return;
    const oldest = [...map.entries()].sort((a, b) => a[1].fetchedAtMs - b[1].fetchedAtMs);
    const drop = map.size - this.maxTickers;
    for (let i = 0; i < drop; i += 1) {
      const entry = oldest[i];
      if (entry) map.delete(entry[0]);
    }
    this.log.debug('evicted cold cache entries', { dropped: drop });
  }

  /* -------------------------------------------------------------- admin --- */

  stats(): MarketDataCacheStats {
    const hits = this.quoteHits + this.barHits;
    const total = hits + this.quoteMisses + this.barMisses;
    return {
      quoteHits: this.quoteHits,
      quoteMisses: this.quoteMisses,
      barHits: this.barHits,
      barMisses: this.barMisses,
      hitRatePct: total === 0 ? 0 : Number(((hits / total) * 100).toFixed(1)),
      cachedTickers: this.quotes.size,
    };
  }

  /** Drop everything. Used by tests and by the market-open transition. */
  clear(): void {
    this.quotes.clear();
    this.bars.clear();
  }
}
