/**
 * Health guard and kill switch.
 *
 * Two jobs:
 *
 *   1. KILL BOT — an operator control that stops the strategy producing
 *      executable proposals, cancels resting orders where safe, and preserves
 *      every log. It does NOT liquidate positions unless liquidation is
 *      separately and explicitly confirmed.
 *
 *   2. Automatic pause on faults the strategy cannot safely trade through:
 *      stale market data, broker auth failure, repeated API failures, social
 *      provider failure beyond tolerance, corrupt strategy state, and capital
 *      ledger mismatch.
 *
 * A paused strategy keeps ingesting, scoring and recording — it just stops
 * committing capital. Blindness is worse than inaction.
 */
import type { Clock, Logger } from '../core/index.js';
import { randomId } from '../core/index.js';
import type { HealthFault, HealthIncident, Strategy } from '../domain/types.js';
import type { Store } from '../persistence/store.js';

export interface CircuitBreakerConfig {
  /** Consecutive failures per provider before the strategy pauses. */
  socialFailureTolerance: number;
  brokerFailureTolerance: number;
  marketDataFailureTolerance: number;
}

export const DEFAULT_BREAKER_CONFIG: CircuitBreakerConfig = {
  socialFailureTolerance: 3,
  brokerFailureTolerance: 3,
  marketDataFailureTolerance: 5,
};

export type ProviderKey = 'social' | 'broker' | 'marketData';

export interface HealthState {
  runState: Strategy['runState'];
  paused: boolean;
  killed: boolean;
  haltReason: string | null;
  openIncidents: HealthIncident[];
  failureCounts: Record<ProviderKey, number>;
  /**
   * When each provider last succeeded, since this process started.
   *
   * In-process by design: it answers "is the thing running right now still
   * talking to its vendors", which is what an operator watching a live paper
   * run needs. Facts that must survive a restart live in the database.
   */
  lastSuccessAt: Record<ProviderKey, string | null>;
  lastFailureAt: Record<ProviderKey, string | null>;
  lastFailureDetail: Record<ProviderKey, string | null>;
  startedAt: string;
  /** Whether kill-switch liquidation was explicitly confirmed. */
  liquidateOnKill: boolean;
}

export class HealthGuard {
  private readonly log: Logger;
  private readonly failures: Record<ProviderKey, number> = { social: 0, broker: 0, marketData: 0 };
  private readonly lastSuccess: Record<ProviderKey, string | null> = { social: null, broker: null, marketData: null };
  private readonly lastFailure: Record<ProviderKey, string | null> = { social: null, broker: null, marketData: null };
  private readonly lastFailureDetail: Record<ProviderKey, string | null> = { social: null, broker: null, marketData: null };
  private readonly startedAt: string;
  private liquidateOnKill = false;

  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
    logger: Logger,
    private readonly strategyId: string,
    /** The execution epoch whose ledger this guard checks. */
    private readonly epochId: string,
    private readonly config: CircuitBreakerConfig = DEFAULT_BREAKER_CONFIG,
  ) {
    this.log = logger.child('health');
    this.startedAt = clock.nowIso();
  }

  /* ------------------------------------------------------- kill switch */

  /**
   * Engage the kill switch.
   *
   * `liquidate` defaults to false. Liquidation is a separate, explicit choice
   * because dumping positions into a thin market is itself a way to lose money.
   */
  kill(reason: string, liquidate = false): Strategy {
    const strategy = this.strategy();
    this.liquidateOnKill = liquidate;
    const at = this.clock.nowIso();

    const updated: Strategy = {
      ...strategy,
      runState: 'KILLED',
      haltReason: reason,
      haltedAt: at,
      updatedAt: at,
    };
    this.store.strategies.upsert(updated);
    this.recordIncident('MANUAL_KILL', reason, true);

    this.store.log.append({
      correlationId: randomId('kill'),
      strategyId: this.strategyId,
      stage: 'SYSTEM',
      subjectId: this.strategyId,
      summary: `KILL BOT engaged: ${reason}`,
      payload: { reason, liquidate, at },
    });
    this.log.error('KILL BOT engaged', { reason, liquidate });
    return updated;
  }

  /** Resume after a kill or pause. Clears open incidents and failure counts. */
  resume(note: string): Strategy {
    const strategy = this.strategy();
    const at = this.clock.nowIso();
    this.liquidateOnKill = false;
    this.failures.social = 0;
    this.failures.broker = 0;
    this.failures.marketData = 0;
    this.store.incidents.resolveAll(this.strategyId, at);

    const updated: Strategy = {
      ...strategy,
      runState: 'RUNNING',
      haltReason: null,
      haltedAt: null,
      updatedAt: at,
    };
    this.store.strategies.upsert(updated);
    this.store.log.append({
      correlationId: randomId('resume'),
      strategyId: this.strategyId,
      stage: 'SYSTEM',
      subjectId: this.strategyId,
      summary: `Strategy resumed: ${note}`,
      payload: { note, at },
    });
    this.log.info('strategy resumed', { note });
    return updated;
  }

  /* ------------------------------------------------------------- pause */

  /**
   * Operator pause: stop opening positions, keep managing the open ones.
   *
   * Deliberately NOT a stop. Exits, stop-losses, fills and reconciliation all
   * continue, because a position the bot has stopped watching is more dangerous
   * than one it is still managing. This only closes the front door.
   *
   * A killed strategy stays killed: pausing is a lesser state and must not
   * quietly downgrade an emergency stop.
   */
  pauseByOperator(reason: string): Strategy {
    return this.pause('MANUAL_PAUSE', reason);
  }

  pause(fault: HealthFault, detail: string): Strategy {
    const strategy = this.strategy();
    if (strategy.runState === 'KILLED') return strategy;

    const at = this.clock.nowIso();
    const updated: Strategy = {
      ...strategy,
      runState: 'PAUSED',
      haltReason: `${fault}: ${detail}`,
      haltedAt: at,
      updatedAt: at,
    };
    this.store.strategies.upsert(updated);
    this.recordIncident(fault, detail, true);
    // An operator choosing to pause is not a fault, and logging it at error
    // level would page someone for a normal control action. A pause the SYSTEM
    // imposed is a fault, and stays at error.
    if (fault === 'MANUAL_PAUSE') this.log.warn('new entries paused by operator', { detail });
    else this.log.error('strategy paused', { fault, detail });

    this.store.log.append({
      correlationId: randomId('pause'),
      strategyId: this.strategyId,
      stage: 'HEALTH',
      subjectId: this.strategyId,
      summary: `Strategy paused: ${fault}`,
      payload: { fault, detail, at },
    });
    return updated;
  }

  /* ------------------------------------------------ provider bookkeeping */

  recordSuccess(provider: ProviderKey): void {
    if (this.failures[provider] > 0) {
      this.log.info('provider recovered', { provider, priorFailures: this.failures[provider] });
      // The recovery closes the outage window. Without a durable record of it,
      // the day's log shows failures beginning and never ending.
      this.record('HEALTH', `${provider} recovered after ${this.failures[provider]} consecutive failure(s)`, {
        provider,
        event: 'RECOVERED',
        priorFailures: this.failures[provider],
        lastFailureAt: this.lastFailure[provider],
      });
    }
    this.failures[provider] = 0;
    this.lastSuccess[provider] = this.clock.nowIso();
  }

  /**
   * Append a durable, timestamped health entry.
   *
   * Provider failures used to leave only a stdout warning and an aggregate
   * counter, so a 429 that did not cross the pause threshold was gone the
   * moment the process restarted, and the day could not be reconstructed
   * afterwards. Every failure and every recovery now lands in the append-only
   * decision log, which is where the rest of the audit trail already lives.
   */
  private record(stage: 'HEALTH', summary: string, payload: Record<string, unknown>): void {
    try {
      this.store.log.append({
        correlationId: randomId('health'),
        strategyId: this.strategyId,
        stage,
        subjectId: String(payload['provider'] ?? this.strategyId),
        summary,
        payload,
      });
    } catch {
      // Telemetry must never be able to take down the trading loop.
    }
  }

  /**
   * Record a provider failure. Returns true when the strategy was paused as a
   * result, so the caller can stop rather than continuing into a broken cycle.
   */
  recordFailure(provider: ProviderKey, detail: string, kind?: string): boolean {
    this.failures[provider] += 1;
    this.lastFailure[provider] = this.clock.nowIso();
    this.lastFailureDetail[provider] = detail;
    const count = this.failures[provider];

    // Recorded before any pause decision, so even a single transient failure
    // that the strategy shrugs off is still on the permanent record.
    this.record('HEALTH', `${provider} failure ${count}: ${detail}`, {
      provider,
      event: 'FAILURE',
      consecutive: count,
      kind: kind ?? 'UNKNOWN',
      detail,
    });

    // Authentication failure is never a transient blip: pause immediately.
    if (kind === 'AUTH') {
      const fault: HealthFault = provider === 'broker' ? 'BROKER_AUTH_FAILURE' : 'REPEATED_API_FAILURE';
      this.pause(fault, `${provider} authentication failed: ${detail}`);
      return true;
    }

    const tolerance =
      provider === 'social'
        ? this.config.socialFailureTolerance
        : provider === 'broker'
          ? this.config.brokerFailureTolerance
          : this.config.marketDataFailureTolerance;

    this.log.warn('provider failure', { provider, count, tolerance, detail });

    if (count >= tolerance) {
      const fault: HealthFault = provider === 'social' ? 'SOCIAL_PROVIDER_FAILURE' : 'REPEATED_API_FAILURE';
      this.pause(fault, `${provider} failed ${count} consecutive times (tolerance ${tolerance}): ${detail}`);
      return true;
    }
    return false;
  }

  /** Pause on stale market data. */
  reportStaleData(ticker: string, ageMinutes: number, limitMinutes: number): void {
    this.pause(
      'STALE_MARKET_DATA',
      `${ticker} price is ${ageMinutes.toFixed(1)} minutes old, beyond the ${limitMinutes} minute limit`,
    );
  }

  reportLedgerMismatch(detail: string): void {
    this.pause('LEDGER_MISMATCH', detail);
  }

  reportCorruptState(detail: string): void {
    this.pause('CORRUPT_STRATEGY_STATE', detail);
  }

  /* -------------------------------------------------------------- state */

  state(): HealthState {
    const strategy = this.strategy();
    return {
      runState: strategy.runState,
      paused: strategy.runState === 'PAUSED',
      killed: strategy.runState === 'KILLED',
      haltReason: strategy.haltReason,
      openIncidents: this.store.incidents.open(this.strategyId),
      failureCounts: { ...this.failures },
      lastSuccessAt: { ...this.lastSuccess },
      lastFailureAt: { ...this.lastFailure },
      lastFailureDetail: { ...this.lastFailureDetail },
      startedAt: this.startedAt,
      liquidateOnKill: this.liquidateOnKill,
    };
  }

  /** May the strategy commit capital right now? */
  canTrade(): boolean {
    return this.strategy().runState === 'RUNNING';
  }

  /**
   * Whether the kill switch should also close positions.
   *
   * Deliberately in-memory: a liquidation instruction does NOT survive a
   * restart. Coming back up and discovering that the process has begun selling
   * on an intent given before the restart is worse than requiring the operator
   * to say so again against the state they can actually see. The KILLED run
   * state itself IS persisted, so a restart still refuses to trade.
   */
  get shouldLiquidate(): boolean {
    return this.liquidateOnKill && this.strategy().runState === 'KILLED';
  }

  /**
   * Validate that the persisted strategy state is coherent. Structural damage
   * (a negative allocation, a position with no entry order, cash exceeding the
   * allocation) means something wrote nonsense, and trading on it is worse than
   * stopping.
   */
  verifyStateIntegrity(): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    const strategy = this.store.strategies.byId(this.strategyId);

    if (!strategy) {
      problems.push('Strategy record is missing');
      return { ok: false, problems };
    }
    if (strategy.allocatedCapitalCents <= 0) problems.push('Allocated capital is zero or negative');

    const ledger = this.store.ledger.get(this.strategyId, this.epochId);
    if (!ledger) {
      problems.push('Capital ledger is missing');
    } else {
      if (ledger.cashCents < 0) problems.push(`Ledger cash is negative (${ledger.cashCents})`);
      if (ledger.reservedCents < 0) problems.push(`Reserved capital is negative (${ledger.reservedCents})`);
      if (ledger.reservedCents > ledger.cashCents) {
        problems.push(`Reserved ${ledger.reservedCents} exceeds cash ${ledger.cashCents}`);
      }
    }

    for (const position of this.store.positions.open(this.strategyId)) {
      if (position.quantity <= 0) problems.push(`Position ${position.positionId} has non-positive quantity`);
      if (!this.store.orders.byId(position.entryOrderId)) {
        problems.push(`Position ${position.positionId} references a missing entry order`);
      }
    }

    return { ok: problems.length === 0, problems };
  }

  private recordIncident(fault: HealthFault, detail: string, paused: boolean): HealthIncident {
    const incident: HealthIncident = {
      incidentId: randomId('inc'),
      strategyId: this.strategyId,
      fault,
      at: this.clock.nowIso(),
      detail,
      paused,
      resolvedAt: null,
      resolutionNote: '',
    };
    this.store.incidents.save(incident);
    return incident;
  }

  private strategy(): Strategy {
    const strategy = this.store.strategies.byId(this.strategyId);
    if (!strategy) throw new Error(`Strategy ${this.strategyId} not found`);
    return strategy;
  }
}
