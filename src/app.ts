/**
 * Composition root.
 *
 * Everything is wired here and nowhere else: which provider implementation is
 * used, which strategy version is loaded, which mode the broker runs in. The
 * rest of the codebase depends only on interfaces, which is what lets the whole
 * pipeline run against fixtures in tests and against X/Tiingo/Alpaca in
 * production without a single conditional inside the strategy.
 */
import type { Clock, Logger } from './core/index.js';
import { ConsoleLogger, randomId, SystemClock } from './core/index.js';
import {
  alpacaPaperCredentialReport,
  loadAlpacaCredentials,
  loadEnv,
  tiingoCredentialReport,
  xCredentialReport,
  type CredentialReport,
  type NorthstarEnv,
} from './config/env.js';
import { estimateDailyXRequests, loadOperations, type OperationsConfig } from './config/operations.js';
import { getSignalConfig, type SignalEngineConfig } from './config/signalConfig.js';
import {
  fingerprintVersion,
  latestVersion,
  X_STRATEGY_ID,
  type StrategyVersionSpec,
} from './config/strategyRegistry.js';
import { ACTIVE_EPOCH, maxPositionCentsFor, type ExecutionEpochSpec } from './config/executionEpochs.js';
import { assessStorage, type StorageAssessment } from './runtime/StorageCheck.js';
import { ManualSocialProvider } from './providers/social/ManualSocialProvider.js';
import { ManualIngestService } from './ingest/ManualIngestService.js';
import {
  manualIngestPermitted,
  resolveWindow,
  type ManualIngestWindow,
} from './config/manualIngest.js';
import type { Strategy, TradingMode } from './domain/types.js';
import { openDatabase } from './persistence/db.js';
import { Store } from './persistence/store.js';
import { ForwardReturnService } from './pipeline/analytics/forwardReturns.js';
import { SignalAnalyticsService } from './pipeline/analytics/signalAnalytics.js';
import { SurvivalService } from './pipeline/analytics/survival.js';
import { ExitEngine } from './pipeline/execution/ExitEngine.js';
import { OrderRouter } from './pipeline/execution/OrderRouter.js';
import { PositionManager } from './pipeline/execution/PositionManager.js';
import { PostFilter } from './pipeline/filtering.js';
import { IngestionService } from './pipeline/ingestion.js';
import { CapitalLedgerService } from './pipeline/ledger.js';
import { ProposalBuilder } from './pipeline/proposal.js';
import { RiskEngine } from './pipeline/risk.js';
import { XSignalEngine } from './pipeline/signal/SignalEngine.js';
import { TickerResolver } from './pipeline/tickerResolution.js';
import { AlpacaBrokerProvider } from './providers/broker/AlpacaBrokerProvider.js';
import type { BrokerProvider } from './providers/broker/BrokerProvider.js';
import { SimulatedBrokerProvider } from './providers/broker/SimulatedBrokerProvider.js';
import { CachingMarketDataProvider } from './providers/marketdata/CachingMarketDataProvider.js';
import { FixtureMarketDataProvider } from './providers/marketdata/FixtureMarketDataProvider.js';
import type { MarketDataProvider } from './providers/marketdata/MarketDataProvider.js';
import { TiingoMarketDataProvider } from './providers/marketdata/TiingoMarketDataProvider.js';
import { FixtureSocialProvider } from './providers/social/FixtureSocialProvider.js';
import type { SocialDataProvider } from './providers/social/SocialDataProvider.js';
import { SourceRegistry } from './providers/social/sourceRegistry.js';
import { XProvider } from './providers/social/XProvider.js';
import { ApiMeter } from './runtime/ApiMeter.js';
import { ApprovalService } from './runtime/ApprovalService.js';
import { DailyReportService } from './runtime/DailyReport.js';
import { FunnelService } from './runtime/Funnel.js';
import { HealthGuard } from './runtime/HealthGuard.js';
import { PollingPolicy } from './runtime/PollingPolicy.js';
import { ReadinessService } from './runtime/Readiness.js';
import { AutonomyGate } from './runtime/AutonomyGate.js';
import { ReconciliationService } from './runtime/Reconciliation.js';
import { Scheduler } from './runtime/Scheduler.js';
import { SessionWatch } from './runtime/SessionWatch.js';
import { SignalAuditService } from './runtime/SignalAudit.js';
import { StrategyRunner } from './runtime/StrategyRunner.js';
import { UniverseRegistry } from './universe/UniverseRegistry.js';
import { fileUniverseSource, loadUniverse, type UniverseSource } from './universe/load.js';
import type { UniverseProvenance } from './universe/contract.js';

export interface NorthstarAppOptions {
  env?: NorthstarEnv;
  clock?: Clock;
  logger?: Logger;
  /** Override the trading mode; defaults to PAPER. */
  mode?: TradingMode;
  /** Inject providers directly (tests, replay). */
  social?: SocialDataProvider;
  marketData?: MarketDataProvider;
  broker?: BrokerProvider;
  databasePath?: string;
  strategySpec?: StrategyVersionSpec;
  /**
   * Override the execution epoch (tests, replay).
   *
   * Production takes the active epoch from the declared registry, never from
   * the environment: a typo in a deployment variable must not be able to change
   * how much capital the bot deploys.
   */
  epoch?: ExecutionEpochSpec;
  /** Override operational cadences (tests, replay). */
  operations?: Partial<OperationsConfig>;
  /** Supply the universe directly (tests, or a future HTTP source). */
  universeSource?: UniverseSource | null;
}

export class NorthstarApp {
  readonly env: NorthstarEnv;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly store: Store;
  readonly universe: UniverseRegistry;
  readonly sourceRegistry: SourceRegistry;
  readonly spec: StrategyVersionSpec;
  /** The execution epoch this run deploys capital under. */
  readonly epoch: ExecutionEpochSpec;
  readonly signalConfig: SignalEngineConfig;
  readonly ops: OperationsConfig;
  readonly mode: TradingMode;

  readonly social: SocialDataProvider;
  readonly marketData: MarketDataProvider;
  readonly broker: BrokerProvider;
  /** Non-null only when the market-data provider is wrapped for caching. */
  readonly marketDataCache: CachingMarketDataProvider | null;

  readonly apiMeter: ApiMeter;
  readonly polling: PollingPolicy;

  readonly ledger: CapitalLedgerService;
  readonly health: HealthGuard;
  readonly ingestion: IngestionService;
  readonly filter: PostFilter;
  readonly resolver: TickerResolver;
  readonly signalEngine: XSignalEngine;
  readonly proposalBuilder: ProposalBuilder;
  readonly riskEngine: RiskEngine;
  readonly orderRouter: OrderRouter;
  readonly positionManager: PositionManager;
  readonly exitEngine: ExitEngine;
  readonly forwardReturns: ForwardReturnService;
  readonly survival: SurvivalService;
  readonly analytics: SignalAnalyticsService;
  readonly approvals: ApprovalService;
  readonly runner: StrategyRunner;
  readonly audit: SignalAuditService;
  readonly reconciliation: ReconciliationService;
  readonly readiness: ReadinessService;
  /** Decides whether orders may be placed with no human in the loop. */
  readonly autonomy: AutonomyGate;
  /** Accepts operator-supplied X posts during the temporary experiment. */
  readonly manualIngest: ManualIngestService;
  readonly scheduler: Scheduler;
  readonly session: SessionWatch;
  readonly funnel: FunnelService;
  readonly dailyReport: DailyReportService;

  constructor(opts: NorthstarAppOptions = {}) {
    this.env = opts.env ?? loadEnv();
    this.clock = opts.clock ?? new SystemClock();
    this.logger = opts.logger ?? new ConsoleLogger(this.env.logLevel as 'info');
    this.mode = opts.mode ?? 'PAPER';

    const db = openDatabase(opts.databasePath ?? this.env.databasePath);
    this.store = new Store(db, this.clock);

    this.ops = loadOperations(opts.operations);
    this.apiMeter = new ApiMeter(this.store, this.clock, { x: this.ops.xDailyRequestSoftCap });
    this.polling = new PollingPolicy(this.ops, this.clock, this.logger, this.apiMeter);

    this.spec = opts.strategySpec ?? latestVersion(X_STRATEGY_ID);
    this.signalConfig = getSignalConfig(this.spec.signalConfigId);

    /*
     * The execution epoch decides the capital, not the strategy version.
     *
     * `x-signal-v1` declares $50 and keeps declaring it — that number is inside
     * its fingerprint and is the historical record of what the published
     * version said. What the bot actually deploys is the ACTIVE epoch's
     * capital, which can change without republishing the strategy because
     * capital is an execution decision, not a belief about the market.
     */
    this.epoch = opts.epoch ?? ACTIVE_EPOCH;

    /* ----------------------------------------------------- universe --- */
    /*
     * The ACTIVE universe is decided by what is configured now, not by what is
     * stored from a previous run. Persisted securities are a record of the last
     * universe used, and reusing them silently would mean a session that once
     * had a Platform snapshot keeps trading that list after the snapshot is
     * gone — presenting stale Platform data as current. The persisted copy is
     * refreshed by `seed()`; the decision is made here, every start.
     */
    const loaded = loadUniverse(
      opts.universeSource ?? (this.env.universeFile ? fileUniverseSource(this.env.universeFile) : null),
      this.logger,
    );
    this.universe = new UniverseRegistry(loaded.securities).withProvenance(loaded.provenance);
    this.sourceRegistry = new SourceRegistry();

    /* ---------------------------------------------------- providers --- */
    // Injected providers (tests, replay) are used exactly as given; only the
    // real vendor path is wrapped, so a test's provider stays observable.
    const marketData = opts.marketData ?? this.buildMarketData();
    this.marketDataCache =
      opts.marketData === undefined && marketData.providerId === 'tiingo'
        ? new CachingMarketDataProvider({
            delegate: marketData,
            clock: this.clock,
            logger: this.logger,
            quoteCacheSeconds: this.ops.quoteCacheSeconds,
            historyRefreshMinutes: this.ops.historyRefreshMinutes,
          })
        : null;
    this.marketData = this.marketDataCache ?? marketData;
    this.social = opts.social ?? this.buildSocial();
    this.broker = opts.broker ?? this.buildBroker(this.mode);

    /* ------------------------------------------------------ services --- */
    this.ledger = new CapitalLedgerService(
      this.store, this.clock, this.logger, this.spec.strategyId, this.epoch.epochId);
    this.health = new HealthGuard(this.store, this.clock, this.logger, this.spec.strategyId, this.epoch.epochId, {
      socialFailureTolerance: this.env.xFailureTolerance,
      brokerFailureTolerance: 3,
      marketDataFailureTolerance: 5,
    });

    this.ingestion = new IngestionService({
      provider: this.social,
      store: this.store,
      universe: this.universe,
      clock: this.clock,
      logger: this.logger,
      // These come from OperationsConfig rather than the service's own
      // defaults. Left unwired, NORTHSTAR_X_COLD_START_MINUTES was a setting
      // that existed, was documented, and did nothing.
      lookbackMinutes: this.ops.xColdStartLookbackMinutes,
      limit: this.ops.xMaxResultsPerRequest,
    });
    this.filter = new PostFilter();
    this.resolver = new TickerResolver(this.universe);

    this.signalEngine = new XSignalEngine({
      store: this.store,
      marketData: this.marketData,
      config: this.signalConfig,
      clock: this.clock,
      logger: this.logger,
      strategyId: this.spec.strategyId,
      strategyVersion: this.spec.version,
      benchmarkTicker: this.spec.benchmarkTicker,
    });

    this.proposalBuilder = new ProposalBuilder({
      clock: this.clock,
      logger: this.logger,
      exitRules: this.spec.exitRules,
      proposalTtlMinutes: this.ops.proposalTtlMinutes,
    });

    this.riskEngine = new RiskEngine(this.store, this.universe, this.ledger, this.clock, this.logger);

    this.orderRouter = new OrderRouter({
      store: this.store,
      broker: this.broker,
      marketData: this.marketData,
      ledger: this.ledger,
      clock: this.clock,
      logger: this.logger,
      signalTtlMinutes: this.ops.signalTtlMinutes,
    });

    this.positionManager = new PositionManager({
      store: this.store,
      broker: this.broker,
      ledger: this.ledger,
      clock: this.clock,
      logger: this.logger,
      strategyId: this.spec.strategyId,
      strategyVersion: this.spec.version,
    });

    this.exitEngine = new ExitEngine(this.store, this.spec.exitRules, this.clock, this.logger, this.spec.strategyId);

    this.forwardReturns = new ForwardReturnService({
      store: this.store,
      marketData: this.marketData,
      clock: this.clock,
      logger: this.logger,
      strategyId: this.spec.strategyId,
      benchmarkTicker: this.spec.benchmarkTicker,
    });

    this.survival = new SurvivalService({
      store: this.store,
      ledger: this.ledger,
      clock: this.clock,
      strategyId: this.spec.strategyId,
      strategyVersion: this.spec.version,
      benchmarkTicker: this.spec.benchmarkTicker,
    });

    this.analytics = new SignalAnalyticsService(this.store, this.spec.strategyId);

    this.approvals = new ApprovalService(
      this.store,
      this.ledger,
      this.orderRouter,
      this.clock,
      this.logger,
      (securityId) => this.universe.byIdOrNull(securityId)?.companyName ?? securityId,
    );

    this.audit = new SignalAuditService(this.store, this.spec.riskLimits.minResolutionConfidence);

    this.reconciliation = new ReconciliationService(
      this.store,
      this.broker,
      this.ledger,
      this.clock,
      this.logger,
      this.spec.strategyId,
      this.epoch.epochId,
    );

    this.funnel = new FunnelService(this.store, this.clock, this.spec.strategyId, this.apiMeter);

    this.dailyReport = new DailyReportService({
      store: this.store,
      ledger: this.ledger,
      funnel: this.funnel,
      meter: this.apiMeter,
      health: this.health,
      clock: this.clock,
      strategyId: this.spec.strategyId,
    });

    this.readiness = new ReadinessService(this, this.clock, this.logger);
    this.autonomy = new AutonomyGate(this);
    this.manualIngest = new ManualIngestService(
      this.store, this.clock, this.logger, this.spec.strategyId);

    this.runner = new StrategyRunner({
      autonomy: this.autonomy,
      store: this.store,
      universe: this.universe,
      clock: this.clock,
      logger: this.logger,
      health: this.health,
      ingestion: this.ingestion,
      filter: this.filter,
      resolver: this.resolver,
      signalEngine: this.signalEngine,
      proposalBuilder: this.proposalBuilder,
      riskEngine: this.riskEngine,
      orderRouter: this.orderRouter,
      positionManager: this.positionManager,
      exitEngine: this.exitEngine,
      ledger: this.ledger,
      forwardReturns: this.forwardReturns,
      survival: this.survival,
      marketData: this.marketData,
      broker: this.broker,
      signalConfig: this.signalConfig,
      exitRules: this.spec.exitRules,
      strategyId: this.spec.strategyId,
      ops: this.ops,
      onSignal: (signal) => this.polling.watch(signal.ticker, signal.score),
    });

    this.session = new SessionWatch({
      clock: this.clock,
      logger: this.logger,
      ops: this.ops,
      // Dropping the price cache at the open is what stops a pre-market mark
      // from pricing the first session trade.
      onOpen: () => this.marketDataCache?.clear(),
      onEndOfDay: (day) => {
        this.logger.child('eod').info('end-of-day report', { day });
        process.stdout.write(`\n${this.dailyReport.render(this.dailyReport.build(day))}\n`);
      },
    });

    this.scheduler = new Scheduler({
      runner: this.runner,
      reconciliation: this.reconciliation,
      polling: this.polling,
      meter: this.apiMeter,
      ops: this.ops,
      clock: this.clock,
      logger: this.logger,
      session: this.session,
      onStart: () => this.recordRunConfiguration('scheduler'),
      refreshReadiness: () => this.refreshReadiness(),
    });
  }

  /**
   * Create the strategy record, its immutable version spec, the universe and
   * the capital ledger. Idempotent.
   */
  seed(): Strategy {
    const now = this.clock.nowIso();
    const existing = this.store.strategies.byId(this.spec.strategyId);

    const strategy: Strategy = existing ?? {
      strategyId: this.spec.strategyId,
      displayName: this.spec.displayName,
      version: this.spec.version,
      status: 'TESTING',
      runState: 'RUNNING',
      mode: this.mode,
      createdAt: now,
      updatedAt: now,
      // The EPOCH's capital, not the version's. See the epoch registry.
      allocatedCapitalCents: this.epoch.capitalCents,
      benchmarkTicker: this.spec.benchmarkTicker,
      universeSources: this.spec.universeSources,
      riskLimits: this.spec.riskLimits,
      signalConfigId: this.spec.signalConfigId,
      description: this.spec.description,
      haltReason: null,
      haltedAt: null,
    };

    if (existing) {
      // Mode is operator-controlled and may change; the version's material
      // settings are not rewritten in place.
      strategy.mode = this.mode;
      strategy.updatedAt = now;
    }

    this.store.strategies.upsert(strategy);
    this.store.strategies.saveVersionSpec(this.spec.strategyId, this.spec.version, this.spec.publishedAt, this.spec);
    this.universe.persist(this.store);

    for (const entry of this.sourceRegistry.entries()) {
      const author = this.sourceRegistry.classify({
        authorId: `author_${entry.handle}`,
        handle: entry.handle,
        displayName: entry.displayName,
        verified: true,
        followerCount: 0,
      });
      this.store.authors.upsert(author);
    }

    this.recordEpoch(now);
    this.ledger.init(this.epoch.capitalCents);
    return strategy;
  }

  setMode(mode: TradingMode): Strategy {
    const strategy = this.store.strategies.byId(this.spec.strategyId);
    if (!strategy) throw new Error('Strategy not seeded');
    const updated: Strategy = { ...strategy, mode, updatedAt: this.clock.nowIso() };
    this.store.strategies.upsert(updated);
    return updated;
  }

  close(): void {
    this.store.close();
  }

  /* --------------------------------------------------- provider builds */

  /**
   * Fail on a half-configured credential set.
   *
   * ABSENT is a decision ("run on fixtures"). PARTIAL is a mistake, and the
   * worst possible response to it is a fixture provider that looks live. This
   * throws before any provider is constructed.
   */
  private assertNotPartial(report: CredentialReport): void {
    if (report.state === 'PARTIAL') {
      throw new ConfigurationError(report.detail);
    }
  }

  private buildSocial(): SocialDataProvider {
    const credentials = xCredentialReport(this.env);
    this.assertNotPartial(credentials);

    /*
     * The manual-X experiment, when one is open.
     *
     * Chosen only when there is no real API token to use — it exists because
     * the API costs money, not to override it — and NEVER in LIVE, which is
     * enforced here as well as in the gate. Two independent refusals, because
     * this is the one path where hand-typed evidence could reach a broker.
     */
    if (this.env.useFixtures) {
      return new FixtureSocialProvider({ clock: this.clock, registry: this.sourceRegistry });
    }

    if (credentials.state === 'ABSENT' && this.manualIngestSelectable()) {
      return new ManualSocialProvider({
        clock: this.clock,
        store: this.store,
        registry: this.sourceRegistry,
      });
    }

    if (credentials.state === 'ABSENT') {
      return new FixtureSocialProvider({ clock: this.clock, registry: this.sourceRegistry });
    }
    return new XProvider({
      bearerToken: this.env.xBearerToken!,
      baseUrl: this.env.xApiBaseUrl,
      clock: this.clock,
      logger: this.logger,
      registry: this.sourceRegistry,
      meter: this.apiMeter,
      maxResults: this.ops.xMaxResultsPerRequest,
    });
  }

  private buildMarketData(): MarketDataProvider {
    const credentials = tiingoCredentialReport(this.env);
    this.assertNotPartial(credentials);

    if (this.env.useFixtures || credentials.state === 'ABSENT') {
      return new FixtureMarketDataProvider({ clock: this.clock });
    }
    return new TiingoMarketDataProvider({
      apiKey: this.env.tiingoApiKey!,
      baseUrl: this.env.tiingoBaseUrl,
      clock: this.clock,
      logger: this.logger,
      bars: this.store.bars,
      meter: this.apiMeter,
    });
  }

  private buildBroker(mode: TradingMode): BrokerProvider {
    if (this.env.useFixtures) {
      return new SimulatedBrokerProvider({ clock: this.clock, marketData: this.marketData, mode });
    }

    // LIVE credential handling is unchanged: loadAlpacaCredentials enforces the
    // explicit opt-in and the endpoint check, and any failure propagates.
    if (mode === 'LIVE') {
      return new AlpacaBrokerProvider({
        credentials: loadAlpacaCredentials('LIVE'),
        clock: this.clock,
        logger: this.logger,
        meter: this.apiMeter,
      });
    }

    const credentials = alpacaPaperCredentialReport();
    this.assertNotPartial(credentials);

    if (credentials.state === 'ABSENT') {
      return new SimulatedBrokerProvider({ clock: this.clock, marketData: this.marketData, mode: 'PAPER' });
    }

    // Credentials are complete, so the operator intends real paper trading.
    // A construction failure from here is a configuration error to surface,
    // not a reason to quietly hand back a simulator.
    try {
      return new AlpacaBrokerProvider({
        credentials: loadAlpacaCredentials('PAPER'),
        clock: this.clock,
        logger: this.logger,
        meter: this.apiMeter,
      });
    } catch (e) {
      throw new ConfigurationError(
        `Alpaca PAPER credentials are set but the broker could not be created: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  /**
   * Persist the exact, non-secret configuration this session is running.
   *
   * The strategy version spec alone is not enough to explain a day's results.
   * It records WHAT the strategy believes but not HOW FAST it acted, and it
   * stores the signal config by id — a pointer into code, which is only
   * meaningful while that code still exists unchanged. A month from now,
   * "x-signal-v1 with a 30-minute cooldown" and "x-signal-v1 with a 5-minute
   * cooldown" would be indistinguishable in the record, though they are not
   * the same experiment.
   *
   * So the full picture is written to the append-only decision log at the
   * moment a session begins: weights, thresholds, bands, risk limits, exit
   * rules, cadence, cooldown, expiries and capital.
   *
   * Assembled field by field from configuration objects that hold no
   * credentials. Nothing from `process.env` and nothing from `this.env`
   * reaches it — see the test that asserts the written payload is clean.
   */
  /**
   * Write the active epoch, and close any other that still claims to be active.
   *
   * The snapshot is taken here rather than assembled at read time so a run
   * stays reconstructable: months later, the allocation, strategy version,
   * fingerprint, universe and operational settings that produced a trade are
   * all readable from one row, whatever the code has since become.
   */
  private recordEpoch(at: string): void {
    const universe = this.universe.origin();
    this.store.epochs.upsert({
      epochId: this.epoch.epochId,
      strategyId: this.epoch.strategyId,
      label: this.epoch.label,
      capitalCents: this.epoch.capitalCents,
      status: 'ACTIVE',
      startedAt: this.store.epochs.byId(this.epoch.epochId)?.startedAt ?? at,
      endedAt: null,
      strategyVersion: this.spec.version,
      strategyFingerprint: fingerprintVersion(this.spec),
      universeVersion: universe.version,
      universeOrigin: universe.origin,
      universeFingerprint: universe.fingerprint,
      configSnapshot: {
        maxPositionPctOfEquity: this.spec.riskLimits.maxPositionPctOfEquity,
        maxConcurrentPositions: this.spec.riskLimits.maxConcurrentPositions,
        maxPositionCents: maxPositionCentsFor(
          this.epoch.capitalCents, this.spec.riskLimits.maxPositionPctOfEquity),
        minSignalScore: this.spec.riskLimits.minSignalScore,
        allowLeverage: this.spec.riskLimits.allowLeverage,
        allowMargin: this.spec.riskLimits.allowMargin,
        allowOptions: this.spec.riskLimits.allowOptions,
        allowShorting: this.spec.riskLimits.allowShorting,
        xScanIntervalSeconds: this.ops.xScanIntervalSeconds,
        positionMonitorIntervalSeconds: this.ops.positionMonitorIntervalSeconds,
        reconciliationIntervalSeconds: this.ops.reconciliationIntervalSeconds,
        signalTtlMinutes: this.ops.signalTtlMinutes,
        proposalTtlMinutes: this.ops.proposalTtlMinutes,
        sameTickerCooldownMinutes: this.ops.sameTickerCooldownMinutes,
      },
      rationale: this.epoch.rationale,
    });

    // Exactly one epoch may be active. Closing rather than deleting keeps the
    // superseded run's ledger and history intact.
    this.store.epochs.closeOthers(this.epoch.strategyId, this.epoch.epochId, at);
  }

  /**
   * Is the manual-X experiment open, and is this a run allowed to use it?
   *
   * LIVE is refused outright — not held for approval, refused. Alpaca LIVE
   * commits real money, and hand-transcribed evidence is not a basis for that
   * however honest the transcription. The experiment exists to test a strategy
   * on real posts without paying for the API, not to shorten the path to money.
   */
  private manualIngestSelectable(): boolean {
    if (this.mode === 'LIVE') return false;
    return this.manualWindow().active;
  }

  /** The manual-X experiment window as it stands right now. */
  manualWindow(): ManualIngestWindow {
    return resolveWindow(this.store.manualWindows.latest(this.spec.strategyId), this.clock);
  }

  /**
   * May manual observations count as real observed data for THIS run?
   *
   * Both the window and the mode, every time. Asked by the autonomy gate rather
   * than cached, so an expiry that passes mid-session withdraws autonomous
   * execution at the next proposal.
   */
  manualIngestPermission(): { permitted: boolean; reason: string } {
    const strategyMode = this.store.strategies.byId(this.spec.strategyId)?.mode ?? this.mode;
    return manualIngestPermitted(
      this.manualWindow(),
      this.broker.mode === 'LIVE' ? 'LIVE' : 'PAPER',
      strategyMode === 'LIVE' ? 'LIVE' : 'PAPER',
    );
  }

  /**
   * Whether the database survives a restart.
   *
   * Exposed here so the autonomy gate and the console read the same assessment
   * the startup banner printed, rather than each forming its own opinion.
   */
  storage(): StorageAssessment {
    return assessStorage(this.env.databasePath);
  }

  /**
   * Run readiness and hand the verdict to the autonomy gate.
   *
   * A failure to RUN readiness is itself a blocking answer: the gate is told it
   * did not pass. Silence would leave a stale pass in force and let the bot keep
   * trading on a verdict that is no longer true.
   */
  async refreshReadiness(): Promise<void> {
    try {
      const report = await this.readiness.run();
      this.autonomy.noteReadiness({
        passed: report.readyForRealDataPaper,
        at: report.at,
        summary: report.readyForRealDataPaperReason,
      });
    } catch (e) {
      this.autonomy.noteReadiness({
        passed: false,
        at: this.clock.nowIso(),
        summary: `Readiness could not be evaluated: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  recordRunConfiguration(trigger: string): void {
    const providers = this.describeProviders();
    this.store.log.append({
      correlationId: randomId('run'),
      strategyId: this.spec.strategyId,
      stage: 'SYSTEM',
      subjectId: `${this.spec.strategyId}@${this.spec.version}`,
      summary: `Session configuration for ${this.spec.strategyId} v${this.spec.version} (${trigger})`,
      payload: {
        trigger,
        startedAt: this.clock.nowIso(),
        strategyId: this.spec.strategyId,
        strategyVersion: this.spec.version,
        strategyFingerprint: fingerprintVersion(this.spec),
        signalConfigId: this.signalConfig.signalConfigId,

        // Component weights and thresholds, by value rather than by reference.
        convictionWeights: this.signalConfig.convictionWeights,
        bands: this.signalConfig.bands,
        maxPriceContribution: this.signalConfig.maxPriceContribution,
        priceGateMinAbsBase: this.signalConfig.priceGateMinAbsBase,
        recencyHalfLifeHours: this.signalConfig.recencyHalfLifeHours,
        maxEventAgeHours: this.signalConfig.maxEventAgeHours,
        resignalIntervalMinutes: this.signalConfig.resignalIntervalMinutes,

        riskLimits: this.spec.riskLimits,
        exitRules: this.spec.exitRules,
        allocatedCapitalCents: this.spec.allocatedCapitalCents,
        benchmarkTicker: this.spec.benchmarkTicker,
        universeSources: this.spec.universeSources,
        universeSize: this.universe.all().length,
        // The exact eligible universe this session traded against, so a trade
        // months from now can be reconstructed against the right list.
        universe: this.universe.origin(),

        operations: this.ops,
        requestsPerScan: this.requestsPerScan(),
        estimatedDailyXRequests: this.estimateDailyRequests().requests,

        // Provider identities, never their credentials.
        providers: {
          x: providers.x,
          marketData: providers.marketData,
          broker: providers.broker,
          mode: providers.mode,
          socialProviderId: this.social.providerId,
          marketDataProviderId: this.marketData.providerId,
          brokerId: this.broker.brokerId,
        },
      },
    });

    this.logger.child('run').info('session configuration recorded', {
      strategyVersion: this.spec.version,
      fingerprint: fingerprintVersion(this.spec),
      trigger,
    });
  }

  /**
   * What one X scan actually costs, right now.
   *
   * Asked of the CONSTRUCTED provider against the LIVE universe, so it reflects
   * the queries that will really be sent. Reading it from anywhere else — a
   * constant, an assumption of one query per scan — produces a budget that is
   * confidently wrong, which is worse than no budget at all.
   */
  requestsPerScan(): number {
    const strategy = this.store.strategies.byId(this.spec.strategyId);
    const sources = strategy?.universeSources ?? this.spec.universeSources;
    const { tickers, keywords } = this.universe.searchTerms(sources);
    return this.social.plannedRequestsPerScan({
      tickers,
      keywords,
      since: this.clock.nowIso(),
      limit: this.ops.xMaxResultsPerRequest,
    });
  }

  /** Projected X requests for a full session at the configured cadence. */
  estimateDailyRequests(hoursActive = 6.5): ReturnType<typeof estimateDailyXRequests> {
    return estimateDailyXRequests(this.ops, {
      queriesPerScan: this.requestsPerScan(),
      hoursActive,
    });
  }

  /* ------------------------------------------------------------- banner */

  /**
   * What is actually wired up, read from the constructed providers rather than
   * from the environment.
   *
   * Deriving this from the live objects is the point: the banner cannot drift
   * out of agreement with what the bot is really using, however the providers
   * were selected or injected.
   */
  describeProviders(): ProviderSummary {
    const forced = this.env.useFixtures;
    /*
     * Three states, not two. A manual post is real, but it is not the API, and
     * a dashboard that showed "LIVE" for hand-typed evidence would be lying
     * about where the bot's information comes from.
     */
    const social: ProviderSummary['x'] =
      this.social.providerId === 'x-api-v2' ? 'LIVE'
      : this.social.providerId === 'x-manual' ? 'MANUAL'
      : 'FIXTURE';
    const marketData = this.marketData.providerId === 'tiingo' ? 'TIINGO' : 'FIXTURE';
    const broker = this.broker.brokerId === 'alpaca' ? `ALPACA ${this.broker.mode}` : 'SIMULATED';
    const mode = this.store.strategies.byId(this.spec.strategyId)?.mode ?? this.mode;

    return {
      x: social,
      marketData,
      broker,
      mode,
      universe: this.universe.origin(),
      allReal: social === 'LIVE' && marketData === 'TIINGO' && this.broker.brokerId === 'alpaca',
      forcedFixtures: forced,
      manual: this.manualWindow(),
    };
  }
}

/** A misconfiguration the operator must fix; never a reason to fall back. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

export interface ProviderSummary {
  /**
   * `MANUAL` is real, operator-supplied X posts during the temporary
   * experiment. Deliberately not folded into `LIVE`: they are real data, but
   * they are not the API, and the difference is auditable.
   */
  x: 'LIVE' | 'MANUAL' | 'FIXTURE';
  marketData: 'TIINGO' | 'FIXTURE';
  broker: string;
  mode: TradingMode;
  /** Which universe is active, and where it came from. */
  universe: UniverseProvenance;
  /** True only when X, Tiingo and Alpaca are all the real thing. */
  allReal: boolean;
  /** True when NORTHSTAR_USE_FIXTURES overrode otherwise-valid credentials. */
  forcedFixtures: boolean;
  /** The manual-X experiment window, open or not. */
  manual: ManualIngestWindow;
}
