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
import { ConsoleLogger, SystemClock } from './core/index.js';
import {
  alpacaPaperCredentialReport,
  loadAlpacaCredentials,
  loadEnv,
  tiingoCredentialReport,
  xCredentialReport,
  type CredentialReport,
  type NorthstarEnv,
} from './config/env.js';
import { loadOperations, type OperationsConfig } from './config/operations.js';
import { getSignalConfig, type SignalEngineConfig } from './config/signalConfig.js';
import {
  latestVersion,
  X_STRATEGY_ID,
  type StrategyVersionSpec,
} from './config/strategyRegistry.js';
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
import { ReconciliationService } from './runtime/Reconciliation.js';
import { Scheduler } from './runtime/Scheduler.js';
import { SessionWatch } from './runtime/SessionWatch.js';
import { SignalAuditService } from './runtime/SignalAudit.js';
import { StrategyRunner } from './runtime/StrategyRunner.js';
import { UniverseRegistry } from './universe/UniverseRegistry.js';

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
  /** Override operational cadences (tests, replay). */
  operations?: Partial<OperationsConfig>;
}

export class NorthstarApp {
  readonly env: NorthstarEnv;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly store: Store;
  readonly universe: UniverseRegistry;
  readonly sourceRegistry: SourceRegistry;
  readonly spec: StrategyVersionSpec;
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

    /* ----------------------------------------------------- universe --- */
    const persisted = this.store.securities.active();
    this.universe = persisted.length > 0 ? new UniverseRegistry(persisted) : UniverseRegistry.fromSeed();
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
    this.ledger = new CapitalLedgerService(this.store, this.clock, this.logger, this.spec.strategyId);
    this.health = new HealthGuard(this.store, this.clock, this.logger, this.spec.strategyId, {
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

    this.runner = new StrategyRunner({
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
      allocatedCapitalCents: this.spec.allocatedCapitalCents,
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

    this.ledger.init(this.spec.allocatedCapitalCents);
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

    if (this.env.useFixtures || credentials.state === 'ABSENT') {
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
    const social = this.social.providerId === 'x-api-v2' ? 'LIVE' : 'FIXTURE';
    const marketData = this.marketData.providerId === 'tiingo' ? 'TIINGO' : 'FIXTURE';
    const broker = this.broker.brokerId === 'alpaca' ? `ALPACA ${this.broker.mode}` : 'SIMULATED';
    const mode = this.store.strategies.byId(this.spec.strategyId)?.mode ?? this.mode;

    return {
      x: social,
      marketData,
      broker,
      mode,
      allReal: social === 'LIVE' && marketData === 'TIINGO' && this.broker.brokerId === 'alpaca',
      forcedFixtures: forced,
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
  x: 'LIVE' | 'FIXTURE';
  marketData: 'TIINGO' | 'FIXTURE';
  broker: string;
  mode: TradingMode;
  /** True only when X, Tiingo and Alpaca are all the real thing. */
  allReal: boolean;
  /** True when NORTHSTAR_USE_FIXTURES overrode otherwise-valid credentials. */
  forcedFixtures: boolean;
}
