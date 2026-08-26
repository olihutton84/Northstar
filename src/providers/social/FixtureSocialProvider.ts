/**
 * FixtureSocialProvider — deterministic SocialDataProvider for tests, replay
 * and offline paper runs.
 *
 * It implements exactly the same interface as XProvider, so the whole pipeline
 * runs end to end with no network, and a recorded batch replays identically.
 */
import type { Clock } from '../../core/index.js';
import { deterministicId } from '../../core/index.js';
import type { SocialAuthor, SocialEvent } from '../../domain/types.js';
import type { SocialDataProvider, SocialFetchResult, SocialQuery } from './SocialDataProvider.js';
import { SocialProviderError } from './SocialDataProvider.js';
import { SourceRegistry, normaliseHandle } from './sourceRegistry.js';

export interface FixturePost {
  postId: string;
  handle: string;
  displayName?: string;
  verified?: boolean;
  followerCount?: number;
  text: string;
  /** Absolute ISO time, or minutes-before-now when negative. */
  postedAt?: string;
  minutesAgo?: number;
  likes?: number;
  reposts?: number;
  replies?: number;
  quotes?: number;
  impressions?: number;
  kind?: SocialEvent['kind'];
  referencedPostId?: string;
  cashtags?: string[];
  companies?: string[];
  baselineEngagement?: number;
}

export interface FixtureSocialProviderOptions {
  clock: Clock;
  registry?: SourceRegistry;
  posts?: FixturePost[];
  /** Force the next fetch to throw, to exercise failure handling. */
  failWith?: SocialProviderError | null;
  batchId?: string;
}

/** Single-chunk cursor key; the fixture provider issues one logical query. */
export const FIXTURE_CURSOR_KEY = 'x:chunk:0';

export class FixtureSocialProvider implements SocialDataProvider {
  readonly platform = 'X' as const;
  readonly providerId = 'x-fixture';

  private posts: FixturePost[];
  private readonly clock: Clock;
  private readonly registry: SourceRegistry;
  private failWith: SocialProviderError | null;
  private batchCounter = 0;
  private readonly fixedBatchId: string | null;
  fetchCount = 0;

  constructor(opts: FixtureSocialProviderOptions) {
    this.clock = opts.clock;
    this.registry = opts.registry ?? new SourceRegistry();
    this.posts = opts.posts ?? [];
    this.failWith = opts.failWith ?? null;
    this.fixedBatchId = opts.batchId ?? null;
  }

  setPosts(posts: FixturePost[]): void {
    this.posts = posts;
  }

  addPosts(posts: FixturePost[]): void {
    this.posts = [...this.posts, ...posts];
  }

  /** Arm the next fetch (and every fetch until cleared) to fail. */
  setFailure(error: SocialProviderError | null): void {
    this.failWith = error;
  }

  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    if (this.failWith) return { healthy: false, detail: this.failWith.message };
    return { healthy: true, detail: `fixture provider with ${this.posts.length} posts` };
  }

  /** One logical query, so one notional request. */
  plannedRequestsPerScan(): number {
    return 1;
  }

  async fetch(query: SocialQuery): Promise<SocialFetchResult> {
    this.fetchCount += 1;
    if (this.failWith) throw this.failWith;

    const batchId = this.fixedBatchId ?? `batch_fixture_${++this.batchCounter}`;
    const capturedAt = this.clock.nowIso();
    const sinceMs = new Date(query.since).getTime();

    const authors = new Map<string, SocialAuthor>();
    const events: SocialEvent[] = [];

    for (const p of this.posts) {
      const postedAt = p.postedAt
        ? new Date(p.postedAt).toISOString()
        : new Date(this.clock.nowMs() - (p.minutesAgo ?? 5) * 60_000).toISOString();
      if (new Date(postedAt).getTime() < sinceMs) continue;

      const author = this.registry.classify({
        authorId: deterministicId('author', normaliseHandle(p.handle)),
        handle: p.handle,
        displayName: p.displayName ?? p.handle,
        verified: p.verified ?? false,
        followerCount: p.followerCount ?? 0,
      });
      authors.set(author.authorId, author);

      const event: SocialEvent = {
        eventId: deterministicId('evt', 'X', p.postId),
        platform: 'X',
        postId: p.postId,
        authorId: author.authorId,
        authorHandle: author.handle,
        authorDisplayName: author.displayName,
        sourceClass: author.sourceClass,
        sourceTier: author.sourceTier,
        postedAt,
        capturedAt,
        text: p.text,
        url: `https://x.com/${author.handle}/status/${p.postId}`,
        lang: 'en',
        kind: p.kind ?? 'ORIGINAL',
        mentionedCashtags: p.cashtags ?? extractCashtags(p.text),
        mentionedCompanies: p.companies ?? [],
        resolvedSecurityIds: [],
        engagement: {
          likes: p.likes ?? 0,
          reposts: p.reposts ?? 0,
          replies: p.replies ?? 0,
          quotes: p.quotes ?? 0,
          ...(p.impressions !== undefined ? { impressions: p.impressions } : {}),
        },
        ingestBatchId: batchId,
      };
      if (p.referencedPostId) event.referencedPostId = p.referencedPostId;
      if (p.baselineEngagement !== undefined) event.authorBaselineEngagement = p.baselineEngagement;
      events.push(event);
    }

    events.sort((a, b) => a.postedAt.localeCompare(b.postedAt));

    // Honour the cursor exactly as the real provider does, so cursor handling
    // is exercised offline rather than only against the live API.
    //
    // Fixture post ids are readable labels rather than ordered snowflakes, so
    // the cursor is resolved POSITIONALLY: find the post it names and return
    // what comes after it. A cursor naming a post that is no longer in the
    // fixture returns everything, which is exactly what X does when `since_id`
    // predates the whole result set.
    const sinceId = query.sinceIds?.[FIXTURE_CURSOR_KEY];
    const cursorIndex = sinceId === undefined ? -1 : events.findIndex((e) => e.postId === sinceId);
    const fresh = cursorIndex >= 0 ? events.slice(cursorIndex + 1) : events;
    const limited = fresh.slice(0, query.limit);

    // The cursor advances only to a post actually returned. Advancing past
    // posts that were truncated away would lose them permanently.
    const newestIds: Record<string, string> = {};
    const newest = limited.at(-1);
    if (newest) newestIds[FIXTURE_CURSOR_KEY] = newest.postId;

    return {
      batchId,
      events: limited,
      authors: [...authors.values()],
      fetchedAt: capturedAt,
      truncated: limited.length < fresh.length,
      rateLimitRemaining: null,
      newestIds,
      requestCount: 1,
    };
  }
}

export function extractCashtags(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\$([A-Za-z]{1,5})\b/g)) {
    const tag = m[1];
    if (tag) out.add(tag.toUpperCase());
  }
  return [...out];
}
