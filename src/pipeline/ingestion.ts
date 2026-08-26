/**
 * Ingestion.
 *
 * Pulls from a SocialDataProvider, persists every observed event, and keeps
 * author bookkeeping (tier + engagement baseline) up to date. Persisting the
 * raw normalised event before any scoring is what makes historical signals
 * reproducible: the signal engine can be re-run over stored events months later
 * and must produce the same numbers.
 *
 * Ingestion is CURSOR-DRIVEN. The newest post id seen per query chunk is
 * persisted, and the next poll asks the vendor for posts newer than it. Without
 * that, every two-minute scan re-downloads the same window and pays for posts
 * it has already stored — the duplicate count would carry the whole request
 * budget. Cursors live in the database rather than in memory so a restart
 * resumes where the last poll finished instead of re-reading the last hour.
 */
import type { Clock, Logger } from '../core/index.js';
import { randomId } from '../core/index.js';
import type { SocialEvent, UniverseSource } from '../domain/types.js';
import type { Store } from '../persistence/store.js';
import type { SocialDataProvider } from '../providers/social/SocialDataProvider.js';
import type { UniverseRegistry } from '../universe/UniverseRegistry.js';

/** Every social cursor key is namespaced, so `all()` cannot pick up others. */
const CURSOR_PREFIX = 'x:';

export interface IngestionOptions {
  provider: SocialDataProvider;
  store: Store;
  universe: UniverseRegistry;
  clock: Clock;
  logger: Logger;
  /** How far back the FIRST poll looks, before any cursor exists. */
  lookbackMinutes?: number;
  /** Provider-side cap per poll. */
  limit?: number;
}

export interface IngestionResult {
  batchId: string;
  fetched: number;
  stored: number;
  duplicates: number;
  truncated: boolean;
  rateLimitRemaining: number | null;
  events: SocialEvent[];
  /** Vendor requests this poll actually cost. */
  requestCount: number;
  /** True when the poll ran from a persisted cursor rather than a time window. */
  usedCursor: boolean;
}

export class IngestionService {
  private readonly provider: SocialDataProvider;
  private readonly store: Store;
  private readonly universe: UniverseRegistry;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly lookbackMinutes: number;
  private readonly limit: number;

  constructor(opts: IngestionOptions) {
    this.provider = opts.provider;
    this.store = opts.store;
    this.universe = opts.universe;
    this.clock = opts.clock;
    this.log = opts.logger.child('ingestion');
    this.lookbackMinutes = opts.lookbackMinutes ?? 60;
    this.limit = opts.limit ?? 100;
  }

  async ingest(sources: UniverseSource[], correlationId = randomId('corr')): Promise<IngestionResult> {
    const { tickers, keywords } = this.universe.searchTerms(sources);
    const since = new Date(this.clock.nowMs() - this.lookbackMinutes * 60_000).toISOString();

    // `since` remains as the cold-start bound; where a cursor exists the
    // provider prefers it, so a restart never re-reads a whole window.
    const sinceIds = this.store.cursors.all(CURSOR_PREFIX);
    const usedCursor = Object.keys(sinceIds).length > 0;

    const result = await this.provider.fetch({ tickers, keywords, since, limit: this.limit, sinceIds });

    let stored = 0;
    let duplicates = 0;
    const newEvents: SocialEvent[] = [];

    this.store.db.transaction(() => {
      for (const author of result.authors) {
        const existing = this.store.authors.byId(author.authorId);
        this.store.authors.upsert(author, existing?.baselineEngagement ?? 0);
      }

      for (const event of result.events) {
        // The author's baseline is captured at ingest time so that engagement
        // velocity is scored against what was normal *then*, not against a
        // baseline that has since drifted.
        const author = this.store.authors.byId(event.authorId);
        const enriched: SocialEvent = {
          ...event,
          authorBaselineEngagement: event.authorBaselineEngagement ?? author?.baselineEngagement ?? 0,
        };
        if (this.store.events.insertIfNew(enriched)) {
          stored += 1;
          newEvents.push(enriched);
        } else {
          duplicates += 1;
        }
      }

      this.updateAuthorBaselines(result.events);

      // Cursors advance in the SAME transaction as the events they came from.
      // A crash between the two would otherwise skip posts permanently: the
      // cursor would say "seen" for events that were never stored.
      for (const [key, value] of Object.entries(result.newestIds)) {
        this.store.cursors.advance(key, value);
      }
    });

    this.store.log.append({
      correlationId,
      strategyId: 'x-signal-v1',
      stage: 'INGEST',
      subjectId: result.batchId,
      summary: `Ingested ${stored} new events (${duplicates} duplicates) from ${this.provider.providerId}`,
      payload: {
        batchId: result.batchId,
        fetched: result.events.length,
        stored,
        duplicates,
        truncated: result.truncated,
        tickerTerms: tickers.length,
        keywordTerms: keywords.length,
        since,
        usedCursor,
        requestCount: result.requestCount,
      },
    });

    this.log.info('ingest complete', {
      batchId: result.batchId,
      stored,
      duplicates,
      truncated: result.truncated,
      requests: result.requestCount,
      usedCursor,
    });

    return {
      batchId: result.batchId,
      fetched: result.events.length,
      stored,
      duplicates,
      truncated: result.truncated,
      rateLimitRemaining: result.rateLimitRemaining,
      events: newEvents,
      requestCount: result.requestCount,
      usedCursor,
    };
  }

  /**
   * Rolling engagement baseline per author.
   *
   * An exponentially-weighted mean of observed engagement. Cheap, bounded, and
   * good enough to answer "is this post unusually loud *for this account*",
   * which is the only question engagement velocity is allowed to ask.
   */
  private updateAuthorBaselines(events: SocialEvent[]): void {
    const alpha = 0.2;
    const byAuthor = new Map<string, number[]>();
    for (const e of events) {
      const total = e.engagement.likes + e.engagement.reposts + e.engagement.replies + e.engagement.quotes;
      const list = byAuthor.get(e.authorId) ?? [];
      list.push(total);
      byAuthor.set(e.authorId, list);
    }
    for (const [authorId, totals] of byAuthor) {
      const author = this.store.authors.byId(authorId);
      let baseline = author?.baselineEngagement ?? 0;
      for (const t of totals) baseline = baseline === 0 ? t : baseline * (1 - alpha) + t * alpha;
      this.store.authors.updateBaseline(authorId, Number(baseline.toFixed(2)));
    }
  }
}
