/**
 * SocialDataProvider — the only way Trading Lab may obtain social data.
 *
 * No component above this interface knows that X exists. Adding Reddit,
 * StockTwits or a news wire later means writing another implementation, not
 * touching the signal engine.
 */
import type { SocialAuthor, SocialEvent } from '../../domain/types.js';

export interface SocialQuery {
  /** Cashtags/tickers to search for, already restricted to the universe. */
  tickers: string[];
  /** Company names and aliases to search for. */
  keywords: string[];
  /** Only return posts newer than this. */
  since: string;
  /** Provider-side cap on returned posts. */
  limit: number;
  /** Author ids whose timelines should always be pulled (Tier 1 accounts). */
  followedAuthorIds?: string[];
}

export interface SocialFetchResult {
  batchId: string;
  events: SocialEvent[];
  /** Authors observed in this batch, for tier/baseline bookkeeping. */
  authors: SocialAuthor[];
  fetchedAt: string;
  /** True when the provider truncated results (rate limit or page cap). */
  truncated: boolean;
  /** Provider-reported rate-limit headroom, when available. */
  rateLimitRemaining: number | null;
}

export class SocialProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'AUTH' | 'RATE_LIMIT' | 'NETWORK' | 'BAD_RESPONSE' | 'UNAVAILABLE',
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'SocialProviderError';
  }
}

export interface SocialDataProvider {
  readonly platform: 'X';
  readonly providerId: string;
  /** Cheap reachability/credential check used by the health guard. */
  healthCheck(): Promise<{ healthy: boolean; detail: string }>;
  fetch(query: SocialQuery): Promise<SocialFetchResult>;
}
