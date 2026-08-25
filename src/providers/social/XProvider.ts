/**
 * XProvider — the single place that speaks to the X API.
 *
 * Responsibilities:
 *   - build recent-search queries restricted to the Northstar universe
 *   - authenticate with a bearer token read from the environment
 *   - normalise the X payload into SocialEvent, including source tier
 *   - surface rate limits and auth failures as typed errors the health guard
 *     can act on
 *
 * It does NOT score, filter, resolve tickers or decide anything. The bearer
 * token never leaves this module and is never logged or persisted.
 */
import type { Clock, Logger } from '../../core/index.js';
import { deterministicId, randomId } from '../../core/index.js';
import type { EngagementMetrics, SocialAuthor, SocialEvent, SocialPostKind } from '../../domain/types.js';
import type {
  SocialDataProvider,
  SocialFetchResult,
  SocialQuery,
} from './SocialDataProvider.js';
import { SocialProviderError } from './SocialDataProvider.js';
import { SourceRegistry, normaliseHandle } from './sourceRegistry.js';

export interface XProviderOptions {
  bearerToken: string;
  baseUrl: string;
  clock: Clock;
  logger: Logger;
  registry: SourceRegistry;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Max query length X accepts for the recent-search endpoint. */
  maxQueryLength?: number;
  requestTimeoutMs?: number;
}

interface XUser {
  id: string;
  username: string;
  name: string;
  verified?: boolean;
  created_at?: string;
  public_metrics?: { followers_count?: number; tweet_count?: number };
}

interface XTweet {
  id: string;
  text: string;
  author_id: string;
  created_at: string;
  lang?: string;
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    quote_count?: number;
    impression_count?: number;
    bookmark_count?: number;
  };
  referenced_tweets?: { type: 'retweeted' | 'quoted' | 'replied_to'; id: string }[];
  entities?: { cashtags?: { tag: string }[]; annotations?: { type: string; normalized_text: string }[] };
}

interface XSearchResponse {
  data?: XTweet[];
  includes?: { users?: XUser[] };
  meta?: { result_count?: number; next_token?: string };
  errors?: { title?: string; detail?: string }[];
}

export class XProvider implements SocialDataProvider {
  readonly platform = 'X' as const;
  readonly providerId = 'x-api-v2';

  private readonly token: string;
  private readonly baseUrl: string;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly registry: SourceRegistry;
  private readonly doFetch: typeof fetch;
  private readonly maxQueryLength: number;
  private readonly timeoutMs: number;

  constructor(opts: XProviderOptions) {
    if (!opts.bearerToken) throw new Error('XProvider requires a bearer token (X_BEARER_TOKEN).');
    this.token = opts.bearerToken;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.clock = opts.clock;
    this.log = opts.logger.child('x-provider');
    this.registry = opts.registry;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.maxQueryLength = opts.maxQueryLength ?? 1024;
    this.timeoutMs = opts.requestTimeoutMs ?? 15_000;
  }

  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    try {
      const res = await this.request('/tweets/search/recent?query=from%3Areuters&max_results=10');
      return { healthy: true, detail: `X reachable, ${res.meta?.result_count ?? 0} results on probe` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { healthy: false, detail: msg };
    }
  }

  /**
   * Build a recent-search query scoped to the universe.
   *
   * The query is deliberately bounded: cashtags and quoted company names only,
   * English, no retweets at the API level (reposts add no independent
   * information and would dominate the quota). Long universes are chunked so a
   * single oversized query is never sent.
   */
  buildQueries(query: SocialQuery): string[] {
    const terms: string[] = [
      ...query.tickers.map((t) => `$${t.toUpperCase()}`),
      ...query.keywords.map((k) => (k.includes(' ') ? `"${k}"` : k)),
    ];
    const suffix = ' -is:retweet lang:en';
    const chunks: string[] = [];
    let current: string[] = [];

    const flush = (): void => {
      if (current.length === 0) return;
      chunks.push(`(${current.join(' OR ')})${suffix}`);
      current = [];
    };

    for (const term of terms) {
      const candidate = [...current, term];
      const length = `(${candidate.join(' OR ')})${suffix}`.length;
      if (length > this.maxQueryLength && current.length > 0) flush();
      current.push(term);
    }
    flush();
    return chunks;
  }

  async fetch(query: SocialQuery): Promise<SocialFetchResult> {
    const batchId = randomId('batch');
    const fetchedAt = this.clock.nowIso();
    const queries = this.buildQueries(query);
    const events: SocialEvent[] = [];
    const authorsById = new Map<string, SocialAuthor>();
    let truncated = false;
    let rateLimitRemaining: number | null = null;

    for (const q of queries) {
      const params = new URLSearchParams({
        query: q,
        max_results: String(Math.min(100, Math.max(10, query.limit))),
        start_time: query.since,
        'tweet.fields': 'created_at,public_metrics,lang,entities,referenced_tweets,author_id',
        'user.fields': 'username,name,verified,created_at,public_metrics',
        expansions: 'author_id',
      });

      const { response, remaining } = await this.requestWithMeta(`/tweets/search/recent?${params.toString()}`);
      rateLimitRemaining = remaining;
      if (response.meta?.next_token) truncated = true;

      const users = new Map<string, XUser>();
      for (const u of response.includes?.users ?? []) users.set(u.id, u);

      for (const tweet of response.data ?? []) {
        const user = users.get(tweet.author_id);
        if (!user) continue;
        const author = this.registry.classify({
          authorId: user.id,
          handle: user.username,
          displayName: user.name,
          verified: user.verified ?? false,
          followerCount: user.public_metrics?.followers_count ?? 0,
          ...(user.created_at ? { accountCreatedAt: user.created_at } : {}),
        });
        authorsById.set(author.authorId, author);
        events.push(this.toSocialEvent(tweet, author, batchId, fetchedAt));
      }

      if (events.length >= query.limit) {
        truncated = truncated || events.length > query.limit;
        break;
      }
    }

    this.log.info('x fetch complete', {
      batchId,
      queries: queries.length,
      events: events.length,
      truncated,
      rateLimitRemaining,
    });

    return {
      batchId,
      events: events.slice(0, query.limit),
      authors: [...authorsById.values()],
      fetchedAt,
      truncated,
      rateLimitRemaining,
    };
  }

  private toSocialEvent(tweet: XTweet, author: SocialAuthor, batchId: string, capturedAt: string): SocialEvent {
    const ref = tweet.referenced_tweets?.[0];
    const kind: SocialPostKind =
      ref?.type === 'retweeted' ? 'REPOST' : ref?.type === 'quoted' ? 'QUOTE' : ref?.type === 'replied_to' ? 'REPLY' : 'ORIGINAL';

    const engagement: EngagementMetrics = {
      likes: tweet.public_metrics?.like_count ?? 0,
      reposts: tweet.public_metrics?.retweet_count ?? 0,
      replies: tweet.public_metrics?.reply_count ?? 0,
      quotes: tweet.public_metrics?.quote_count ?? 0,
    };
    if (tweet.public_metrics?.impression_count !== undefined) engagement.impressions = tweet.public_metrics.impression_count;
    if (tweet.public_metrics?.bookmark_count !== undefined) engagement.bookmarks = tweet.public_metrics.bookmark_count;

    const cashtags = (tweet.entities?.cashtags ?? []).map((c) => c.tag.toUpperCase());
    const companies = (tweet.entities?.annotations ?? [])
      .filter((a) => a.type === 'Organization' || a.type === 'Product')
      .map((a) => a.normalized_text);

    const event: SocialEvent = {
      eventId: deterministicId('evt', 'X', tweet.id),
      platform: 'X',
      postId: tweet.id,
      authorId: author.authorId,
      authorHandle: author.handle,
      authorDisplayName: author.displayName,
      sourceClass: author.sourceClass,
      sourceTier: author.sourceTier,
      postedAt: new Date(tweet.created_at).toISOString(),
      capturedAt,
      text: tweet.text,
      url: `https://x.com/${normaliseHandle(author.handle)}/status/${tweet.id}`,
      kind,
      mentionedCashtags: cashtags,
      mentionedCompanies: companies,
      resolvedSecurityIds: [],
      engagement,
      ingestBatchId: batchId,
    };
    if (tweet.lang) event.lang = tweet.lang;
    if (ref) event.referencedPostId = ref.id;
    return event;
  }

  private async request(path: string): Promise<XSearchResponse> {
    return (await this.requestWithMeta(path)).response;
  }

  private async requestWithMeta(path: string): Promise<{ response: XSearchResponse; remaining: number | null }> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.doFetch(url, {
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new SocialProviderError(`X request failed: ${msg}`, 'NETWORK');
    } finally {
      clearTimeout(timer);
    }

    const remainingHeader = res.headers.get('x-rate-limit-remaining');
    const remaining = remainingHeader === null ? null : Number(remainingHeader);

    if (res.status === 401 || res.status === 403) {
      throw new SocialProviderError(`X authentication failed (${res.status})`, 'AUTH');
    }
    if (res.status === 429) {
      const resetHeader = res.headers.get('x-rate-limit-reset');
      const retryAfter = resetHeader ? Math.max(0, Number(resetHeader) * 1000 - this.clock.nowMs()) / 1000 : 900;
      throw new SocialProviderError('X rate limit exceeded', 'RATE_LIMIT', retryAfter);
    }
    if (res.status >= 500) {
      throw new SocialProviderError(`X unavailable (${res.status})`, 'UNAVAILABLE');
    }
    if (!res.ok) {
      throw new SocialProviderError(`X returned ${res.status}`, 'BAD_RESPONSE');
    }

    let body: XSearchResponse;
    try {
      body = (await res.json()) as XSearchResponse;
    } catch {
      throw new SocialProviderError('X returned a non-JSON body', 'BAD_RESPONSE');
    }
    if (body.errors && body.errors.length > 0 && !body.data) {
      throw new SocialProviderError(`X error: ${body.errors[0]?.title ?? 'unknown'}`, 'BAD_RESPONSE');
    }
    return { response: body, remaining };
  }
}
