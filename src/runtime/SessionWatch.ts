/**
 * Session transitions.
 *
 * The bot is expected to be started BEFORE the open — that is the safe way to
 * start it, since nothing about ingesting posts or scoring signals requires an
 * open market, and starting at 09:30 means the first minutes of the session are
 * spent warming up instead of watching.
 *
 * Two moments then need handling, and both are about correctness rather than
 * opportunity:
 *
 *   OPEN   Prices gathered pre-market are, by definition, not session prices.
 *          Cached quotes are dropped and providers re-checked, so the first
 *          trade of the day is priced on session data rather than on a stale
 *          pre-market mark that happened to be inside the cache TTL.
 *
 *   CLOSE  The day's report is emitted once, automatically. A report that only
 *          exists if someone remembers to run a command is a report that does
 *          not exist on the day it matters.
 *
 * The watcher is edge-triggered off the local calendar and holds no timers of
 * its own: it is polled by the loops that are already running, so it cannot
 * drift from what the rest of the bot believes the time to be.
 */
import type { Clock, Logger } from '../core/index.js';
import type { OperationsConfig } from '../config/operations.js';
import { marketStatus } from '../providers/marketdata/marketCalendar.js';

export type SessionPhase = 'PRE_MARKET' | 'OPEN' | 'AFTER_HOURS' | 'CLOSED';

export interface SessionTransition {
  from: SessionPhase;
  to: SessionPhase;
  at: string;
}

export interface SessionWatchOptions {
  clock: Clock;
  logger: Logger;
  ops: OperationsConfig;
  /** Invalidate cached market data at the open. */
  onOpen?: () => void | Promise<void>;
  /** Emit the day's report, once, after the close. */
  onEndOfDay?: (day: string) => void | Promise<void>;
}

export function phaseFor(clock: Clock): SessionPhase {
  const status = marketStatus(clock);
  if (status.isOpen) return 'OPEN';
  if (status.reason === 'Pre-market') return 'PRE_MARKET';
  if (status.reason === 'After hours') return 'AFTER_HOURS';
  return 'CLOSED';
}

export class SessionWatch {
  private readonly log: Logger;
  private phase: SessionPhase | null = null;
  private closedAtMs: number | null = null;
  private reportedDays = new Set<string>();

  constructor(private readonly o: SessionWatchOptions) {
    this.log = o.logger.child('session');
  }

  /** The phase at construction time, so a start mid-session is not a transition. */
  prime(): SessionPhase {
    this.phase = phaseFor(this.o.clock);
    const status = marketStatus(this.o.clock);
    this.log.info('session phase at start', {
      phase: this.phase,
      reason: status.reason,
      nextOpen: status.nextOpen,
      nextClose: status.nextClose,
    });
    // Starting after the close should not immediately fire yesterday's report.
    if (this.phase === 'AFTER_HOURS' || this.phase === 'CLOSED') {
      this.reportedDays.add(this.o.clock.nowIso().slice(0, 10));
    }
    return this.phase;
  }

  /**
   * Poll for a transition. Safe and cheap to call from any loop.
   *
   * Returns the transition when one happened, so a caller can log it; the side
   * effects are dispatched here rather than left to the caller, because a
   * caller that forgot to act on the return value would silently skip the
   * open-time cache invalidation.
   */
  async tick(): Promise<SessionTransition | null> {
    const now = phaseFor(this.o.clock);
    const previous = this.phase ?? this.prime();

    let transition: SessionTransition | null = null;
    if (now !== previous) {
      transition = { from: previous, to: now, at: this.o.clock.nowIso() };
      this.phase = now;
      this.log.info('session phase changed', { ...transition });

      if (now === 'OPEN') {
        // Pre-market marks are not session marks. Drop them rather than let a
        // 45-second cache TTL carry one across the open.
        this.log.info('market open: invalidating pre-market price cache');
        await this.o.onOpen?.();
      }

      if (previous === 'OPEN') {
        this.closedAtMs = this.o.clock.nowMs();
      }
    }

    await this.maybeReport();
    return transition;
  }

  /**
   * Emit the end-of-day report once, a short delay after the close.
   *
   * The delay exists so late fills and the final reconciliation land first —
   * a report written at 16:00:00 exactly would miss them.
   */
  private async maybeReport(): Promise<void> {
    if (this.closedAtMs === null) return;

    const day = new Date(this.closedAtMs).toISOString().slice(0, 10);
    if (this.reportedDays.has(day)) return;

    const minutesSinceClose = (this.o.clock.nowMs() - this.closedAtMs) / 60_000;
    if (minutesSinceClose < this.o.ops.endOfDayReportDelayMinutes) return;

    this.reportedDays.add(day);
    this.log.info('emitting end-of-day report', { day, minutesSinceClose: Number(minutesSinceClose.toFixed(1)) });
    await this.o.onEndOfDay?.(day);
  }

  status(): { phase: SessionPhase; reason: string; nextOpen: string | null; nextClose: string | null } {
    const status = marketStatus(this.o.clock);
    return {
      phase: this.phase ?? phaseFor(this.o.clock),
      reason: status.reason,
      nextOpen: status.nextOpen,
      nextClose: status.nextClose,
    };
  }
}
