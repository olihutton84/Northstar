/**
 * Dashboard payload.
 *
 * One call assembles everything the X Signal Bot page renders: header status,
 * the equity-vs-benchmark series, the live signal feed, proposals, positions,
 * trades, signal performance, source analytics and risk state.
 */
import { formatSignedUsd, formatUsd, round } from '../core/index.js';
import type { NorthstarApp } from '../app.js';
import type { Position, SignalBand } from '../domain/types.js';

export interface DashboardPayload {
  header: {
    title: string;
    strategyId: string;
    version: string;
    status: string;
    runState: string;
    mode: string;
    haltReason: string | null;
    allocatedCapital: string;
    currentEquity: string;
    totalReturnPct: number;
    benchmarkReturnPct: number;
    benchmarkTicker: string;
    alphaPct: number;
    drawdownPct: number;
    maxDrawdownPct: number;
    openPositions: number;
    maxPositions: number;
    signalsToday: number;
    proposalsToday: number;
    tradesToday: number;
    brokerMode: string;
    liveTradingArmed: boolean;
  };
  equityCurve: {
    at: string;
    equity: number;
    benchmarkIndexed: number | null;
  }[];
  signalFeed: {
    signalId: string;
    ticker: string;
    band: SignalBand;
    bandLabel: string;
    score: number;
    why: string;
    sourceCount: number;
    independentSourceCount: number;
    uncertainty: number;
    timestamp: string;
    components: Record<string, number>;
    topContributions: { component: string; contribution: number; explanation: string }[];
    supporting: string[];
    contradictory: string[];
  }[];
  proposals: {
    proposalId: string;
    ticker: string;
    side: string;
    amount: string;
    shares: number;
    price: number;
    confidence: number;
    status: string;
    createdAt: string;
    expiresAt: string;
    riskApproved: boolean | null;
    riskSummary: string;
    failedChecks: string[];
    needsApproval: boolean;
    rationale: string;
  }[];
  openPositions: {
    positionId: string;
    ticker: string;
    quantity: number;
    entryPrice: number;
    lastPrice: number;
    costBasis: string;
    marketValue: string;
    unrealised: string;
    unrealisedPct: number;
    heldHours: number;
    entrySignalScore: number;
    invalidation: string;
  }[];
  recentTrades: {
    positionId: string;
    ticker: string;
    quantity: number;
    entryPrice: number;
    exitPrice: number | null;
    openedAt: string;
    closedAt: string | null;
    holdingHours: number | null;
    realised: string;
    realisedPct: number | null;
    exitReason: string | null;
    exitNote: string | null;
  }[];
  signalPerformance: {
    horizon: string;
    measuredSignals: number;
    hitRatePct: number | null;
    meanReturnPct: number | null;
    meanExcessReturnPct: number | null;
    byStrength: { bucket: string; count: number; hitRatePct: number | null; meanExcessReturnPct: number | null }[];
    byBand: { bucket: string; count: number; hitRatePct: number | null; meanExcessReturnPct: number | null }[];
    componentCorrelations: { component: string; correlation: number | null; interpretation: string }[];
    caveat: string;
    sampleAdequate: boolean;
  };
  sourceAnalytics: {
    bySourceTier: { bucket: string; count: number; hitRatePct: number | null; meanExcessReturnPct: number | null }[];
    byAccount: { bucket: string; count: number; hitRatePct: number | null; meanExcessReturnPct: number | null }[];
    byEventType: { bucket: string; count: number; hitRatePct: number | null; meanExcessReturnPct: number | null }[];
  };
  risk: {
    limits: Record<string, unknown>;
    ledger: {
      startingCapital: string;
      cash: string;
      reserved: string;
      positions: string;
      unrealised: string;
      realised: string;
      equity: string;
      integrityOk: boolean;
      integrityDetail: string;
    };
    dailyLossPct: number;
    maxDailyLossPct: number;
    drawdownPct: number;
    maxDrawdownPct: number;
    openIncidents: { fault: string; at: string; detail: string }[];
    failureCounts: Record<string, number>;
    recentRejections: { ticker: string; at: string; failedChecks: string[]; summary: string }[];
    riskInterventionsToday: number;
  };
  survival: Record<string, unknown>;
  filterStats: Record<string, number>;
  generatedAt: string;
}

const BAND_LABEL: Record<SignalBand, string> = {
  STRONG_BEARISH: 'Strong Bearish',
  BEARISH: 'Bearish',
  NEUTRAL: 'Neutral',
  BULLISH: 'Bullish',
  STRONG_BULLISH: 'Strong Bullish',
};

export async function buildDashboard(app: NorthstarApp): Promise<DashboardPayload> {
  const strategyId = app.spec.strategyId;
  const strategy = app.store.strategies.byId(strategyId);
  const ledger = app.ledger.get();
  const limits = app.spec.riskLimits;
  const now = app.clock.nowIso();
  const dayStart = `${now.slice(0, 10)}T00:00:00.000Z`;

  const survival = app.survival.compute();
  const analytics = app.analytics.report('1d');
  const sources = app.analytics.sourcePerformance('1d');

  const openPositions = app.store.positions.open(strategyId);
  const closedPositions = app.store.positions.closed(strategyId).slice(-25).reverse();
  const curve = app.store.ledger.equityCurve(strategyId);

  /* --- equity vs benchmark, both indexed to the strategy's start ------- */
  const firstBenchmark = curve.find((p) => p.benchmarkPrice !== null && p.benchmarkPrice > 0)?.benchmarkPrice ?? null;
  const equityCurve = curve.map((p) => ({
    at: p.at,
    equity: round(p.equityCents / 100, 2),
    benchmarkIndexed:
      firstBenchmark && p.benchmarkPrice
        ? round((p.benchmarkPrice / firstBenchmark) * (ledger.startingCapitalCents / 100), 2)
        : null,
  }));

  const recentSignals = app.store.signals.recent(30);
  const recentProposals = app.store.proposals.recent(25);
  const rejections = app.store.risk.rejectionsSince(dayStart);

  return {
    header: {
      title: 'X SIGNAL BOT',
      strategyId,
      version: app.spec.version,
      status: survival.status,
      runState: strategy?.runState ?? 'UNKNOWN',
      mode: strategy?.mode ?? app.mode,
      haltReason: strategy?.haltReason ?? null,
      allocatedCapital: formatUsd(ledger.startingCapitalCents),
      currentEquity: formatUsd(ledger.equityCents),
      totalReturnPct: round(app.ledger.totalReturnPct(), 3),
      benchmarkReturnPct: survival.benchmarkReturnPct,
      benchmarkTicker: app.spec.benchmarkTicker,
      alphaPct: survival.alphaPct,
      drawdownPct: round(app.ledger.drawdownPct(), 3),
      maxDrawdownPct: limits.maxDrawdownPct,
      openPositions: openPositions.length,
      maxPositions: limits.maxConcurrentPositions,
      signalsToday: app.store.signals.countSince(dayStart),
      proposalsToday: app.store.proposals.countSince(dayStart),
      tradesToday: closedPositions.filter((p) => (p.closedAt ?? '') >= dayStart).length,
      brokerMode: app.broker.mode,
      liveTradingArmed: app.env.liveTradingEnabled,
    },

    equityCurve,

    signalFeed: recentSignals.map((s) => ({
      signalId: s.signalId,
      ticker: s.ticker,
      band: s.band,
      bandLabel: BAND_LABEL[s.band],
      score: s.score,
      why: s.explanation,
      sourceCount: s.sourceCount,
      independentSourceCount: round(s.independentSourceCount, 2),
      uncertainty: round(s.uncertainty, 3),
      timestamp: s.generatedAt,
      components: s.components as unknown as Record<string, number>,
      topContributions: [...s.contributions]
        .filter((c) => c.component !== 'priceAdjustment')
        .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
        .slice(0, 4)
        .map((c) => ({ component: String(c.component), contribution: c.contribution, explanation: c.explanation })),
      supporting: s.supportingEvidence,
      contradictory: s.contradictoryEvidence,
    })),

    proposals: recentProposals.map((p) => {
      const risk = p.riskDecisionId ? app.store.risk.byId(p.riskDecisionId) : null;
      return {
        proposalId: p.proposalId,
        ticker: p.ticker,
        side: p.side,
        amount: formatUsd(p.proposedCapitalCents),
        shares: round(p.proposedQuantity, 6),
        price: p.referencePrice,
        confidence: round(p.confidence, 3),
        status: p.status,
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
        riskApproved: risk?.approved ?? null,
        riskSummary: risk?.summary ?? 'Awaiting risk decision',
        failedChecks: risk?.failedChecks ?? [],
        needsApproval: p.status === 'AWAITING_APPROVAL',
        rationale: p.rationale,
      };
    }),

    openPositions: openPositions.map((p) => positionRow(p, app.clock.nowMs())),

    recentTrades: closedPositions.map((p) => ({
      positionId: p.positionId,
      ticker: p.ticker,
      quantity: round(p.quantity, 6),
      entryPrice: p.entryPrice,
      exitPrice: p.exitPrice,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
      holdingHours:
        p.closedAt !== null
          ? round((new Date(p.closedAt).getTime() - new Date(p.openedAt).getTime()) / 3_600_000, 2)
          : null,
      realised: formatSignedUsd(p.realisedPnlCents ?? 0),
      realisedPct:
        p.entryCostCents > 0 ? round(((p.realisedPnlCents ?? 0) / p.entryCostCents) * 100, 3) : null,
      exitReason: p.exitReason,
      exitNote: p.exitNote,
    })),

    signalPerformance: {
      horizon: analytics.horizon,
      measuredSignals: analytics.measuredSignals,
      hitRatePct: analytics.overallHitRatePct,
      meanReturnPct: analytics.meanReturnPct,
      meanExcessReturnPct: analytics.meanExcessReturnPct,
      byStrength: analytics.byStrength.map(slim),
      byBand: analytics.byBand.map(slim),
      componentCorrelations: analytics.componentCorrelations.map((c) => ({
        component: String(c.component),
        correlation: c.correlation,
        interpretation: c.interpretation,
      })),
      caveat: analytics.caveat,
      sampleAdequate: analytics.sampleAdequate,
    },

    sourceAnalytics: {
      bySourceTier: analytics.bySourceTier.map(slim),
      byAccount: sources.slice(0, 15).map(slim),
      byEventType: analytics.byEventType.map(slim),
    },

    risk: {
      limits: limits as unknown as Record<string, unknown>,
      ledger: {
        startingCapital: formatUsd(ledger.startingCapitalCents),
        cash: formatUsd(ledger.cashCents),
        reserved: formatUsd(ledger.reservedCents),
        positions: formatUsd(ledger.positionsValueCents),
        unrealised: formatSignedUsd(ledger.unrealisedPnlCents),
        realised: formatSignedUsd(ledger.realisedPnlCents),
        equity: formatUsd(ledger.equityCents),
        integrityOk: app.ledger.verifyIntegrity().ok,
        integrityDetail: app.ledger.verifyIntegrity().detail,
      },
      dailyLossPct: round(app.ledger.dailyLossPct(), 3),
      maxDailyLossPct: limits.maxDailyLossPct,
      drawdownPct: round(app.ledger.drawdownPct(), 3),
      maxDrawdownPct: limits.maxDrawdownPct,
      openIncidents: app.store.incidents.open(strategyId).map((i) => ({ fault: i.fault, at: i.at, detail: i.detail })),
      failureCounts: app.health.state().failureCounts as unknown as Record<string, number>,
      recentRejections: rejections.slice(0, 20).map((d) => {
        const proposal = app.store.proposals.byId(d.proposalId);
        return {
          ticker: proposal?.ticker ?? 'unknown',
          at: d.decidedAt,
          failedChecks: d.failedChecks,
          summary: d.summary,
        };
      }),
      riskInterventionsToday: rejections.length,
    },

    survival: survival as unknown as Record<string, unknown>,
    filterStats: app.store.filters.countByVerdictSince(dayStart),
    generatedAt: now,
  };
}

function positionRow(p: Position, nowMs: number): DashboardPayload['openPositions'][number] {
  const marketValueCents = Math.round(p.quantity * p.lastMarkPrice * 100);
  return {
    positionId: p.positionId,
    ticker: p.ticker,
    quantity: round(p.quantity, 6),
    entryPrice: p.entryPrice,
    lastPrice: p.lastMarkPrice,
    costBasis: formatUsd(p.entryCostCents),
    marketValue: formatUsd(marketValueCents),
    unrealised: formatSignedUsd(p.unrealisedPnlCents),
    unrealisedPct: p.entryCostCents > 0 ? round((p.unrealisedPnlCents / p.entryCostCents) * 100, 3) : 0,
    heldHours: round((nowMs - new Date(p.openedAt).getTime()) / 3_600_000, 2),
    entrySignalScore: p.entrySignalScore,
    invalidation: p.invalidationCondition.description,
  };
}

function slim(b: {
  bucket: string;
  count: number;
  hitRatePct: number | null;
  meanExcessReturnPct: number | null;
}): { bucket: string; count: number; hitRatePct: number | null; meanExcessReturnPct: number | null } {
  return {
    bucket: b.bucket,
    count: b.count,
    hitRatePct: b.hitRatePct,
    meanExcessReturnPct: b.meanExcessReturnPct,
  };
}
