/**
 * Observability payload.
 *
 * One call answers "is this thing healthy and what is it actually connected
 * to?" — the question an operator has while watching the first run against real
 * credentials.
 *
 * Deliberately mixes two kinds of fact and labels which is which:
 *   - process facts (last provider success, failure counters) reset on restart
 *   - stored facts (last stored event, ledger, positions) survive it
 * Presenting them as one undifferentiated blob is how "we restarted an hour ago"
 * gets mistaken for "X has been quiet for an hour".
 */
import { formatUsd, round } from '../core/index.js';
import type { NorthstarApp } from '../app.js';

export interface ObservabilityPayload {
  at: string;

  providers: {
    x: string;
    marketData: string;
    broker: string;
    mode: string;
    forcedFixtures: boolean;
    allReal: boolean;
    /** The concrete implementations behind the labels. */
    ids: { social: string; marketData: string; broker: string };
  };

  /** Since this process started. Cleared by a restart. */
  process: {
    startedAt: string;
    uptimeMinutes: number;
    lastXIngestAt: string | null;
    lastMarketDataRefreshAt: string | null;
    lastBrokerSuccessAt: string | null;
    consecutiveFailures: { social: number; broker: number; marketData: number };
    lastFailureAt: { social: string | null; broker: string | null; marketData: string | null };
    lastFailureDetail: { social: string | null; broker: string | null; marketData: string | null };
    staleness: { social: number | null; marketData: number | null; broker: number | null };
  };

  /** Survives a restart. */
  stored: {
    lastStoredEventAt: string | null;
    storedEventsLast24h: number;
    signalsLast24h: number;
    lastSignalAt: string | null;
    lastCycleAt: string | null;
  };

  ledger: {
    startingCapital: string;
    cash: string;
    reserved: string;
    positionsValue: string;
    equity: string;
    equityCents: number;
    reservedCents: number;
    integrityOk: boolean;
    integrityDetail: string;
  };

  exposure: {
    openOrders: number;
    openPositions: number;
    maxPositions: number;
    pendingApprovals: number;
  };

  risk: {
    dailyLossPct: number;
    maxDailyLossPct: number;
    drawdownPct: number;
    maxDrawdownPct: number;
    breached: boolean;
    breachReasons: string[];
  };

  strategy: {
    strategyId: string;
    version: string;
    status: string;
    runState: string;
    haltReason: string | null;
    haltedAt: string | null;
  };

  killSwitch: {
    engaged: boolean;
    liquidateOnKill: boolean;
    haltReason: string | null;
    openIncidents: { fault: string; at: string; detail: string }[];
  };
}

export function buildObservability(app: NorthstarApp): ObservabilityPayload {
  const now = app.clock.nowIso();
  const nowMs = app.clock.nowMs();
  const strategyId = app.spec.strategyId;

  const providers = app.describeProviders();
  const health = app.health.state();
  const strategy = app.store.strategies.byId(strategyId);
  const ledger = app.ledger.get();
  const integrity = app.ledger.verifyIntegrity();
  const limits = app.spec.riskLimits;
  const breach = app.riskEngine.strategyBreach(limits);
  const survival = app.survival.compute();

  const dayAgo = new Date(nowMs - 86_400_000).toISOString();
  const lastEvent = app.store.events.recent(1)[0] ?? null;
  const lastSignal = app.store.signals.recent(1)[0] ?? null;
  const lastCycle = app.store.log.byStage(strategyId, 'INGEST', 1)[0] ?? null;

  const minutesSince = (iso: string | null): number | null =>
    iso === null ? null : round((nowMs - new Date(iso).getTime()) / 60_000, 2);

  return {
    at: now,

    providers: {
      x: providers.x,
      marketData: providers.marketData,
      broker: providers.broker,
      mode: providers.mode,
      forcedFixtures: providers.forcedFixtures,
      allReal: providers.allReal,
      ids: {
        social: app.social.providerId,
        marketData: app.marketData.providerId,
        broker: app.broker.brokerId,
      },
    },

    process: {
      startedAt: health.startedAt,
      uptimeMinutes: round((nowMs - new Date(health.startedAt).getTime()) / 60_000, 2),
      lastXIngestAt: health.lastSuccessAt.social,
      lastMarketDataRefreshAt: health.lastSuccessAt.marketData,
      lastBrokerSuccessAt: health.lastSuccessAt.broker,
      consecutiveFailures: {
        social: health.failureCounts.social,
        broker: health.failureCounts.broker,
        marketData: health.failureCounts.marketData,
      },
      lastFailureAt: {
        social: health.lastFailureAt.social,
        broker: health.lastFailureAt.broker,
        marketData: health.lastFailureAt.marketData,
      },
      lastFailureDetail: {
        social: health.lastFailureDetail.social,
        broker: health.lastFailureDetail.broker,
        marketData: health.lastFailureDetail.marketData,
      },
      staleness: {
        social: minutesSince(health.lastSuccessAt.social),
        marketData: minutesSince(health.lastSuccessAt.marketData),
        broker: minutesSince(health.lastSuccessAt.broker),
      },
    },

    stored: {
      lastStoredEventAt: lastEvent?.capturedAt ?? null,
      storedEventsLast24h: app.store.events.countSince(dayAgo),
      signalsLast24h: app.store.signals.countSince(dayAgo),
      lastSignalAt: lastSignal?.generatedAt ?? null,
      lastCycleAt: lastCycle?.at ?? null,
    },

    ledger: {
      startingCapital: formatUsd(ledger.startingCapitalCents),
      cash: formatUsd(ledger.cashCents),
      reserved: formatUsd(ledger.reservedCents),
      positionsValue: formatUsd(ledger.positionsValueCents),
      equity: formatUsd(ledger.equityCents),
      equityCents: ledger.equityCents,
      reservedCents: ledger.reservedCents,
      integrityOk: integrity.ok,
      integrityDetail: integrity.detail,
    },

    exposure: {
      openOrders: app.store.orders.open(strategyId).length,
      openPositions: app.store.positions.open(strategyId).length,
      maxPositions: limits.maxConcurrentPositions,
      pendingApprovals: app.approvals.pending().length,
    },

    risk: {
      dailyLossPct: round(app.ledger.dailyLossPct(), 3),
      maxDailyLossPct: limits.maxDailyLossPct,
      drawdownPct: round(app.ledger.drawdownPct(), 3),
      maxDrawdownPct: limits.maxDrawdownPct,
      breached: breach.breached,
      breachReasons: breach.reasons,
    },

    strategy: {
      strategyId,
      version: app.spec.version,
      status: survival.status,
      runState: strategy?.runState ?? 'UNKNOWN',
      haltReason: strategy?.haltReason ?? null,
      haltedAt: strategy?.haltedAt ?? null,
    },

    killSwitch: {
      engaged: health.killed,
      liquidateOnKill: health.liquidateOnKill,
      haltReason: health.haltReason,
      openIncidents: health.openIncidents.map((i) => ({ fault: i.fault, at: i.at, detail: i.detail })),
    },
  };
}
