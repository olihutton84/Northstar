/**
 * API telemetry.
 *
 * Every outbound vendor request is recorded here: counts by outcome, the last
 * success, the last error, and any rate-limit headroom the vendor advertised.
 * Counters persist per UTC day, so a restart does not reset the morning's usage
 * and the request budget stays legible all day.
 *
 * Secrets never reach this class. Providers pass only status codes, error
 * messages and rate-limit headers; there is no code path that could carry a
 * key, and `record` explicitly stores only vendor-supplied error text.
 */
import type { Clock } from '../core/index.js';
import type { ApiUsageRow, Store } from '../persistence/store.js';

export type ApiProvider = 'x' | 'tiingo' | 'alpaca';

export type ApiOutcome =
  | 'SUCCESS'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'SERVER_ERROR'
  | 'OTHER_ERROR';

export interface RateLimitHeaders {
  remaining?: number | null;
  limit?: number | null;
  /** When the window resets, as an ISO instant. */
  resetAt?: string | null;
}

export interface ApiUsageSnapshot extends ApiUsageRow {
  /** Minutes since the last successful request, or null if never. */
  minutesSinceSuccess: number | null;
  /** Percent of the soft daily budget consumed, when one applies. */
  softCapUsedPct: number | null;
}

export class ApiMeter {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    private readonly softCaps: Partial<Record<ApiProvider, number>> = {},
  ) {}

  private day(): string {
    return this.clock.nowIso().slice(0, 10);
  }

  /** Record one request outcome. Never receives or stores a credential. */
  record(
    provider: ApiProvider,
    outcome: ApiOutcome,
    detail?: string | null,
    rateLimit?: RateLimitHeaders,
  ): void {
    this.store.apiUsage.record({
      provider,
      day: this.day(),
      outcome,
      at: this.clock.nowIso(),
      detail: detail ? detail.slice(0, 300) : null,
      rateLimitRemaining: rateLimit?.remaining ?? null,
      rateLimitLimit: rateLimit?.limit ?? null,
      rateLimitResetAt: rateLimit?.resetAt ?? null,
    });
  }

  /** Classify an HTTP status into an outcome. */
  static outcomeForStatus(status: number): ApiOutcome {
    if (status >= 200 && status < 300) return 'SUCCESS';
    if (status === 401) return 'UNAUTHORIZED';
    if (status === 403) return 'FORBIDDEN';
    if (status === 429) return 'RATE_LIMITED';
    if (status >= 500) return 'SERVER_ERROR';
    return 'OTHER_ERROR';
  }

  usage(provider: ApiProvider): ApiUsageSnapshot {
    return this.decorate(this.store.apiUsage.get(provider, this.day()));
  }

  today(): ApiUsageSnapshot[] {
    const day = this.day();
    const rows = this.store.apiUsage.allForDay(day);
    const present = new Set(rows.map((r) => r.provider));
    for (const provider of ['x', 'tiingo', 'alpaca'] as ApiProvider[]) {
      if (!present.has(provider)) rows.push(this.store.apiUsage.get(provider, day));
    }
    return rows.sort((a, b) => a.provider.localeCompare(b.provider)).map((r) => this.decorate(r));
  }

  private decorate(row: ApiUsageRow): ApiUsageSnapshot {
    const cap = this.softCaps[row.provider as ApiProvider];
    return {
      ...row,
      minutesSinceSuccess:
        row.lastSuccessAt === null
          ? null
          : Number(((this.clock.nowMs() - new Date(row.lastSuccessAt).getTime()) / 60_000).toFixed(2)),
      softCapUsedPct: cap ? Number(((row.requests / cap) * 100).toFixed(1)) : null,
    };
  }

  /**
   * Whether a provider is under rate-limit pressure right now.
   *
   * Pressure is not only a 429: advertised headroom running low, or the daily
   * soft cap being consumed early, both mean "slow down before being told to".
   */
  underPressure(provider: ApiProvider): { pressured: boolean; reason: string } {
    const usage = this.usage(provider);

    if (usage.rateLimited > 0 && usage.lastErrorKind === 'RATE_LIMITED') {
      const since = usage.lastErrorAt
        ? (this.clock.nowMs() - new Date(usage.lastErrorAt).getTime()) / 60_000
        : Infinity;
      if (since < 15) return { pressured: true, reason: `rate limited ${since.toFixed(0)}m ago` };
    }

    if (usage.rateLimitRemaining !== null && usage.rateLimitLimit !== null && usage.rateLimitLimit > 0) {
      const headroom = usage.rateLimitRemaining / usage.rateLimitLimit;
      if (headroom < 0.15) {
        return { pressured: true, reason: `only ${usage.rateLimitRemaining} of ${usage.rateLimitLimit} requests left in the window` };
      }
    }

    const cap = this.softCaps[provider];
    if (cap && usage.requests >= cap) {
      return { pressured: true, reason: `daily soft cap reached (${usage.requests}/${cap})` };
    }

    return { pressured: false, reason: 'within limits' };
  }
}

/** Parse an X/Alpaca style rate-limit header set. Tolerates absence. */
export function parseRateLimitHeaders(headers: Headers, clock: Clock): RateLimitHeaders {
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  const remaining = num('x-rate-limit-remaining') ?? num('x-ratelimit-remaining');
  const limit = num('x-rate-limit-limit') ?? num('x-ratelimit-limit');
  const reset = num('x-rate-limit-reset') ?? num('x-ratelimit-reset');

  let resetAt: string | null = null;
  if (reset !== null) {
    // X sends epoch seconds; some APIs send seconds-until-reset. Anything
    // smaller than a day is treated as a delta rather than an absolute time.
    resetAt =
      reset > 1_000_000_000
        ? new Date(reset * 1000).toISOString()
        : new Date(clock.nowMs() + reset * 1000).toISOString();
  }

  return { remaining, limit, resetAt };
}
