/**
 * Replay providers.
 *
 * These implement the same SocialDataProvider and MarketDataProvider interfaces
 * as X and Tiingo, so replay exercises the real pipeline rather than a parallel
 * one. Their single additional job is to make look-ahead structurally
 * impossible.
 *
 * Every read is filtered against the replay Clock:
 *
 *   - an event is invisible until `capturedAt <= now` (when Northstar actually
 *     observed it, not when it was written)
 *   - a bar is invisible until `at <= now`
 *   - a requested bar range is CLAMPED to now, so asking for a future window
 *     silently returns nothing instead of the future
 *
 * The filtering lives here rather than in the engine on purpose: a caller
 * cannot opt out of it, and a future provider method cannot forget it as long
 * as it goes through `visibleBars`.
 */
import type { Clock } from '../core/index.js';
import type { MarketCalendarStatus, PriceBar, Quote, SocialAuthor, SocialEvent } from '../domain/types.js';
import type { MarketDataProvider } from '../providers/marketdata/MarketDataProvider.js';
import { MarketDataError } from '../providers/marketdata/MarketDataProvider.js';
import { marketStatus } from '../providers/marketdata/marketCalendar.js';
import type {
  SocialDataProvider,
  SocialFetchResult,
  SocialQuery,
} from '../providers/social/SocialDataProvider.js';
import type { ReplayDataset } from './dataset.js';

/* ------------------------------------------------------------- social --- */

export const REPLAY_CURSOR_KEY = 'x:chunk:0';

export class ReplaySocialProvider implements SocialDataProvider {
  readonly platform = 'X' as const;
  readonly providerId = 'x-replay';

  private readonly events: SocialEvent[];
  private readonly authorsById: Map<string, SocialAuthor>;
  private batch = 0;

  /** Instrumentation: how many events the replay has ever revealed. */
  revealed = 0;

  constructor(dataset: ReplayDataset, private readonly clock: Clock) {
    this.events = [...dataset.events].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    this.authorsById = new Map(dataset.authors.map((a) => [a.authorId, a]));
  }

  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    return { healthy: true, detail: `replay social provider, ${this.events.length} events` };
  }

  /** One logical query, so one notional request. */
  plannedRequestsPerScan(): number {
    return 1;
  }

  async fetch(query: SocialQuery): Promise<SocialFetchResult> {
    const nowIso = this.clock.nowIso();
    const visible = this.events.filter((e) => e.capturedAt <= nowIso && e.postedAt >= query.since);

    const limited = visible.slice(-Math.max(1, query.limit));
    this.revealed += limited.length;

    const authors: SocialAuthor[] = [];
    for (const id of new Set(limited.map((e) => e.authorId))) {
      const author = this.authorsById.get(id);
      if (author) authors.push(author);
    }

    const newestIds: Record<string, string> = {};
    const newest = [...limited].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)).at(-1);
    if (newest) newestIds[REPLAY_CURSOR_KEY] = newest.postId;

    return {
      batchId: `replay_batch_${++this.batch}`,
      // capturedAt is preserved from the dataset: the replay must reproduce the
      // observation time, not stamp its own.
      events: limited,
      authors,
      fetchedAt: nowIso,
      truncated: limited.length < visible.length,
      rateLimitRemaining: null,
      newestIds,
      requestCount: 1,
    };
  }

  /** Events the replay has NOT yet revealed. Used to assert no look-ahead. */
  hiddenCount(): number {
    const nowIso = this.clock.nowIso();
    return this.events.filter((e) => e.capturedAt > nowIso).length;
  }
}

/* -------------------------------------------------------- market data --- */

export interface ReplayMarketDataOptions {
  /** A quote older than this many minutes is flagged stale, as in production. */
  staleAfterMinutes?: number;
  /** Override the calendar; otherwise the real calendar runs on replay time. */
  forceMarketOpen?: boolean | null;
}

export class ReplayMarketDataProvider implements MarketDataProvider {
  readonly providerId = 'replay-marketdata';

  private readonly byTicker = new Map<string, PriceBar[]>();
  private readonly staleAfterMinutes: number;
  private readonly forceMarketOpen: boolean | null;

  constructor(dataset: ReplayDataset, private readonly clock: Clock, opts: ReplayMarketDataOptions = {}) {
    for (const bar of dataset.bars) {
      const key = bar.ticker.toUpperCase();
      const list = this.byTicker.get(key) ?? [];
      list.push(bar);
      this.byTicker.set(key, list);
    }
    for (const list of this.byTicker.values()) list.sort((a, b) => a.at.localeCompare(b.at));

    this.staleAfterMinutes = opts.staleAfterMinutes ?? 30;
    this.forceMarketOpen = opts.forceMarketOpen ?? null;
  }

  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    return { healthy: true, detail: `replay market data, ${this.byTicker.size} tickers` };
  }

  /**
   * The single choke point for time filtering. Every read goes through here, so
   * no method can accidentally expose a future bar.
   */
  private visibleBars(ticker: string): PriceBar[] {
    const nowIso = this.clock.nowIso();
    return (this.byTicker.get(ticker.toUpperCase()) ?? []).filter((b) => b.at <= nowIso);
  }

  async getQuote(ticker: string): Promise<Quote> {
    const visible = this.visibleBars(ticker);
    const latest = visible[visible.length - 1];
    if (!latest) {
      throw new MarketDataError(`No replay price for ${ticker.toUpperCase()} at ${this.clock.nowIso()}`, 'NOT_FOUND');
    }
    const ageMinutes = Math.max(0, (this.clock.nowMs() - new Date(latest.at).getTime()) / 60_000);
    return {
      ticker: ticker.toUpperCase(),
      price: latest.close,
      asOf: latest.at,
      ageMinutes,
      stale: ageMinutes > this.staleAfterMinutes,
    };
  }

  async getQuotes(tickers: string[]): Promise<Map<string, Quote>> {
    const out = new Map<string, Quote>();
    for (const ticker of tickers) {
      try {
        out.set(ticker.toUpperCase(), await this.getQuote(ticker));
      } catch {
        /* a ticker with no visible history is simply absent */
      }
    }
    return out;
  }

  async getDailyBars(ticker: string, fromIso: string, toIso: string): Promise<PriceBar[]> {
    // Clamp the upper bound to now. A caller asking for a future window gets
    // what was knowable, never the future.
    const ceiling = this.clock.nowIso();
    const upper = toIso < ceiling ? toIso : ceiling;
    return this.visibleBars(ticker).filter((b) => b.at >= fromIso && b.at <= upper);
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
      reason: this.forceMarketOpen ? 'Forced open (replay)' : 'Forced closed (replay)',
    };
  }

  /** Bars the replay has NOT yet revealed. Used to assert no look-ahead. */
  hiddenCount(): number {
    const nowIso = this.clock.nowIso();
    let hidden = 0;
    for (const list of this.byTicker.values()) hidden += list.filter((b) => b.at > nowIso).length;
    return hidden;
  }
}
