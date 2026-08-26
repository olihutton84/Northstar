/**
 * Operational configuration.
 *
 * This is deliberately SEPARATE from the versioned strategy spec.
 *
 *   StrategyVersionSpec  =  what to trade and on what evidence  (immutable)
 *   OperationsConfig     =  how fast to look, act and check     (tunable)
 *
 * Polling cadence, API budgets, the same-ticker cooldown and signal TTL are
 * execution-rate controls, not signal logic. Folding them into the strategy
 * version would mean every cadence tweak published a new strategy version and
 * invalidated the comparison baseline — and would make `x-signal-v1` mean
 * something different depending on which day you ran it.
 *
 * Everything here is environment-overridable so tomorrow's cadence can be
 * changed without a code change.
 */

export interface OperationsConfig {
  /* ------------------------------------------------------------- X polling */
  /** Baseline X scan cadence. */
  xScanIntervalSeconds: number;
  /** Faster cadence while a material story is developing on a security. */
  xEventWatchIntervalSeconds: number;
  /** How long a security stays on event watch. */
  xEventWatchMinutes: number;
  /** Composite score at or above which a new event triggers event watch. */
  xEventWatchTriggerScore: number;
  /** Cadence while under rate-limit pressure. */
  xApiPressureIntervalSeconds: number;
  /** Consecutive 429s after which the exponential backoff resets. */
  xBackoffResetAfterMinutes: number;
  /** Ceiling on exponential backoff. */
  xMaxBackoffSeconds: number;
  /** How far back each scan looks when no cursor exists yet. */
  xColdStartLookbackMinutes: number;
  /** Maximum posts requested per X search request. */
  xMaxResultsPerRequest: number;
  /** Soft daily request budget; crossing it moves polling to API pressure. */
  xDailyRequestSoftCap: number;

  /* --------------------------------------------------------- market data */
  /** Cadence for re-marking open positions. */
  positionMonitorIntervalSeconds: number;
  /** Quote cache TTL: a quote younger than this is reused, not refetched. */
  quoteCacheSeconds: number;
  /** Daily bars are refetched at most this often per ticker. */
  historyRefreshMinutes: number;

  /* --------------------------------------------------------------- broker */
  /** Cadence for full broker reconciliation. */
  reconciliationIntervalSeconds: number;

  /* ---------------------------------------------------- trading controls */
  /**
   * Minimum minutes between two ENTRIES in the same ticker.
   *
   * A safety control, not a strategy parameter: it bounds how fast the bot can
   * act on one developing story, whatever the signal says.
   */
  sameTickerCooldownMinutes: number;
  /** A signal older than this can no longer produce an executable proposal. */
  signalTtlMinutes: number;
  /** A proposal older than this is expired and must be regenerated. */
  proposalTtlMinutes: number;

  /* -------------------------------------------------------------- reports */
  /** Emit the end-of-day report once the market has been closed this long. */
  endOfDayReportDelayMinutes: number;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Day-one defaults.
 *
 * The X cadence is 120s rather than anything faster because the bot is looking
 * for NEW information, not re-reading the same posts: a scan that returns
 * nothing new costs a request and produces nothing, so the useful rate is set
 * by how often genuinely new material appears, which is minutes, not seconds.
 */
export const DEFAULT_OPERATIONS: OperationsConfig = {
  xScanIntervalSeconds: 120,
  xEventWatchIntervalSeconds: 60,
  xEventWatchMinutes: 12,
  xEventWatchTriggerScore: 45,
  xApiPressureIntervalSeconds: 300,
  xBackoffResetAfterMinutes: 30,
  xMaxBackoffSeconds: 900,
  xColdStartLookbackMinutes: 30,
  xMaxResultsPerRequest: 100,
  xDailyRequestSoftCap: 400,

  positionMonitorIntervalSeconds: 60,
  quoteCacheSeconds: 45,
  historyRefreshMinutes: 60,

  reconciliationIntervalSeconds: 180,

  sameTickerCooldownMinutes: 30,
  signalTtlMinutes: 45,
  proposalTtlMinutes: 15,

  endOfDayReportDelayMinutes: 10,
};

export function loadOperations(overrides: Partial<OperationsConfig> = {}): OperationsConfig {
  return {
    xScanIntervalSeconds: num('NORTHSTAR_X_SCAN_SECONDS', DEFAULT_OPERATIONS.xScanIntervalSeconds),
    xEventWatchIntervalSeconds: num('NORTHSTAR_X_EVENT_WATCH_SECONDS', DEFAULT_OPERATIONS.xEventWatchIntervalSeconds),
    xEventWatchMinutes: num('NORTHSTAR_X_EVENT_WATCH_MINUTES', DEFAULT_OPERATIONS.xEventWatchMinutes),
    xEventWatchTriggerScore: num('NORTHSTAR_X_EVENT_WATCH_SCORE', DEFAULT_OPERATIONS.xEventWatchTriggerScore),
    xApiPressureIntervalSeconds: num('NORTHSTAR_X_PRESSURE_SECONDS', DEFAULT_OPERATIONS.xApiPressureIntervalSeconds),
    xBackoffResetAfterMinutes: num('NORTHSTAR_X_BACKOFF_RESET_MINUTES', DEFAULT_OPERATIONS.xBackoffResetAfterMinutes),
    xMaxBackoffSeconds: num('NORTHSTAR_X_MAX_BACKOFF_SECONDS', DEFAULT_OPERATIONS.xMaxBackoffSeconds),
    xColdStartLookbackMinutes: num('NORTHSTAR_X_COLD_START_MINUTES', DEFAULT_OPERATIONS.xColdStartLookbackMinutes),
    xMaxResultsPerRequest: num('NORTHSTAR_X_MAX_RESULTS', DEFAULT_OPERATIONS.xMaxResultsPerRequest),
    xDailyRequestSoftCap: num('NORTHSTAR_X_DAILY_SOFT_CAP', DEFAULT_OPERATIONS.xDailyRequestSoftCap),

    positionMonitorIntervalSeconds: num('NORTHSTAR_POSITION_MONITOR_SECONDS', DEFAULT_OPERATIONS.positionMonitorIntervalSeconds),
    quoteCacheSeconds: num('NORTHSTAR_QUOTE_CACHE_SECONDS', DEFAULT_OPERATIONS.quoteCacheSeconds),
    historyRefreshMinutes: num('NORTHSTAR_HISTORY_REFRESH_MINUTES', DEFAULT_OPERATIONS.historyRefreshMinutes),

    reconciliationIntervalSeconds: num('NORTHSTAR_RECONCILE_SECONDS', DEFAULT_OPERATIONS.reconciliationIntervalSeconds),

    sameTickerCooldownMinutes: num('NORTHSTAR_TICKER_COOLDOWN_MINUTES', DEFAULT_OPERATIONS.sameTickerCooldownMinutes),
    signalTtlMinutes: num('NORTHSTAR_SIGNAL_TTL_MINUTES', DEFAULT_OPERATIONS.signalTtlMinutes),
    proposalTtlMinutes: num('NORTHSTAR_PROPOSAL_TTL_MINUTES', DEFAULT_OPERATIONS.proposalTtlMinutes),

    endOfDayReportDelayMinutes: num('NORTHSTAR_EOD_DELAY_MINUTES', DEFAULT_OPERATIONS.endOfDayReportDelayMinutes),
    ...overrides,
  };
}

/**
 * Estimated X requests for a full trading day at a given cadence.
 *
 * Deliberately explicit rather than a rule of thumb: the number is what decides
 * whether a plan's quota survives the day, and it should be checkable before
 * the day rather than discovered during it.
 */
export function estimateDailyXRequests(
  ops: OperationsConfig,
  opts: { queriesPerScan: number; hoursActive: number; eventWatchFraction?: number },
): { scans: number; requests: number; detail: string } {
  const eventFraction = Math.min(1, Math.max(0, opts.eventWatchFraction ?? 0.1));
  const seconds = opts.hoursActive * 3600;

  const normalSeconds = seconds * (1 - eventFraction);
  const watchSeconds = seconds * eventFraction;

  const scans =
    Math.round(normalSeconds / ops.xScanIntervalSeconds) +
    Math.round(watchSeconds / ops.xEventWatchIntervalSeconds);
  const requests = scans * Math.max(1, opts.queriesPerScan);

  return {
    scans,
    requests,
    detail:
      `${opts.hoursActive}h active, ${ops.xScanIntervalSeconds}s normal / ` +
      `${ops.xEventWatchIntervalSeconds}s event-watch (${(eventFraction * 100).toFixed(0)}% of the time), ` +
      `${opts.queriesPerScan} batched quer${opts.queriesPerScan === 1 ? 'y' : 'ies'} per scan`,
  };
}
