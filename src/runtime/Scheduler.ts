/**
 * Scheduler — three independent loops, three independent cadences.
 *
 * The naive design is one loop that does everything on one interval. It is
 * wrong in both directions at once: fast enough to monitor positions means
 * burning the X budget on scans that return nothing, and slow enough to be
 * polite to X means a stop-loss waits minutes for the next tick.
 *
 * So the work is split by what actually drives it:
 *
 *   X SCAN         adaptive, 120s baseline (60s on event watch, slower under
 *                  API pressure). The only loop that spends X requests, and
 *                  the only loop that can OPEN a position.
 *   POSITION       fixed, 60s. Marks to market, evaluates exits, reconciles
 *                  fills. Costs Tiingo and Alpaca requests, never X.
 *   RECONCILE      fixed, 180s, plus an immediate run after any order event.
 *                  Broker truth vs local truth.
 *
 * One lock across all three. They share a SQLite file and a capital ledger, so
 * overlapping runs would interleave reservations and marks. Concurrency here
 * would buy nothing — none of these are long — and would cost correctness.
 *
 * A loop that is starved because another overran does not "catch up" by firing
 * repeatedly: each loop asks for its next run relative to when it finished.
 */
import type { Clock, Logger } from '../core/index.js';
import { formatUsd } from '../core/index.js';
import type { OperationsConfig } from '../config/operations.js';
import type { ApiMeter } from './ApiMeter.js';
import type { PollingPolicy } from './PollingPolicy.js';
import type { CycleReport, MonitorReport, StrategyRunner } from './StrategyRunner.js';
import type { ReconciliationService } from './Reconciliation.js';
import type { SessionWatch } from './SessionWatch.js';

export type SchedulerTask = 'X_SCAN' | 'POSITION_MONITOR' | 'RECONCILE';

export interface SchedulerEvent {
  task: SchedulerTask;
  at: string;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface SchedulerOptions {
  runner: StrategyRunner;
  reconciliation: ReconciliationService;
  polling: PollingPolicy;
  meter: ApiMeter;
  ops: OperationsConfig;
  clock: Clock;
  logger: Logger;
  /** Watches for the open and the close. Optional in tests and replay. */
  session?: SessionWatch | null;
  /** Records the session's configuration when the run starts. */
  onStart?: () => void;
  /** Called after every task, for the CLI line and the dashboard. */
  onEvent?: (event: SchedulerEvent) => void;
  /** Stop after this many X scans. Used by tests and `--cycles`. */
  maxScans?: number;
}

interface StartOptions {
  /** Overrides `maxScans` for this run. */
  maxScans?: number;
}

export interface SchedulerStatus {
  running: boolean;
  startedAt: string | null;
  scans: number;
  monitors: number;
  reconciliations: number;
  lastScanAt: string | null;
  lastMonitorAt: string | null;
  lastReconcileAt: string | null;
  nextScanInSeconds: number | null;
  polling: ReturnType<PollingPolicy['status']>;
  session: ReturnType<SessionWatch['status']> | null;
}

export class Scheduler {
  private readonly o: SchedulerOptions;
  private readonly log: Logger;

  private running = false;
  private startedAt: string | null = null;
  private stopRequested = false;

  private scans = 0;
  /** Effective scan bound for the current run. */
  private scanLimit: number | undefined;
  private monitors = 0;
  private reconciliations = 0;
  private lastScanAt: string | null = null;
  private lastMonitorAt: string | null = null;
  private lastReconcileAt: string | null = null;

  /** The shared lock. See the header: correctness over concurrency. */
  private busy: Promise<void> = Promise.resolve();
  private timers = new Set<NodeJS.Timeout>();
  /** Resolve pending waits on stop, so a Ctrl-C is not held by a 3-minute sleep. */
  private resolvers = new Map<NodeJS.Timeout, () => void>();

  constructor(opts: SchedulerOptions) {
    this.o = opts;
    this.log = opts.logger.child('scheduler');
  }

  /** Serialise a task behind the lock, whatever loop asked for it. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.busy.then(task, task);
    // The lock must survive a failing task, or one error would deadlock every
    // loop behind it.
    this.busy = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private emit(task: SchedulerTask, summary: string, detail?: Record<string, unknown>): void {
    const event: SchedulerEvent = { task, at: this.o.clock.nowIso(), summary, ...(detail ? { detail } : {}) };
    this.o.onEvent?.(event);
  }

  /**
   * Sleep until the next run, cancellably.
   *
   * The timer is deliberately NOT unref'd. `npm run paper` has nothing else
   * holding the event loop open, so an unref'd timer would let the process
   * exit the moment the first scan finished — a bot that quietly stops after
   * one cycle. Ctrl-C is handled by `stop()`, which clears these timers and
   * resolves the waits, so the process still exits promptly when asked.
   */
  private wait(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, Math.max(1, seconds) * 1000);
      this.timers.add(timer);
      this.resolvers.set(timer, resolve);
    });
  }

  /* ----------------------------------------------------------- the loops */

  private async xScanLoop(): Promise<void> {
    while (!this.stopRequested) {
      if (this.scanLimit !== undefined && this.scans >= this.scanLimit) return;

      const report = await this.run(() => this.scanOnce());
      if (report) {
        // An order event makes the broker's state stale immediately; do not
        // wait up to three minutes to find out what happened to it.
        if (report.ordersSubmitted > 0 || report.exitsTriggered.length > 0) {
          await this.run(() => this.reconcileOnce('after order event'));
        }
      }

      if (this.stopRequested) return;
      if (this.scanLimit !== undefined && this.scans >= this.scanLimit) return;

      const seconds = this.o.polling.nextIntervalSeconds();
      this.log.debug('next X scan', { seconds, state: this.o.polling.status().state });
      await this.wait(seconds);
    }
  }

  private async positionLoop(): Promise<void> {
    while (!this.stopRequested) {
      await this.wait(this.o.ops.positionMonitorIntervalSeconds);
      if (this.stopRequested) return;
      await this.run(() => this.monitorOnce());
    }
  }

  private async reconcileLoop(): Promise<void> {
    while (!this.stopRequested) {
      await this.wait(this.o.ops.reconciliationIntervalSeconds);
      if (this.stopRequested) return;
      await this.run(() => this.reconcileOnce('scheduled'));
    }
  }

  /* ------------------------------------------------------------- tasks */

  private async scanOnce(): Promise<CycleReport | null> {
    this.scans += 1;
    try {
      // Checked before the scan, not after: a scan that straddles the open
      // should be priced on session data, not on the pre-market cache.
      const transition = await this.o.session?.tick();
      if (transition) {
        this.emit('X_SCAN', `market ${transition.from} → ${transition.to}`, { ...transition });
      }

      const report = await this.o.runner.runCycle();
      this.lastScanAt = report.finishedAt;

      // A scan that completed without a rate limit clears the backoff ladder.
      // Only a scan: a successful Tiingo call says nothing about X headroom.
      if (!report.errors.some((e) => e.toLowerCase().includes('rate limit'))) {
        this.o.polling.recordSuccess();
      }

      this.emit(
        'X_SCAN',
        `${report.postsReceived} posts (${report.ingested} new), ${report.signalsGenerated} signals, ` +
          `${report.proposalsCreated} proposals, ${report.ordersSubmitted} orders, ` +
          `equity ${formatUsd(report.equityCents)}` +
          (report.halted ? ` — HALTED: ${report.haltReason}` : ''),
        {
          xRequests: report.xRequests,
          ingested: report.ingested,
          signals: report.signalsGenerated,
          proposals: report.proposalsCreated,
          orders: report.ordersSubmitted,
          pollingState: this.o.polling.status().state,
        },
      );
      return report;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      // A rate limit reaches the scheduler as a failed cycle; translate it into
      // real backoff rather than retrying at the same cadence.
      const retryAfter = rateLimitRetrySeconds(e);
      if (retryAfter !== null) this.o.polling.recordRateLimit(retryAfter);
      this.log.error('X scan failed', { detail });
      this.emit('X_SCAN', `scan failed: ${detail}`);
      return null;
    }
  }

  private async monitorOnce(): Promise<MonitorReport | null> {
    this.monitors += 1;
    try {
      // The position loop also ticks the session watch, so the end-of-day
      // report still fires on a day the X scan is backing off.
      await this.o.session?.tick();

      const report = await this.o.runner.monitorPositions();
      this.lastMonitorAt = report.finishedAt;
      this.emit(
        'POSITION_MONITOR',
        `${report.openPositions} open, equity ${formatUsd(report.equityCents)}` +
          (report.exitsTriggered.length > 0
            ? `, exits: ${report.exitsTriggered.map((x) => `${x.ticker}/${x.reason}`).join(', ')}`
            : '') +
          (report.strategyBreach ? ` — RISK BREACH: ${report.strategyBreach}` : ''),
        { openPositions: report.openPositions, exits: report.exitsTriggered.length },
      );
      return report;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.log.error('position monitor failed', { detail });
      this.emit('POSITION_MONITOR', `monitor failed: ${detail}`);
      return null;
    }
  }

  private async reconcileOnce(trigger: string): Promise<void> {
    this.reconciliations += 1;
    try {
      const result = await this.o.reconciliation.reconcile();
      this.lastReconcileAt = this.o.clock.nowIso();
      const drift = result.discrepancies.length;
      this.emit('RECONCILE', `${trigger}: ${drift === 0 ? 'in sync' : `${drift} discrepancy/ies`}`, {
        trigger,
        discrepancies: drift,
      });
      if (drift > 0) {
        this.log.warn('reconciliation found drift', {
          trigger,
          discrepancies: result.discrepancies.map((d) => d.detail),
        });
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      this.log.error('reconciliation failed', { trigger, detail });
      this.emit('RECONCILE', `${trigger}: failed — ${detail}`);
    }
  }

  /* ------------------------------------------------------------ control */

  /** Run all three loops until `stop()` or the scan bound is reached. */
  async start(opts: StartOptions = {}): Promise<void> {
    if (this.running) throw new Error('Scheduler is already running.');
    this.running = true;
    this.stopRequested = false;
    this.startedAt = this.o.clock.nowIso();
    this.scanLimit = opts.maxScans ?? this.o.maxScans;

    this.o.session?.prime();
    // Before the first scan: what configuration produced everything that
    // follows, written where it survives the process.
    this.o.onStart?.();

    this.log.info('scheduler started', {
      xScanSeconds: this.o.ops.xScanIntervalSeconds,
      positionMonitorSeconds: this.o.ops.positionMonitorIntervalSeconds,
      reconcileSeconds: this.o.ops.reconciliationIntervalSeconds,
    });

    try {
      // The X scan loop decides when the run ends; the other two are support
      // loops and are torn down with it.
      await this.xScanLoop();
    } finally {
      this.stopRequested = true;
      this.cancelWaits();
      // Let any task already past the lock finish its database work.
      await this.busy;
      this.running = false;
      this.log.info('scheduler stopped', {
        scans: this.scans,
        monitors: this.monitors,
        reconciliations: this.reconciliations,
      });
    }
  }

  /** Start the support loops alongside `start()`. */
  startSupportLoops(): void {
    void this.positionLoop();
    void this.reconcileLoop();
  }

  stop(): void {
    this.stopRequested = true;
    this.cancelWaits();
  }

  private cancelWaits(): void {
    for (const timer of this.timers) {
      clearTimeout(timer);
      this.resolvers.get(timer)?.();
    }
    this.timers.clear();
    this.resolvers.clear();
  }

  status(): SchedulerStatus {
    return {
      running: this.running,
      startedAt: this.startedAt,
      scans: this.scans,
      monitors: this.monitors,
      reconciliations: this.reconciliations,
      lastScanAt: this.lastScanAt,
      lastMonitorAt: this.lastMonitorAt,
      lastReconcileAt: this.lastReconcileAt,
      nextScanInSeconds: this.running ? this.o.polling.nextIntervalSeconds() : null,
      polling: this.o.polling.status(),
      session: this.o.session?.status() ?? null,
    };
  }

  /** Run exactly one of each task. Used by tests and by `northstar cycle`. */
  async runOnce(): Promise<void> {
    await this.run(() => this.scanOnce());
    await this.run(() => this.monitorOnce());
    await this.run(() => this.reconcileOnce('manual'));
  }
}

/**
 * Pull a Retry-After out of whatever the provider threw.
 *
 * Deliberately structural rather than string-matching a message: the provider
 * errors carry `kind` and `retryAfterSeconds`, and a message that merely
 * mentions a rate limit is not evidence of one.
 */
function rateLimitRetrySeconds(e: unknown): number | null {
  if (typeof e !== 'object' || e === null) return null;
  const kind = (e as { kind?: unknown }).kind;
  if (kind !== 'RATE_LIMIT') return null;
  const retry = (e as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return typeof retry === 'number' ? retry : 0;
}
