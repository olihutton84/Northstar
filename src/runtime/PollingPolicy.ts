/**
 * Adaptive X polling cadence.
 *
 * Three states, in priority order:
 *
 *   API_PRESSURE  rate-limited, low advertised headroom, or the daily soft cap
 *                 reached — poll slower, with exponential backoff after a 429
 *   EVENT_WATCH   a material, high-scoring new event has landed on a security —
 *                 poll faster for a short window, because that is when follow-up
 *                 information actually arrives
 *   NORMAL        the baseline
 *
 * Pressure always wins over event watch. Polling faster into a rate limit
 * during the one window that matters is how a bot loses the whole session.
 *
 * The policy decides *how often to look*. It never decides whether to trade —
 * duplicate suppression and the same-ticker cooldown do that, so a faster
 * cadence cannot turn into more trades on the same information.
 */
import type { Clock, Logger } from '../core/index.js';
import type { OperationsConfig } from '../config/operations.js';
import type { ApiMeter } from './ApiMeter.js';

export type PollingState = 'NORMAL' | 'EVENT_WATCH' | 'API_PRESSURE';

export interface PollingStatus {
  state: PollingState;
  intervalSeconds: number;
  reason: string;
  /** Securities currently on event watch, with when the watch expires. */
  watching: { ticker: string; untilIso: string; minutesLeft: number }[];
  consecutiveRateLimits: number;
  backoffSeconds: number;
  nextPollAt: string | null;
}

export class PollingPolicy {
  private readonly log: Logger;
  private readonly watches = new Map<string, number>();
  private consecutiveRateLimits = 0;
  private lastRateLimitAtMs: number | null = null;
  private nextPollAtMs: number | null = null;

  constructor(
    private readonly ops: OperationsConfig,
    private readonly clock: Clock,
    logger: Logger,
    private readonly meter: ApiMeter | null = null,
  ) {
    this.log = logger.child('polling');
  }

  /**
   * Put a security on event watch.
   *
   * Called only for a genuinely new, material, high-scoring event — never for a
   * re-score of information already seen, or the bot would hold itself at the
   * fast cadence indefinitely on one stale story.
   */
  watch(ticker: string, score: number): void {
    if (Math.abs(score) < this.ops.xEventWatchTriggerScore) return;
    const until = this.clock.nowMs() + this.ops.xEventWatchMinutes * 60_000;
    const existing = this.watches.get(ticker);
    if (existing !== undefined && existing >= until) return;

    this.watches.set(ticker, until);
    this.log.info('event watch engaged', {
      ticker,
      score,
      minutes: this.ops.xEventWatchMinutes,
    });
  }

  /** Record a 429 and grow the backoff. */
  recordRateLimit(retryAfterSeconds: number | null): number {
    const nowMs = this.clock.nowMs();

    // A 429 long after the last one starts a fresh backoff ladder rather than
    // inheriting yesterday's escalation.
    if (
      this.lastRateLimitAtMs !== null &&
      nowMs - this.lastRateLimitAtMs > this.ops.xBackoffResetAfterMinutes * 60_000
    ) {
      this.consecutiveRateLimits = 0;
    }

    this.consecutiveRateLimits += 1;
    this.lastRateLimitAtMs = nowMs;

    const backoff = this.backoffSeconds();
    // Honour the vendor's own Retry-After when it asks for longer than we would.
    const waitSeconds = Math.max(backoff, retryAfterSeconds ?? 0);
    this.nextPollAtMs = nowMs + waitSeconds * 1000;

    this.log.warn('rate limited; backing off', {
      consecutive: this.consecutiveRateLimits,
      waitSeconds,
      retryAfterSeconds,
    });
    return waitSeconds;
  }

  /** A successful poll clears the backoff ladder. */
  recordSuccess(): void {
    if (this.consecutiveRateLimits > 0) {
      this.log.info('rate-limit pressure cleared', { priorConsecutive: this.consecutiveRateLimits });
    }
    this.consecutiveRateLimits = 0;
    this.nextPollAtMs = null;
  }

  /** Exponential: base interval doubled per consecutive 429, capped. */
  backoffSeconds(): number {
    if (this.consecutiveRateLimits === 0) return 0;
    const base = this.ops.xApiPressureIntervalSeconds;
    const grown = base * 2 ** (this.consecutiveRateLimits - 1);
    return Math.min(this.ops.xMaxBackoffSeconds, grown);
  }

  /** True while a backoff window is still open. */
  inBackoff(): boolean {
    return this.nextPollAtMs !== null && this.clock.nowMs() < this.nextPollAtMs;
  }

  private pruneWatches(): void {
    const nowMs = this.clock.nowMs();
    for (const [ticker, until] of [...this.watches]) {
      if (until <= nowMs) {
        this.watches.delete(ticker);
        this.log.info('event watch expired', { ticker });
      }
    }
  }

  status(): PollingStatus {
    this.pruneWatches();
    const nowMs = this.clock.nowMs();

    const pressure = this.meter?.underPressure('x') ?? { pressured: false, reason: 'no meter' };
    const backoff = this.backoffSeconds();

    let state: PollingState;
    let intervalSeconds: number;
    let reason: string;

    if (this.consecutiveRateLimits > 0 || pressure.pressured) {
      state = 'API_PRESSURE';
      intervalSeconds = Math.max(this.ops.xApiPressureIntervalSeconds, backoff);
      reason =
        this.consecutiveRateLimits > 0
          ? `${this.consecutiveRateLimits} consecutive rate limit(s); backing off to ${intervalSeconds}s`
          : pressure.reason;
    } else if (this.watches.size > 0) {
      state = 'EVENT_WATCH';
      intervalSeconds = this.ops.xEventWatchIntervalSeconds;
      reason = `${this.watches.size} security/securities on event watch`;
    } else {
      state = 'NORMAL';
      intervalSeconds = this.ops.xScanIntervalSeconds;
      reason = 'baseline cadence';
    }

    return {
      state,
      intervalSeconds,
      reason,
      watching: [...this.watches.entries()].map(([ticker, until]) => ({
        ticker,
        untilIso: new Date(until).toISOString(),
        minutesLeft: Number(((until - nowMs) / 60_000).toFixed(1)),
      })),
      consecutiveRateLimits: this.consecutiveRateLimits,
      backoffSeconds: backoff,
      nextPollAt: this.nextPollAtMs === null ? null : new Date(this.nextPollAtMs).toISOString(),
    };
  }

  /** Seconds to wait before the next X scan. */
  nextIntervalSeconds(): number {
    if (this.inBackoff()) {
      return Math.max(1, Math.ceil((this.nextPollAtMs! - this.clock.nowMs()) / 1000));
    }
    return this.status().intervalSeconds;
  }

  isWatching(ticker: string): boolean {
    this.pruneWatches();
    return this.watches.has(ticker);
  }
}
