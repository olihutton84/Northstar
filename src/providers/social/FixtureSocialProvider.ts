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
    const limited = events.slice(0, query.limit);

    return {
      batchId,
      events: limited,
      authors: [...authors.values()],
      fetchedAt: capturedAt,
      truncated: limited.length < events.length,
      rateLimitRemaining: null,
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
