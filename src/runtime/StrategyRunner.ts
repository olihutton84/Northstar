/**
 * StrategyRunner — one cycle of the X Signal Bot.
 *
 * The cycle, in order:
 *
 *   0. health   — verify state, ledger and providers; pause on faults
 *   1. ingest   — pull X through the SocialDataProvider, persist events
 *   2. filter   — reject noise, cluster duplicates
 *   3. resolve  — map events to Northstar securities with confidence
 *   4. signal   — build explained composite signals
 *   5. mark     — mark positions to market, snapshot equity
 *   6. exit     — evaluate exit rules, submit exits
 *   7. propose  — build trade proposals from qualifying signals
 *   8. risk     — independent risk decision per proposal
 *   9. execute  — PAPER submits automatically; LIVE waits for approval
 *  10. fills    — reconcile orders, open/close positions, update the ledger
 *  11. analytics— register and measure forward returns, refresh survival stats
 *
 * Every stage writes to the decision log, so a trade can be reconstructed from
 * the post that caused it.
 */
import type { Clock, Logger } from '../core/index.js';
import { randomId } from '../core/index.js';
import type { SignalEngineConfig } from '../config/signalConfig.js';
import type { ExitRuleConfig } from '../config/strategyRegistry.js';
import type {
  Quote,
  RiskDecision,
  Strategy,
  TradeProposal,
  XSignal,
} from '../domain/types.js';
import type { Store } from '../persistence/store.js';
import type { BrokerProvider } from '../providers/broker/BrokerProvider.js';
import { BrokerError } from '../providers/broker/BrokerProvider.js';
import type { MarketDataProvider } from '../providers/marketdata/MarketDataProvider.js';
import { MarketDataError } from '../providers/marketdata/MarketDataProvider.js';
import { SocialProviderError } from '../providers/social/SocialDataProvider.js';
import type { UniverseRegistry } from '../universe/UniverseRegistry.js';
import { ForwardReturnService } from '../pipeline/analytics/forwardReturns.js';
import { SurvivalService } from '../pipeline/analytics/survival.js';
import { ExitEngine } from '../pipeline/execution/ExitEngine.js';
import { OrderRouter } from '../pipeline/execution/OrderRouter.js';
import { PositionManager } from '../pipeline/execution/PositionManager.js';
import { PostFilter } from '../pipeline/filtering.js';
import { IngestionService } from '../pipeline/ingestion.js';
import { CapitalLedgerService } from '../pipeline/ledger.js';
import { ProposalBuilder } from '../pipeline/proposal.js';
import { RiskEngine } from '../pipeline/risk.js';
import { XSignalEngine } from '../pipeline/signal/SignalEngine.js';
import { TickerResolver } from '../pipeline/tickerResolution.js';
import type { HealthGuard } from './HealthGuard.js';

export interface StrategyRunnerDeps {
  store: Store;
  universe: UniverseRegistry;
  clock: Clock;
  logger: Logger;
  health: HealthGuard;
  ingestion: IngestionService;
  filter: PostFilter;
  resolver: TickerResolver;
  signalEngine: XSignalEngine;
  proposalBuilder: ProposalBuilder;
  riskEngine: RiskEngine;
  orderRouter: OrderRouter;
  positionManager: PositionManager;
  exitEngine: ExitEngine;
  ledger: CapitalLedgerService;
  forwardReturns: ForwardReturnService;
  survival: SurvivalService;
  marketData: MarketDataProvider;
  broker: BrokerProvider;
  signalConfig: SignalEngineConfig;
  exitRules: ExitRuleConfig;
  strategyId: string;
}

export interface CycleReport {
  correlationId: string;
  startedAt: string;
  finishedAt: string;
  mode: Strategy['mode'];
  runState: Strategy['runState'];
  halted: boolean;
  haltReason: string | null;
  ingested: number;
  filtered: { accepted: number; downweighted: number; rejected: number };
  resolutions: number;
  signalsGenerated: number;
  proposalsCreated: number;
  riskApproved: number;
  riskRejected: number;
  ordersSubmitted: number;
  awaitingApproval: number;
  fillsRecorded: number;
  positionsOpened: number;
  positionsClosed: number;
  exitsTriggered: { ticker: string; reason: string }[];
  equityCents: number;
  errors: string[];
}

export class StrategyRunner {
  private readonly d: StrategyRunnerDeps;
  private readonly log: Logger;

  constructor(deps: StrategyRunnerDeps) {
    this.d = deps;
    this.log = deps.logger.child('runner');
  }

  private strategy(): Strategy {
    const s = this.d.store.strategies.byId(this.d.strategyId);
    if (!s) throw new Error(`Strategy ${this.d.strategyId} not found. Run seed first.`);
    return s;
  }

  async runCycle(): Promise<CycleReport> {
    const correlationId = randomId('cycle');
    const startedAt = this.d.clock.nowIso();
    const report: CycleReport = {
      correlationId,
      startedAt,
      finishedAt: startedAt,
      mode: 'PAPER',
      runState: 'RUNNING',
      halted: false,
      haltReason: null,
      ingested: 0,
      filtered: { accepted: 0, downweighted: 0, rejected: 0 },
      resolutions: 0,
      signalsGenerated: 0,
      proposalsCreated: 0,
      riskApproved: 0,
      riskRejected: 0,
      ordersSubmitted: 0,
      awaitingApproval: 0,
      fillsRecorded: 0,
      positionsOpened: 0,
      positionsClosed: 0,
      exitsTriggered: [],
      equityCents: 0,
      errors: [],
    };

    const strategy = this.strategy();
    report.mode = strategy.mode;
    report.runState = strategy.runState;

    /* ---------------------------------------------------- 0. health --- */
    const integrity = this.d.health.verifyStateIntegrity();
    if (!integrity.ok) {
      this.d.health.reportCorruptState(integrity.problems.join('; '));
      report.halted = true;
      report.haltReason = integrity.problems.join('; ');
      report.runState = 'PAUSED';
      report.finishedAt = this.d.clock.nowIso();
      return report;
    }

    const ledgerIntegrity = this.d.ledger.verifyIntegrity();
    if (!ledgerIntegrity.ok) {
      this.d.health.reportLedgerMismatch(ledgerIntegrity.detail);
      report.halted = true;
      report.haltReason = ledgerIntegrity.detail;
      report.runState = 'PAUSED';
      report.finishedAt = this.d.clock.nowIso();
      return report;
    }

    /* ---------------------------------------------------- 1. ingest --- */
    try {
      const ingest = await this.d.ingestion.ingest(strategy.universeSources, correlationId);
      report.ingested = ingest.stored;
      this.d.health.recordSuccess('social');
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      const kind = e instanceof SocialProviderError ? e.kind : undefined;
      report.errors.push(`ingest: ${detail}`);
      const paused = this.d.health.recordFailure('social', detail, kind);
      if (paused) {
        report.halted = true;
        report.haltReason = detail;
        report.runState = 'PAUSED';
      }
      // Ingestion failure is survivable: the cycle continues on stored events
      // so existing positions still get managed and exited.
    }

    /* ------------------------------- 2-4. filter, resolve, signal ----- */
    const since = new Date(this.d.clock.nowMs() - this.d.signalConfig.maxEventAgeHours * 3_600_000).toISOString();
    const recentEvents = this.d.store.events.since(since, 500);

    const universeTickers = new Set(
      this.d.universe.eligible(strategy.universeSources).map((s) => s.ticker.toUpperCase()),
    );
    const filterResults = this.d.filter.filterBatch(recentEvents, universeTickers, this.d.clock.nowMs());
    for (const f of filterResults) {
      this.d.store.filters.save(f);
      if (f.verdict === 'ACCEPT') report.filtered.accepted += 1;
      else if (f.verdict === 'DOWNWEIGHT') report.filtered.downweighted += 1;
      else report.filtered.rejected += 1;
    }

    const filterByEvent = new Map(filterResults.map((f) => [f.eventId, f]));
    const resolutions = [];
    for (const event of recentEvents) {
      const filter = filterByEvent.get(event.eventId);
      if (!filter || filter.verdict === 'REJECT') continue;
      const author = this.d.store.authors.byId(event.authorId);
      const resolved = this.d.resolver.resolve(event, filter, author?.officialForSecurityId);
      for (const r of resolved) {
        this.d.store.resolutions.save(r);
        resolutions.push(r);
      }
      if (resolved.length > 0) {
        this.d.store.events.setResolvedSecurities(event.eventId, resolved.map((r) => r.securityId));
      }
    }
    report.resolutions = resolutions.length;

    // Only tradable-confidence resolutions may seed a signal.
    const tradableResolutions = resolutions.filter((r) => this.d.resolver.isTradable(r));
    const candidates = this.d.signalEngine.buildCandidates(recentEvents, filterResults, tradableResolutions);

    const signals: XSignal[] = [];
    for (const candidate of candidates) {
      try {
        const signal = await this.d.signalEngine.generate(candidate);
        if (!signal) continue;
        this.d.store.signals.save(signal);
        signals.push(signal);
        report.signalsGenerated += 1;

        this.d.store.log.append({
          correlationId,
          strategyId: strategy.strategyId,
          stage: 'SIGNAL',
          subjectId: signal.signalId,
          summary: `${signal.band} ${signal.score >= 0 ? '+' : ''}${signal.score} on ${signal.ticker}`,
          payload: {
            score: signal.score,
            band: signal.band,
            uncertainty: signal.uncertainty,
            components: signal.components,
            triggeringEventIds: signal.triggeringEventIds,
            independentSources: signal.independentSourceCount,
          },
        });

        // Register forward-return rows immediately, so even signals that never
        // trade are graded later.
        const price = signal.priceConfirmationDetail?.lastPrice ?? 0;
        if (price > 0) this.d.forwardReturns.register(signal, price);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        report.errors.push(`signal ${candidate.ticker}: ${detail}`);
        this.log.warn('signal generation failed', { ticker: candidate.ticker, detail });
      }
    }

    /* ------------------------------------------ 5. mark to market ----- */
    const quotes = await this.quotesForOpenExposure(strategy, report);
    const marks = new Map([...quotes].map(([ticker, q]) => [ticker, q.price]));
    const ledger = this.d.ledger.mark(marks);
    report.equityCents = ledger.equityCents;

    const benchmarkQuote = quotes.get(strategy.benchmarkTicker.toUpperCase()) ?? null;
    this.d.ledger.snapshot(benchmarkQuote?.price ?? null);

    /* ------------------------------------------------- 6. exits ------- */
    const breach = this.d.riskEngine.strategyBreach(strategy.riskLimits);
    const openPositions = this.d.store.positions.open(strategy.strategyId);
    const exitDecisions = this.d.exitEngine.evaluateAll(openPositions, {
      quotes,
      strategyRiskShutdown: breach.breached,
      strategyRiskDetail: breach.reasons.join('; '),
      killSwitchLiquidate: this.d.health.shouldLiquidate,
    });

    for (const decision of exitDecisions) {
      if (!decision.shouldExit || !decision.reason) continue;
      const position = openPositions.find((p) => p.positionId === decision.positionId);
      if (!position) continue;
      try {
        const outcome = await this.d.orderRouter.submitExit(position, decision.reason, decision.note);
        if (outcome.ok) {
          report.exitsTriggered.push({ ticker: position.ticker, reason: decision.reason });
          this.d.health.recordSuccess('broker');
        } else if (outcome.reason === 'BROKER_ERROR') {
          report.errors.push(`exit ${position.ticker}: ${outcome.detail}`);
          this.d.health.recordFailure('broker', outcome.detail);
        }
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        report.errors.push(`exit ${position.ticker}: ${detail}`);
        this.d.health.recordFailure('broker', detail, e instanceof BrokerError ? e.kind : undefined);
      }
    }

    /* --------------------------------- 7-9. propose, risk, execute ---- */
    if (breach.breached) {
      this.log.warn('strategy risk breach: no new proposals this cycle', { reasons: breach.reasons });
      this.d.store.log.append({
        correlationId,
        strategyId: strategy.strategyId,
        stage: 'RISK',
        subjectId: strategy.strategyId,
        summary: `Strategy-level risk breach: ${breach.reasons.join('; ')}`,
        payload: { reasons: breach.reasons },
      });
    } else {
      await this.proposeAndExecute(strategy, signals, quotes, correlationId, report);
    }

    /* --------------------------------------------- 10. reconcile ------ */
    try {
      const reconcile = await this.d.positionManager.reconcile();
      report.fillsRecorded = reconcile.fillsRecorded;
      report.positionsOpened = reconcile.positionsOpened.length;
      report.positionsClosed = reconcile.positionsClosed.length;
      report.errors.push(...reconcile.errors);
      // Only a reconciliation that actually contacted the broker is evidence
      // of health. A cycle with no open orders proves nothing, and treating it
      // as a success would silently reset the circuit breaker every cycle.
      if (reconcile.errors.length > 0) {
        this.d.health.recordFailure('broker', reconcile.errors[0] ?? 'order reconciliation failed');
      } else if (reconcile.ordersChecked > 0) {
        this.d.health.recordSuccess('broker');
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      report.errors.push(`reconcile: ${detail}`);
      this.d.health.recordFailure('broker', detail, e instanceof BrokerError ? e.kind : undefined);
    }

    // Re-mark after fills so equity reflects the new positions.
    this.d.ledger.mark(marks);

    /* --------------------------------------------- 11. analytics ------ */
    try {
      await this.d.forwardReturns.measurePending();
      this.d.survival.persist();
    } catch (e) {
      report.errors.push(`analytics: ${e instanceof Error ? e.message : String(e)}`);
    }

    this.expireStaleProposals();

    const finalStrategy = this.strategy();
    report.runState = finalStrategy.runState;
    report.haltReason = finalStrategy.haltReason;
    report.halted = finalStrategy.runState !== 'RUNNING';
    report.equityCents = this.d.ledger.get().equityCents;
    report.finishedAt = this.d.clock.nowIso();

    this.log.info('cycle complete', {
      correlationId,
      signals: report.signalsGenerated,
      proposals: report.proposalsCreated,
      orders: report.ordersSubmitted,
      exits: report.exitsTriggered.length,
      errors: report.errors.length,
    });

    return report;
  }

  /* ------------------------------------------------------------ stages */

  private async proposeAndExecute(
    strategy: Strategy,
    signals: XSignal[],
    quotes: Map<string, Quote>,
    correlationId: string,
    report: CycleReport,
  ): Promise<void> {
    const marketStatus = await this.d.marketData.getMarketStatus().catch(() => ({
      isOpen: false,
      asOf: this.d.clock.nowIso(),
      nextOpen: null,
      nextClose: null,
      reason: 'Market status unavailable',
    }));

    let brokerOpen: boolean | null = null;
    try {
      brokerOpen = await this.d.broker.isMarketOpen();
      this.d.health.recordSuccess('broker');
    } catch (e) {
      this.d.health.recordFailure('broker', e instanceof Error ? e.message : String(e),
        e instanceof BrokerError ? e.kind : undefined);
    }

    const healthState = this.d.health.state();
    const providersHealthy = healthState.runState === 'RUNNING';

    // Strongest signals first: with five slots and $50, order matters.
    const ranked = [...signals].sort((a, b) => b.score - a.score);

    for (const signal of ranked) {
      if (signal.score < strategy.riskLimits.minSignalScore) continue;

      const security = this.d.universe.byIdOrNull(signal.securityId);
      if (!security) continue;

      const quote = quotes.get(security.ticker.toUpperCase()) ?? (await this.safeQuote(security.ticker));
      if (!quote) {
        this.log.info('no quote for signal; skipping proposal', { ticker: security.ticker });
        continue;
      }

      const ledger = this.d.ledger.get();
      const proposal = this.d.proposalBuilder.build({
        signal,
        security,
        strategy,
        quote,
        equityCents: ledger.equityCents,
        availableCents: this.d.ledger.availableCents(),
        correlationId,
      });
      if (!proposal) continue;

      this.d.store.proposals.save(proposal);
      report.proposalsCreated += 1;
      this.d.store.log.append({
        correlationId,
        strategyId: strategy.strategyId,
        stage: 'PROPOSAL',
        subjectId: proposal.proposalId,
        summary: `Proposed ${proposal.ticker} BUY ${(proposal.proposedCapitalCents / 100).toFixed(2)} USD`,
        payload: {
          signalId: signal.signalId,
          capitalCents: proposal.proposedCapitalCents,
          quantity: proposal.proposedQuantity,
          referencePrice: proposal.referencePrice,
          confidence: proposal.confidence,
          mode: proposal.mode,
        },
      });

      /* ----------------------------------------- independent risk pass */
      const decision: RiskDecision = this.d.riskEngine.evaluate(proposal, {
        strategy,
        signal,
        marketStatus,
        marketDataAgeMinutes: quote.ageMinutes,
        marketDataStale: quote.stale,
        openPositions: this.d.store.positions.open(strategy.strategyId),
        providersHealthy,
        providerHealthDetail: healthState.haltReason ?? 'healthy',
        brokerReportsMarketOpen: brokerOpen,
      });

      this.d.store.risk.save(decision);
      this.d.store.proposals.setRiskDecision(proposal.proposalId, decision.riskDecisionId);
      this.d.store.log.append({
        correlationId,
        strategyId: strategy.strategyId,
        stage: 'RISK',
        subjectId: decision.riskDecisionId,
        summary: decision.summary,
        payload: {
          proposalId: proposal.proposalId,
          approved: decision.approved,
          failedChecks: decision.failedChecks,
          permittedCapitalCents: decision.permittedCapitalCents,
        },
      });

      if (!decision.approved) {
        report.riskRejected += 1;
        this.d.store.proposals.setStatus(proposal.proposalId, 'RISK_REJECTED');
        continue;
      }
      report.riskApproved += 1;

      // Risk may permit less capital than proposed; re-fingerprint the trimmed
      // terms so what a user sees and approves is what would be submitted.
      let finalProposal: TradeProposal = proposal;
      if (decision.permittedCapitalCents !== proposal.proposedCapitalCents) {
        finalProposal = this.d.proposalBuilder.resize(proposal, decision.permittedCapitalCents, signal.score);
        this.d.store.proposals.save(finalProposal);
      }

      /* ------------------------------------------------- PAPER vs LIVE */
      if (strategy.mode === 'PAPER') {
        const outcome = await this.d.orderRouter.submitEntry(finalProposal, decision, signal);
        if (outcome.ok) {
          report.ordersSubmitted += 1;
          this.d.health.recordSuccess('broker');
        } else {
          if (outcome.reason === 'BROKER_ERROR') {
            report.errors.push(`order ${finalProposal.ticker}: ${outcome.detail}`);
            this.d.health.recordFailure('broker', outcome.detail);
          }
          this.log.info('entry not submitted', { ticker: finalProposal.ticker, reason: outcome.reason, detail: outcome.detail });
        }
      } else {
        // LIVE: stop here. The order is submitted only after a human approves
        // via the approval API, which re-runs the router's gate.
        this.d.store.proposals.setStatus(finalProposal.proposalId, 'AWAITING_APPROVAL');
        report.awaitingApproval += 1;
        this.d.store.log.append({
          correlationId,
          strategyId: strategy.strategyId,
          stage: 'APPROVAL',
          subjectId: finalProposal.proposalId,
          summary: `Awaiting human approval for LIVE ${finalProposal.ticker} order`,
          payload: { proposalId: finalProposal.proposalId, expiresAt: finalProposal.expiresAt },
        });
      }
    }
  }

  /** Quotes for everything the cycle needs to price. */
  private async quotesForOpenExposure(strategy: Strategy, report: CycleReport): Promise<Map<string, Quote>> {
    const tickers = new Set<string>([strategy.benchmarkTicker.toUpperCase()]);
    for (const p of this.d.store.positions.open(strategy.strategyId)) tickers.add(p.ticker.toUpperCase());
    for (const s of this.d.store.signals.since(new Date(this.d.clock.nowMs() - 3_600_000).toISOString())) {
      tickers.add(s.ticker.toUpperCase());
    }

    try {
      const quotes = await this.d.marketData.getQuotes([...tickers]);
      this.d.health.recordSuccess('marketData');
      return quotes;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      report.errors.push(`quotes: ${detail}`);
      this.d.health.recordFailure('marketData', detail, e instanceof MarketDataError ? e.kind : undefined);
      return new Map();
    }
  }

  private async safeQuote(ticker: string): Promise<Quote | null> {
    try {
      return await this.d.marketData.getQuote(ticker);
    } catch {
      return null;
    }
  }

  /** Age out proposals nobody acted on, so stale terms can never execute. */
  private expireStaleProposals(): void {
    for (const proposal of this.d.store.proposals.expired()) {
      this.d.store.proposals.setStatus(proposal.proposalId, 'EXPIRED');
      this.d.store.log.append({
        correlationId: proposal.correlationId,
        strategyId: proposal.strategyId,
        stage: 'PROPOSAL',
        subjectId: proposal.proposalId,
        summary: `Proposal expired unactioned (${proposal.ticker})`,
        payload: { expiresAt: proposal.expiresAt, status: proposal.status },
      });
    }
  }
}
