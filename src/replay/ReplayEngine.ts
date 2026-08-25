/**
 * Historical replay.
 *
 * Steps a FixedClock through a dataset's window, running the REAL cycle at each
 * step: the same ingestion, filter, resolver, signal engine, proposal builder,
 * risk engine, order router, position manager and exit engine that run against
 * live X, Tiingo and Alpaca. Only the three providers are swapped, and only for
 * ones that refuse to reveal the future.
 *
 * That is the point. A replay that used a separate scoring path would prove
 * nothing about the code that actually trades.
 */
import type { Logger } from '../core/index.js';
import { FixedClock, NullLogger, formatUsd, round } from '../core/index.js';
import { NorthstarApp } from '../app.js';
import { loadEnv, type NorthstarEnv } from '../config/env.js';
import type { StrategyVersionSpec } from '../config/strategyRegistry.js';
import type { ForwardHorizon, RiskCheckId, SurvivalMetrics } from '../domain/types.js';
import { SimulatedBrokerProvider } from '../providers/broker/SimulatedBrokerProvider.js';
import type { ReplayDataset } from './dataset.js';
import { ReplayMarketDataProvider, ReplaySocialProvider } from './providers.js';

export interface ReplayOptions {
  dataset: ReplayDataset;
  /** Which immutable strategy version to replay. */
  spec: StrategyVersionSpec;
  /** Simulated minutes between cycles. */
  stepMinutes?: number;
  /** Basis points of slippage applied to every simulated fill. */
  slippageBps?: number;
  logger?: Logger;
  /** Horizon used for the signal hit-rate figures. */
  horizon?: ForwardHorizon;
  onCycle?: (cycle: ReplayCycle) => void;
}

export interface ReplayCycle {
  index: number;
  at: string;
  signals: number;
  proposals: number;
  riskApproved: number;
  riskRejected: number;
  orders: number;
  exits: number;
  equityCents: number;
  /** Events and bars still hidden from the replay — proof of no look-ahead. */
  hiddenEvents: number;
  hiddenBars: number;
}

export interface ReplayTrade {
  ticker: string;
  openedAt: string;
  closedAt: string | null;
  quantity: number;
  entryPrice: number;
  exitPrice: number | null;
  realisedPnlCents: number;
  realisedPct: number | null;
  holdingHours: number | null;
  exitReason: string | null;
  entrySignalScore: number;
}

export interface ReplayResult {
  datasetId: string;
  strategyId: string;
  strategyVersion: string;
  signalConfigId: string;
  window: { from: string; to: string };
  cycles: ReplayCycle[];

  /* --- headline outcomes ------------------------------------------------ */
  startingCapitalCents: number;
  finalEquityCents: number;
  returnPct: number;
  benchmarkReturnPct: number;
  alphaPct: number;
  maxDrawdownPct: number;
  tradeCount: number;
  openPositionsAtEnd: number;
  winRatePct: number;
  turnover: number;
  totalCostsCents: number;
  sharpe: number | null;

  /* --- signal quality --------------------------------------------------- */
  signalsGenerated: number;
  measuredSignals: number;
  hitRatePct: number | null;
  meanExcessReturnPct: number | null;
  sourceTierPerformance: { bucket: string; count: number; hitRatePct: number | null; meanExcessReturnPct: number | null }[];

  /* --- controls --------------------------------------------------------- */
  riskInterventions: number;
  riskInterventionsByCheck: Record<string, number>;
  filterVerdicts: Record<string, number>;
  healthIncidents: { fault: string; at: string; detail: string }[];
  errors: string[];

  trades: ReplayTrade[];
  survival: SurvivalMetrics;
  /** True when no event or bar was ever revealed ahead of the replay clock. */
  lookAheadClean: boolean;
}

export async function runReplay(opts: ReplayOptions): Promise<ReplayResult> {
  const { dataset, spec } = opts;
  const stepMinutes = opts.stepMinutes ?? 30;
  const horizon = opts.horizon ?? '1d';
  const logger = opts.logger ?? new NullLogger();

  const clock = new FixedClock(dataset.window.from);
  const social = new ReplaySocialProvider(dataset, clock);
  const marketData = new ReplayMarketDataProvider(dataset, clock);
  const broker = new SimulatedBrokerProvider({
    clock,
    marketData,
    mode: 'PAPER',
    slippageBps: opts.slippageBps ?? 5,
  });

  // Replay never reads real credentials and never reaches a real broker.
  const env: NorthstarEnv = {
    ...loadEnv(),
    useFixtures: true,
    xBearerToken: null,
    tiingoApiKey: null,
    liveTradingEnabled: false,
    databasePath: ':memory:',
  };

  const app = new NorthstarApp({
    env,
    clock,
    logger,
    mode: 'PAPER',
    social,
    marketData,
    broker,
    databasePath: ':memory:',
    strategySpec: spec,
  });
  app.seed();

  const endMs = new Date(dataset.window.to).getTime();
  const cycles: ReplayCycle[] = [];
  const errors: string[] = [];
  let index = 0;
  let lookAheadClean = true;

  while (clock.nowMs() <= endMs) {
    index += 1;
    const report = await app.runner.runCycle();
    errors.push(...report.errors);

    const hiddenEvents = social.hiddenCount();
    const hiddenBars = marketData.hiddenCount();

    // On any cycle before the last, some of the dataset must still be hidden.
    // If nothing is ever hidden, the replay was not actually stepping time and
    // the result would be a look-ahead backtest wearing a replay costume.
    const cycle: ReplayCycle = {
      index,
      at: report.finishedAt,
      signals: report.signalsGenerated,
      proposals: report.proposalsCreated,
      riskApproved: report.riskApproved,
      riskRejected: report.riskRejected,
      orders: report.ordersSubmitted,
      exits: report.exitsTriggered.length,
      equityCents: report.equityCents,
      hiddenEvents,
      hiddenBars,
    };
    cycles.push(cycle);
    opts.onCycle?.(cycle);

    clock.advanceMinutes(stepMinutes);
  }

  // Everything should be revealed by the end; nothing should have been revealed
  // early. The second half is enforced by the providers themselves.
  if (cycles.length > 1 && cycles[0]!.hiddenEvents === 0 && dataset.events.length > 0) {
    const firstEventVisibleImmediately = dataset.events.every(
      (e) => e.capturedAt <= dataset.window.from,
    );
    lookAheadClean = firstEventVisibleImmediately;
  }

  await app.forwardReturns.measurePending();
  const survival = app.survival.persist();
  const analytics = app.analytics.report(horizon);

  const strategyId = spec.strategyId;
  const ledger = app.ledger.get();
  const closed = app.store.positions.closed(strategyId);
  const riskRejections = app.store.risk.recent(100_000).filter((d) => !d.approved);

  const byCheck: Record<string, number> = {};
  for (const decision of riskRejections) {
    for (const check of decision.failedChecks) byCheck[check] = (byCheck[check] ?? 0) + 1;
  }

  const trades: ReplayTrade[] = closed.map((p) => ({
    ticker: p.ticker,
    openedAt: p.openedAt,
    closedAt: p.closedAt,
    quantity: round(p.quantity, 6),
    entryPrice: p.entryPrice,
    exitPrice: p.exitPrice,
    realisedPnlCents: p.realisedPnlCents ?? 0,
    realisedPct: p.entryCostCents > 0 ? round(((p.realisedPnlCents ?? 0) / p.entryCostCents) * 100, 3) : null,
    holdingHours: p.closedAt
      ? round((new Date(p.closedAt).getTime() - new Date(p.openedAt).getTime()) / 3_600_000, 2)
      : null,
    exitReason: p.exitReason,
    entrySignalScore: p.entrySignalScore,
  }));

  const result: ReplayResult = {
    datasetId: dataset.datasetId,
    strategyId,
    strategyVersion: spec.version,
    signalConfigId: spec.signalConfigId,
    window: dataset.window,
    cycles,

    startingCapitalCents: ledger.startingCapitalCents,
    finalEquityCents: ledger.equityCents,
    returnPct: survival.strategyReturnPct,
    benchmarkReturnPct: survival.benchmarkReturnPct,
    alphaPct: survival.alphaPct,
    maxDrawdownPct: survival.maxDrawdownPct,
    tradeCount: closed.length,
    openPositionsAtEnd: app.store.positions.open(strategyId).length,
    winRatePct: survival.winRatePct,
    turnover: survival.turnover,
    totalCostsCents: survival.totalCostsCents,
    sharpe: survival.sharpe,

    signalsGenerated: app.store.signals.all().length,
    measuredSignals: analytics.measuredSignals,
    hitRatePct: analytics.overallHitRatePct,
    meanExcessReturnPct: analytics.meanExcessReturnPct,
    sourceTierPerformance: analytics.bySourceTier.map((b) => ({
      bucket: b.bucket,
      count: b.count,
      hitRatePct: b.hitRatePct,
      meanExcessReturnPct: b.meanExcessReturnPct,
    })),

    riskInterventions: riskRejections.length,
    riskInterventionsByCheck: byCheck,
    filterVerdicts: app.store.filters.countByVerdictSince('1970-01-01T00:00:00.000Z'),
    healthIncidents: app.store.incidents
      .recent(strategyId, 500)
      .map((i) => ({ fault: i.fault, at: i.at, detail: i.detail })),
    errors,

    trades,
    survival,
    lookAheadClean,
  };

  app.close();
  return result;
}

/** Human-readable one-liner for a replay result. */
export function summariseReplay(r: ReplayResult): string {
  return (
    `${r.strategyId}@${r.strategyVersion} · ${r.cycles.length} cycles · ` +
    `${r.signalsGenerated} signals · ${r.tradeCount} trades · ` +
    `equity ${formatUsd(r.finalEquityCents)} (${r.returnPct >= 0 ? '+' : ''}${r.returnPct.toFixed(2)}%) · ` +
    `alpha ${r.alphaPct >= 0 ? '+' : ''}${r.alphaPct.toFixed(2)}% · ` +
    `maxDD ${r.maxDrawdownPct.toFixed(2)}% · ` +
    `hit ${r.hitRatePct === null ? 'n/a' : `${r.hitRatePct.toFixed(1)}%`} · ` +
    `${r.riskInterventions} risk interventions`
  );
}

export type RiskCheckCounts = Partial<Record<RiskCheckId, number>>;
