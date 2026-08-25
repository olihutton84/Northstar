/**
 * Risk engine.
 *
 * Runs independently of the signal layer and has final authority: a signal of
 * +100 with a failing risk check produces no order. The engine takes a
 * TradeProposal plus the current world state and returns a RiskDecision listing
 * every check, passed or failed, so a rejection is as explainable as a signal.
 *
 * It never reads the signal engine's internals — only the proposal and the
 * numbers on the signal record. That separation is the point: if the signal
 * engine has a bug, risk still holds.
 */
import type { Clock, Logger } from '../core/index.js';
import type { Cents } from '../core/index.js';
import { formatUsd, randomId } from '../core/index.js';
import type {
  MarketCalendarStatus,
  Position,
  RiskCheckId,
  RiskCheckResult,
  RiskDecision,
  RiskLimits,
  Strategy,
  TradeProposal,
  XSignal,
} from '../domain/types.js';
import type { Store } from '../persistence/store.js';
import type { UniverseRegistry } from '../universe/UniverseRegistry.js';
import type { CapitalLedgerService } from './ledger.js';

export interface RiskContext {
  strategy: Strategy;
  signal: XSignal;
  marketStatus: MarketCalendarStatus;
  /** Age of the price used by the proposal, in minutes. */
  marketDataAgeMinutes: number;
  marketDataStale: boolean;
  openPositions: Position[];
  /** Provider health: false pauses new orders regardless of the signal. */
  providersHealthy: boolean;
  providerHealthDetail: string;
  /** Overrides the calendar when the broker is authoritative (paper/live). */
  brokerReportsMarketOpen?: boolean | null;
}

export class RiskEngine {
  private readonly log: Logger;

  constructor(
    private readonly store: Store,
    private readonly universe: UniverseRegistry,
    private readonly ledger: CapitalLedgerService,
    private readonly clock: Clock,
    logger: Logger,
  ) {
    this.log = logger.child('risk');
  }

  evaluate(proposal: TradeProposal, ctx: RiskContext): RiskDecision {
    const limits = ctx.strategy.riskLimits;
    const checks: RiskCheckResult[] = [];
    const add = (
      check: RiskCheckId,
      passed: boolean,
      detail: string,
      observed?: number,
      limit?: number,
    ): void => {
      const result: RiskCheckResult = { check, passed, detail };
      if (observed !== undefined) result.observed = Number(observed.toFixed(4));
      if (limit !== undefined) result.limit = Number(limit.toFixed(4));
      checks.push(result);
    };

    /* ------------------------------------------------ operational gates */

    add(
      'KILL_SWITCH',
      ctx.strategy.runState !== 'KILLED',
      ctx.strategy.runState === 'KILLED'
        ? `Kill switch engaged: ${ctx.strategy.haltReason ?? 'no reason recorded'}`
        : 'Kill switch not engaged',
    );

    add(
      'STRATEGY_STATUS',
      ctx.strategy.runState === 'RUNNING' && ctx.strategy.status !== 'RETIRED',
      ctx.strategy.runState === 'RUNNING' && ctx.strategy.status !== 'RETIRED'
        ? `Strategy is ${ctx.strategy.status} and running`
        : `Strategy is ${ctx.strategy.status}/${ctx.strategy.runState}${ctx.strategy.haltReason ? `: ${ctx.strategy.haltReason}` : ''}`,
    );

    add(
      'PROVIDER_HEALTH',
      ctx.providersHealthy,
      ctx.providersHealthy ? 'All providers healthy' : `Provider fault: ${ctx.providerHealthDetail}`,
    );

    /* -------------------------------------------------- universe checks */

    const security = this.universe.byIdOrNull(proposal.securityId);
    const inUniverse = this.universe.isEligible(proposal.securityId, ctx.strategy.universeSources);
    add(
      'UNIVERSE_MEMBERSHIP',
      inUniverse,
      inUniverse
        ? `${proposal.ticker} is in the permitted universe`
        : `${proposal.ticker} is outside the strategy's permitted universe`,
    );

    add(
      'ALPACA_TRADABLE',
      security?.alpacaTradable === true,
      security?.alpacaTradable === true
        ? `${proposal.ticker} is tradable at the broker`
        : `${proposal.ticker} is not tradable at the broker`,
    );

    /* ------------------------------------------------- direction limits */

    const directionOk =
      proposal.direction === 'LONG' &&
      proposal.side === 'BUY' &&
      !limits.allowShorting &&
      !limits.allowOptions &&
      !limits.allowMargin &&
      !limits.allowLeverage;
    add(
      'DIRECTION_ALLOWED',
      directionOk,
      directionOk
        ? 'Long-only cash equity order'
        : 'Order violates the long-only, no-margin, no-options, no-leverage mandate',
    );

    add(
      'NO_LEVERAGE',
      !limits.allowLeverage && !limits.allowMargin,
      'Leverage and margin are disabled for this strategy',
    );

    /* --------------------------------------------------- signal quality */

    const scoreOk = Math.abs(ctx.signal.score) >= limits.minSignalScore;
    add(
      'SIGNAL_THRESHOLD',
      scoreOk,
      scoreOk
        ? `Signal ${ctx.signal.score} clears the ${limits.minSignalScore} threshold`
        : `Signal ${ctx.signal.score} is below the ${limits.minSignalScore} threshold`,
      Math.abs(ctx.signal.score),
      limits.minSignalScore,
    );

    const uncertaintyOk = ctx.signal.uncertainty <= limits.maxSignalUncertainty;
    add(
      'SIGNAL_UNCERTAINTY',
      uncertaintyOk,
      uncertaintyOk
        ? `Uncertainty ${(ctx.signal.uncertainty * 100).toFixed(0)}% is within the ${(limits.maxSignalUncertainty * 100).toFixed(0)}% limit`
        : `Uncertainty ${(ctx.signal.uncertainty * 100).toFixed(0)}% exceeds the ${(limits.maxSignalUncertainty * 100).toFixed(0)}% limit`,
      ctx.signal.uncertainty,
      limits.maxSignalUncertainty,
    );

    const resolutionOk = ctx.signal.resolutionConfidence >= limits.minResolutionConfidence;
    add(
      'RESOLUTION_CONFIDENCE',
      resolutionOk,
      resolutionOk
        ? `Entity resolution ${(ctx.signal.resolutionConfidence * 100).toFixed(0)}% confident`
        : `Entity resolution only ${(ctx.signal.resolutionConfidence * 100).toFixed(0)}% confident — below the ${(limits.minResolutionConfidence * 100).toFixed(0)}% floor`,
      ctx.signal.resolutionConfidence,
      limits.minResolutionConfidence,
    );

    const sourcesOk = ctx.signal.independentSourceCount >= limits.minIndependentSources;
    add(
      'INDEPENDENT_SOURCES',
      sourcesOk,
      sourcesOk
        ? `${ctx.signal.independentSourceCount.toFixed(2)} tier-weighted independent sources`
        : `Only ${ctx.signal.independentSourceCount.toFixed(2)} tier-weighted independent sources (minimum ${limits.minIndependentSources})`,
      ctx.signal.independentSourceCount,
      limits.minIndependentSources,
    );

    /* ----------------------------------------------------- market state */

    const freshnessOk = !ctx.marketDataStale && ctx.marketDataAgeMinutes <= limits.maxMarketDataAgeMinutes;
    add(
      'MARKET_DATA_FRESHNESS',
      freshnessOk,
      freshnessOk
        ? `Market data is ${ctx.marketDataAgeMinutes.toFixed(1)} minutes old`
        : `Market data is ${ctx.marketDataAgeMinutes.toFixed(1)} minutes old — stale beyond the ${limits.maxMarketDataAgeMinutes} minute limit`,
      ctx.marketDataAgeMinutes,
      limits.maxMarketDataAgeMinutes,
    );

    const marketOpen = ctx.brokerReportsMarketOpen ?? ctx.marketStatus.isOpen;
    const hoursOk = !limits.requireMarketOpen || marketOpen;
    add(
      'MARKET_HOURS',
      hoursOk,
      hoursOk ? `Market is open (${ctx.marketStatus.reason})` : `Market is closed (${ctx.marketStatus.reason})`,
    );

    /* -------------------------------------------------- portfolio state */

    const existing = ctx.openPositions.filter((p) => p.securityId === proposal.securityId);
    const pendingProposals = this.store.proposals
      .openForSecurity(proposal.strategyId, proposal.securityId)
      .filter((p) => p.proposalId !== proposal.proposalId);
    const duplicateExposure = existing.length > 0 || pendingProposals.length > 0;
    add(
      'DUPLICATE_EXPOSURE',
      !duplicateExposure,
      duplicateExposure
        ? `Already exposed to ${proposal.ticker}: ${existing.length} open position(s), ${pendingProposals.length} live proposal(s)`
        : `No existing exposure to ${proposal.ticker}`,
    );

    const duplicateOrder = this.store.orders
      .byProposal(proposal.proposalId)
      .some((o) => o.status !== 'REJECTED' && o.status !== 'CANCELLED');
    add(
      'DUPLICATE_ORDER',
      !duplicateOrder,
      duplicateOrder ? 'An order already exists for this proposal' : 'No prior order for this proposal',
    );

    const positionsOk = ctx.openPositions.length < limits.maxConcurrentPositions;
    add(
      'MAX_CONCURRENT_POSITIONS',
      positionsOk,
      positionsOk
        ? `${ctx.openPositions.length} of ${limits.maxConcurrentPositions} position slots used`
        : `All ${limits.maxConcurrentPositions} position slots are in use`,
      ctx.openPositions.length,
      limits.maxConcurrentPositions,
    );

    /* ------------------------------------------------------- capital */

    const ledger = this.ledger.get();
    const available = this.ledger.availableCents();
    const maxPositionCents = Math.floor((ledger.equityCents * limits.maxPositionPctOfEquity) / 100);

    // Risk may permit LESS than proposed, never more.
    let permittedCapitalCents: Cents = Math.min(proposal.proposedCapitalCents, maxPositionCents, available);
    if (permittedCapitalCents < 0) permittedCapitalCents = 0;

    const sizeOk = proposal.proposedCapitalCents <= maxPositionCents;
    add(
      'MAX_POSITION_SIZE',
      sizeOk,
      sizeOk
        ? `${formatUsd(proposal.proposedCapitalCents)} is within the ${limits.maxPositionPctOfEquity}% position cap (${formatUsd(maxPositionCents)})`
        : `${formatUsd(proposal.proposedCapitalCents)} exceeds the ${limits.maxPositionPctOfEquity}% position cap (${formatUsd(maxPositionCents)})`,
      proposal.proposedCapitalCents,
      maxPositionCents,
    );

    const cashOk = permittedCapitalCents > 0 && proposal.proposedCapitalCents <= available;
    add(
      'AVAILABLE_CASH',
      cashOk,
      cashOk
        ? `${formatUsd(available)} of strategy capital available`
        : `Insufficient strategy capital: ${formatUsd(available)} available, ${formatUsd(proposal.proposedCapitalCents)} requested`,
      available,
      proposal.proposedCapitalCents,
    );

    const minOk = permittedCapitalCents >= limits.minOrderCents;
    add(
      'MIN_ORDER_SIZE',
      minOk,
      minOk
        ? `Order size ${formatUsd(permittedCapitalCents)} meets the minimum`
        : `Order size ${formatUsd(permittedCapitalCents)} is below the ${formatUsd(limits.minOrderCents)} minimum`,
      permittedCapitalCents,
      limits.minOrderCents,
    );

    /* --------------------------------------------------- loss controls */

    const dailyLoss = this.ledger.dailyLossPct();
    const dailyOk = dailyLoss < limits.maxDailyLossPct;
    add(
      'DAILY_LOSS_LIMIT',
      dailyOk,
      dailyOk
        ? `Down ${dailyLoss.toFixed(2)}% today, within the ${limits.maxDailyLossPct}% limit`
        : `Daily loss ${dailyLoss.toFixed(2)}% has breached the ${limits.maxDailyLossPct}% limit — no new risk today`,
      dailyLoss,
      limits.maxDailyLossPct,
    );

    const drawdown = this.ledger.drawdownPct();
    const drawdownOk = drawdown < limits.maxDrawdownPct;
    add(
      'MAX_DRAWDOWN',
      drawdownOk,
      drawdownOk
        ? `Drawdown ${drawdown.toFixed(2)}% is within the ${limits.maxDrawdownPct}% limit`
        : `Drawdown ${drawdown.toFixed(2)}% has breached the ${limits.maxDrawdownPct}% limit`,
      drawdown,
      limits.maxDrawdownPct,
    );

    /* ------------------------------------------------ ledger integrity */

    const integrity = this.ledger.verifyIntegrity();
    add('LEDGER_INTEGRITY', integrity.ok, integrity.detail);

    /* --------------------------------------------------------- verdict */

    const failed = checks.filter((c) => !c.passed).map((c) => c.check);
    const approved = failed.length === 0;

    const quantity = approved
      ? proposal.fractional
        ? Math.floor((permittedCapitalCents / 100 / proposal.referencePrice) * 1e6) / 1e6
        : Math.floor(permittedCapitalCents / 100 / proposal.referencePrice)
      : 0;

    const decision: RiskDecision = {
      riskDecisionId: randomId('risk'),
      proposalId: proposal.proposalId,
      strategyId: proposal.strategyId,
      approved,
      checks,
      failedChecks: failed,
      permittedCapitalCents: approved ? permittedCapitalCents : 0,
      permittedQuantity: quantity,
      decidedAt: this.clock.nowIso(),
      summary: approved
        ? `Approved ${formatUsd(permittedCapitalCents)} of ${proposal.ticker} (${checks.length} checks passed)`
        : `Rejected: ${failed.join(', ')}`,
    };

    if (!approved) {
      this.log.info('risk rejected proposal', {
        proposalId: proposal.proposalId,
        ticker: proposal.ticker,
        failed,
      });
    }

    return decision;
  }

  /**
   * Strategy-level circuit breaker, evaluated independently of any proposal.
   * Used by the runner to decide whether to keep trading at all.
   */
  strategyBreach(limits: RiskLimits): { breached: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const dailyLoss = this.ledger.dailyLossPct();
    const drawdown = this.ledger.drawdownPct();

    if (dailyLoss >= limits.maxDailyLossPct) {
      reasons.push(`Daily loss ${dailyLoss.toFixed(2)}% >= limit ${limits.maxDailyLossPct}%`);
    }
    if (drawdown >= limits.maxDrawdownPct) {
      reasons.push(`Drawdown ${drawdown.toFixed(2)}% >= limit ${limits.maxDrawdownPct}%`);
    }
    const integrity = this.ledger.verifyIntegrity();
    if (!integrity.ok) reasons.push(integrity.detail);

    return { breached: reasons.length > 0, reasons };
  }
}
