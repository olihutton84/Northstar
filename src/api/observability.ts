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
import { marketStatus } from '../providers/marketdata/marketCalendar.js';
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

  /**
   * Above the fold: everything needed to answer "is it working and is it
   * safe?" without scrolling or clicking. Chosen so a glance at the top of the
   * page rules out the failure modes that matter on day one.
   */
  summary: {
    connected: boolean;
    connectedDetail: string;
    pollingState: string;
    pollingReason: string;
    nextScanSeconds: number;
    lastScanAt: string | null;
    minutesSinceLastScan: number | null;
    lastPostSeenAt: string | null;
    minutesSinceLastPost: number | null;
    xRequestsToday: number;
    xRequestBudget: number;
    tradesToday: number;
    openPositions: number;
    equity: string;
    dayPnl: string;
    marketOpen: boolean;
    marketReason: string;
    killSwitch: boolean;
    runState: string;
  };

  /** How fast each independent loop runs. */
  cadence: {
    xScanSeconds: number;
    xEventWatchSeconds: number;
    xPressureSeconds: number;
    positionMonitorSeconds: number;
    reconciliationSeconds: number;
    sameTickerCooldownMinutes: number;
    signalTtlMinutes: number;
    /** Vendor requests one scan really costs, from the provider's batching. */
    requestsPerScan: number;
    estimatedDailyXRequests: number;
  };

  /** Per-vendor request telemetry. Status codes and headers only. */
  api: {
    provider: string;
    requests: number;
    successes: number;
    rateLimited: number;
    errors: number;
    lastSuccessAt: string | null;
    minutesSinceSuccess: number | null;
    lastErrorAt: string | null;
    lastErrorKind: string | null;
    lastErrorDetail: string | null;
    rateLimitRemaining: number | null;
    rateLimitLimit: number | null;
    rateLimitResetAt: string | null;
    softCapUsedPct: number | null;
    pressured: boolean;
    pressureReason: string;
  }[];

  /** Securities currently polled at the faster event-watch cadence. */
  eventWatch: { ticker: string; untilIso: string; minutesLeft: number }[];

  funnel: {
    stages: { stage: string; count: number; meaning: string }[];
    stalledAt: string | null;
    narrative: string;
  };

  /** The raw X side: what came in, and what the pipeline made of each post. */
  feed: {
    postId: string;
    handle: string;
    tier: string;
    postedAt: string;
    capturedAt: string;
    text: string;
    url: string;
    verdict: string | null;
    verdictReasons: string[];
    resolvedTickers: string[];
    signalId: string | null;
    signalScore: number | null;
  }[];
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

  const polling = app.polling.status();
  const scheduler = app.scheduler.status();
  const xUsage = app.apiMeter.usage('x');
  const funnel = app.funnel.report();
  const calendar = marketStatus(app.clock);
  const dayStart = `${now.slice(0, 10)}T00:00:00.000Z`;
  const todayOrders = app.store.orders
    .all()
    .filter((o) => o.intent === 'ENTRY' && o.submittedAt >= dayStart).length;

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

    summary: {
      // "Connected" means the real vendors are wired AND none of them is in a
      // failure state. Either half alone would be misleading.
      connected: providers.allReal && health.runState === 'RUNNING',
      connectedDetail: providers.allReal
        ? health.runState === 'RUNNING'
          ? 'X, Tiingo and Alpaca all live and healthy'
          : `Providers are live but the strategy is ${health.runState}`
        : `Running on fixtures: X ${providers.x}, market data ${providers.marketData}, broker ${providers.broker}`,
      pollingState: polling.state,
      pollingReason: polling.reason,
      nextScanSeconds: polling.intervalSeconds,
      lastScanAt: scheduler.lastScanAt ?? lastCycle?.at ?? null,
      minutesSinceLastScan: minutesSince(scheduler.lastScanAt ?? lastCycle?.at ?? null),
      lastPostSeenAt: lastEvent?.capturedAt ?? null,
      minutesSinceLastPost: minutesSince(lastEvent?.capturedAt ?? null),
      xRequestsToday: xUsage.requests,
      xRequestBudget: app.ops.xDailyRequestSoftCap,
      tradesToday: todayOrders,
      openPositions: app.store.positions.open(strategyId).length,
      equity: formatUsd(ledger.equityCents),
      dayPnl: formatUsd(ledger.equityCents - ledger.startingCapitalCents),
      // The local calendar, not a vendor call: this payload is built on every
      // dashboard poll and must never cost a request.
      marketOpen: calendar.isOpen,
      marketReason: calendar.reason,
      killSwitch: health.killed,
      runState: strategy?.runState ?? 'UNKNOWN',
    },

    cadence: {
      xScanSeconds: app.ops.xScanIntervalSeconds,
      xEventWatchSeconds: app.ops.xEventWatchIntervalSeconds,
      xPressureSeconds: app.ops.xApiPressureIntervalSeconds,
      positionMonitorSeconds: app.ops.positionMonitorIntervalSeconds,
      reconciliationSeconds: app.ops.reconciliationIntervalSeconds,
      sameTickerCooldownMinutes: app.ops.sameTickerCooldownMinutes,
      signalTtlMinutes: app.ops.signalTtlMinutes,
      requestsPerScan: app.requestsPerScan(),
      estimatedDailyXRequests: app.estimateDailyRequests().requests,
    },

    api: app.apiMeter.today().map((u) => {
      const pressure = app.apiMeter.underPressure(u.provider as 'x');
      return {
        provider: u.provider,
        requests: u.requests,
        successes: u.successes,
        rateLimited: u.rateLimited,
        errors: u.unauthorized + u.forbidden + u.timeouts + u.serverErrors + u.otherErrors,
        lastSuccessAt: u.lastSuccessAt,
        minutesSinceSuccess: u.minutesSinceSuccess,
        lastErrorAt: u.lastErrorAt,
        lastErrorKind: u.lastErrorKind,
        lastErrorDetail: u.lastErrorDetail,
        rateLimitRemaining: u.rateLimitRemaining,
        rateLimitLimit: u.rateLimitLimit,
        rateLimitResetAt: u.rateLimitResetAt,
        softCapUsedPct: u.softCapUsedPct,
        pressured: pressure.pressured,
        pressureReason: pressure.reason,
      };
    }),

    eventWatch: polling.watching,

    funnel: {
      stages: funnel.stages,
      stalledAt: funnel.stalledAt,
      narrative: funnel.narrative,
    },

    feed: buildFeed(app),
  };
}

/**
 * The raw X side, annotated with what the pipeline decided about each post.
 *
 * This is the panel that answers "the bot saw this post — why did nothing
 * happen?" without opening the database. Every post carries its filter verdict
 * and reasons, so a silent day is legible rather than mysterious.
 */
function buildFeed(app: NorthstarApp): ObservabilityPayload['feed'] {
  const events = app.store.events.recent(40);
  const signals = app.store.signals.recent(100);

  const signalByEvent = new Map<string, { signalId: string; score: number }>();
  for (const signal of signals) {
    for (const eventId of signal.triggeringEventIds) {
      if (!signalByEvent.has(eventId)) signalByEvent.set(eventId, { signalId: signal.signalId, score: signal.score });
    }
  }

  return events.map((e) => {
    const filter = app.store.filters.byEvent(e.eventId);
    const signal = signalByEvent.get(e.eventId) ?? null;
    return {
      postId: e.postId,
      handle: e.authorHandle,
      tier: `T${e.sourceTier}`,
      postedAt: e.postedAt,
      capturedAt: e.capturedAt,
      text: e.text.length > 240 ? `${e.text.slice(0, 237)}…` : e.text,
      url: e.url,
      verdict: filter?.verdict ?? null,
      verdictReasons: filter?.reasons ?? [],
      resolvedTickers: app.store.resolutions.byEvent(e.eventId).map((r) => r.ticker),
      signalId: signal?.signalId ?? null,
      signalScore: signal?.score ?? null,
    };
  });
}
