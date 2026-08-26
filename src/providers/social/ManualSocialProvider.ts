/**
 * Real X posts, supplied by hand instead of fetched.
 *
 * This is a SocialDataProvider like any other, which is the point: the posts an
 * operator pastes in go through exactly the same event detection, ticker
 * resolution, x-signal-v1 scoring, Tiingo confirmation, risk engine and Alpaca
 * PAPER execution as posts the API would have returned. Nothing downstream is
 * aware the evidence arrived through a person.
 *
 * It differs from the fixture provider in the way that matters: fixtures are
 * INVENTED, and these are REAL public posts that a human transcribed. The
 * events it emits carry `source: X_MANUAL` and
 * `provenance: MANUAL_OPERATOR_SUPPLIED`, and the URL of the actual post, so a
 * trade can be traced back to the thing that caused it. It is never presented
 * as API data anywhere.
 *
 * It costs zero vendor requests, which is the entire reason it exists.
 */
import type { Clock } from '../../core/index.js';
import { deterministicId } from '../../core/index.js';
import type { ManualObservation, SocialAuthor, SocialEvent } from '../../domain/types.js';
import type { Store } from '../../persistence/store.js';
import type { SocialDataProvider, SocialFetchResult, SocialQuery } from './SocialDataProvider.js';
import { extractCashtags } from './FixtureSocialProvider.js';
import { SourceRegistry, normaliseHandle } from './sourceRegistry.js';

export interface ManualSocialProviderOptions {
  clock: Clock;
  store: Store;
  registry?: SourceRegistry;
  /** How many pending observations one scan may drain. */
  batchLimit?: number;
}

/** Single logical query, so cursor bookkeeping matches the fixture provider. */
export const MANUAL_CURSOR_KEY = 'x:manual:0';

export class ManualSocialProvider implements SocialDataProvider {
  readonly platform = 'X' as const;
  readonly providerId = 'x-manual';

  private readonly clock: Clock;
  private readonly store: Store;
  private readonly registry: SourceRegistry;
  private readonly batchLimit: number;
  private batchCounter = 0;
  fetchCount = 0;

  constructor(opts: ManualSocialProviderOptions) {
    this.clock = opts.clock;
    this.store = opts.store;
    this.registry = opts.registry ?? new SourceRegistry();
    this.batchLimit = opts.batchLimit ?? 100;
  }

  /**
   * Healthy whenever the store is readable.
   *
   * An empty queue is NOT unhealthy: "the operator has not pasted anything
   * lately" is a fact about the operator, not a fault in the bot, and pausing
   * the strategy for it would be wrong. It is reported, not treated as failure.
   */
  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    try {
      const counts = this.store.manual.counts();
      return {
        healthy: true,
        detail:
          `Manual X ingest: ${counts.pending} pending, ${counts.ingested} ingested, ` +
          `${counts.total} observation(s) held.`,
      };
    } catch (e) {
      return { healthy: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * No vendor requests, ever.
   *
   * Stated explicitly rather than left implicit, because the request-budget
   * check believes this number.
   */
  plannedRequestsPerScan(_query: SocialQuery): number {
    return 0;
  }

  async fetch(query: SocialQuery): Promise<SocialFetchResult> {
    this.fetchCount += 1;
    const capturedAt = this.clock.nowIso();
    this.batchCounter += 1;
    const batchId = deterministicId('batch', 'manual', String(this.batchCounter), capturedAt);

    const pending = this.store.manual.pending(Math.min(this.batchLimit, query.limit || this.batchLimit));

    const events: SocialEvent[] = [];
    const authors: SocialAuthor[] = [];
    let newest = '';

    /*
     * The scan window is deliberately NOT applied here.
     *
     * For the API it decides what to ask the vendor for. For a pasted post
     * there is nothing to ask: the operator has already chosen it, and the act
     * of pasting is the request. Filtering by the polling window would silently
     * drop anything older than the last scan — an operator pasting this
     * morning's post would see nothing happen and be told nothing about why.
     *
     * Post AGE still matters, and is still applied: `postedAt` carries the true
     * publication time into the signal engine, whose recency dimension discounts
     * an old post exactly as it would an old one from the API. Age is judged
     * where age is understood, once, rather than twice and lossily.
     */
    for (const observation of pending) {
      const author = this.registry.classify({
        authorId: deterministicId('author', normaliseHandle(observation.handle)),
        handle: observation.handle,
        displayName: observation.displayName,
        verified: observation.verified,
        followerCount: observation.followerCount ?? 0,
      });
      authors.push(author);

      const event = this.toEvent(observation, author, batchId);
      events.push(event);

      // Marked here rather than after the pipeline runs: an observation is
      // consumed once. Re-emitting it on the next scan would let one post
      // corroborate itself, which is exactly what the dedup exists to stop.
      this.store.manual.markIngested(observation.observationId, event.eventId, capturedAt);

      if (observation.postId > newest) newest = observation.postId;
    }

    return {
      batchId,
      events,
      authors,
      fetchedAt: capturedAt,
      truncated: pending.length >= this.batchLimit,
      rateLimitRemaining: null,
      newestIds: newest === '' ? {} : { [MANUAL_CURSOR_KEY]: newest },
      requestCount: 0,
    };
  }

  private toEvent(o: ManualObservation, author: SocialAuthor, batchId: string): SocialEvent {
    /*
     * The event id is derived from the POST id, exactly as the API path derives
     * it, so a post supplied manually and later fetched from the API resolves
     * to the same event rather than two.
     */
    const event: SocialEvent = {
      eventId: deterministicId('evt', 'X', o.postId),
      platform: 'X',
      postId: o.postId,
      authorId: author.authorId,
      authorHandle: author.handle,
      authorDisplayName: author.displayName,
      sourceClass: author.sourceClass,
      sourceTier: author.sourceTier,
      postedAt: o.postedAt,
      // When the OPERATOR captured it, not when the scan ran: that is the
      // honest observation time for a hand-supplied post.
      capturedAt: o.capturedAt,
      text: o.text,
      url: o.canonicalUrl,
      kind: 'ORIGINAL',
      // The API supplies entity annotations; a pasted post has none, so the
      // cashtags come from the text by the same extraction the fixtures use.
      mentionedCashtags: extractCashtags(o.text),
      mentionedCompanies: [],
      resolvedSecurityIds: [],
      engagement: o.engagement,
      ingestBatchId: batchId,
      source: 'X_MANUAL',
      provenance: 'MANUAL_OPERATOR_SUPPLIED',
    };
    return event;
  }
}
