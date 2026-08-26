/**
 * Test harness.
 *
 * Builds a complete NorthstarApp against an in-memory database, a fixed clock
 * and fixture providers, so the entire pipeline runs deterministically with no
 * network. Because the providers implement the same interfaces as X, Tiingo and
 * Alpaca, the code under test is exactly the production code path.
 */
import { FixedClock, NullLogger } from '../../src/core/index.js';
import type { NorthstarEnv } from '../../src/config/env.js';
import type { OperationsConfig } from '../../src/config/operations.js';
import { NorthstarApp } from '../../src/app.js';
import type { TradingMode } from '../../src/domain/types.js';
import { FixtureMarketDataProvider } from '../../src/providers/marketdata/FixtureMarketDataProvider.js';
import { FixtureSocialProvider, type FixturePost } from '../../src/providers/social/FixtureSocialProvider.js';
import { SimulatedBrokerProvider } from '../../src/providers/broker/SimulatedBrokerProvider.js';
import type { BrokerProvider } from '../../src/providers/broker/BrokerProvider.js';
import type { UniverseSource } from '../../src/universe/load.js';
import { ACTIVE_EPOCH, type ExecutionEpochSpec } from '../../src/config/executionEpochs.js';
import { SourceRegistry } from '../../src/providers/social/sourceRegistry.js';

/** Tuesday 10 March 2026, 11:00 New York — the market is open. */
export const TEST_NOW = '2026-03-10T15:00:00.000Z';

export const TEST_PRICES: Record<string, number> = {
  NVDA: 120,
  AAPL: 200,
  TSLA: 250,
  AMD: 150,
  PFE: 30,
  SPY: 500,
  MSFT: 400,
};

export function testEnv(overrides: Partial<NorthstarEnv> = {}): NorthstarEnv {
  return {
    nodeEnv: 'test',
    dataDir: './data',
    databasePath: ':memory:',
    httpPort: 0,
    httpHost: '127.0.0.1',
    logLevel: 'error',
    xBearerToken: null,
    xApiBaseUrl: 'https://api.twitter.com/2',
    xFailureTolerance: 3,
    tiingoApiKey: null,
    tiingoBaseUrl: 'https://api.tiingo.com',
    liveTradingEnabled: false,
    approverId: 'test-operator',
    useFixtures: true,
    universeFile: null,
    runnerEnabled: true,
    ...overrides,
  };
}

export interface Harness {
  app: NorthstarApp;
  clock: FixedClock;
  social: FixtureSocialProvider;
  marketData: FixtureMarketDataProvider;
  /**
   * The simulated broker.
   *
   * Typed concretely because almost every test drives its failure-injection
   * helpers. A test that substitutes its own broker via `opts.broker` holds its
   * own reference to it and should use that instead of this field.
   */
  broker: SimulatedBrokerProvider;
  registry: SourceRegistry;
  close(): void;
}

export interface HarnessOptions {
  now?: string;
  mode?: TradingMode;
  posts?: FixturePost[];
  prices?: Record<string, number>;
  /** Days of synthetic daily history seeded per ticker. */
  historyDays?: number;
  /** Percent daily drift baked into the synthetic history. */
  driftPct?: number;
  liveTradingEnabled?: boolean;
  seed?: boolean;
  /** Substitute a failure-injecting broker for the simulated one. */
  broker?: BrokerProvider;
  /** Supply a platform universe snapshot instead of the bot fallback. */
  universeSource?: UniverseSource | null;
  /**
   * Back the database with a file instead of memory.
   *
   * Required to simulate a restart: an in-memory database dies with the
   * process it belongs to, so a crash-and-reload test needs somewhere the
   * state can genuinely survive.
   */
  databasePath?: string;
  /** Override operational cadences and rate gates. */
  operations?: Partial<OperationsConfig>;
  /**
   * Run under a specific execution epoch.
   *
   * Defaults to the ACTIVE one, so tests exercise the capital the bot really
   * deploys. A test that is about a historical run pins that run's epoch.
   */
  epoch?: ExecutionEpochSpec;
}

export function createHarness(opts: HarnessOptions = {}): Harness {
  const clock = new FixedClock(opts.now ?? TEST_NOW);
  const logger = new NullLogger();
  const registry = new SourceRegistry();

  const prices = { ...TEST_PRICES, ...(opts.prices ?? {}) };
  const marketData = new FixtureMarketDataProvider({ clock, prices, forceMarketOpen: true });
  for (const [ticker, price] of Object.entries(prices)) {
    marketData.seedHistory(ticker, opts.historyDays ?? 25, price, opts.driftPct ?? 0.2);
  }

  const social = new FixtureSocialProvider({ clock, registry, posts: opts.posts ?? [] });
  const broker = opts.broker ?? new SimulatedBrokerProvider({
    clock,
    marketData,
    mode: opts.mode ?? 'PAPER',
    tradableTickers: Object.keys(prices),
  });

  const app = new NorthstarApp({
    env: testEnv({ liveTradingEnabled: opts.liveTradingEnabled ?? false }),
    clock,
    logger,
    mode: opts.mode ?? 'PAPER',
    social,
    marketData,
    broker,
    databasePath: opts.databasePath ?? ':memory:',
    ...(opts.universeSource !== undefined ? { universeSource: opts.universeSource } : {}),
    epoch: opts.epoch ?? ACTIVE_EPOCH,
    ...(opts.operations ? { operations: opts.operations } : {}),
  });

  // Mirror the production write-through so `replay export` has history to
  // export in tests and offline development, not only against Tiingo.
  marketData.attachBarCache(app.store.bars);

  if (opts.seed !== false) app.seed();

  return {
    app,
    clock,
    social,
    marketData,
    broker: broker as SimulatedBrokerProvider,
    registry,
    close: () => app.close(),
  };
}

/* --------------------------------------------------------------- posts */

/** A Tier-1 company account announcing a strongly material, positive event. */
export function bullishTier1Post(overrides: Partial<FixturePost> = {}): FixturePost {
  return {
    postId: 'post-nvda-guidance-1',
    handle: 'nvidia',
    displayName: 'NVIDIA',
    verified: true,
    followerCount: 3_000_000,
    text:
      'NVIDIA raises guidance for the third quarter to $32.5B, up 24% sequentially. ' +
      'Data centre demand continues to exceed our prior outlook. $NVDA',
    minutesAgo: 5,
    likes: 8200,
    reposts: 2100,
    replies: 640,
    quotes: 380,
    baselineEngagement: 1200,
    ...overrides,
  };
}

/** A Tier-2 journalist corroborating the same development. */
export function corroboratingTier2Post(overrides: Partial<FixturePost> = {}): FixturePost {
  return {
    postId: 'post-nvda-guidance-2',
    handle: 'reuters',
    displayName: 'Reuters',
    verified: true,
    followerCount: 26_000_000,
    text:
      'Nvidia lifts quarterly guidance to $32.5 billion on accelerating data centre demand, ' +
      'well ahead of analyst expectations of $29.1 billion. $NVDA',
    minutesAgo: 4,
    likes: 3100,
    reposts: 1400,
    replies: 220,
    quotes: 190,
    baselineEngagement: 900,
    ...overrides,
  };
}

/** A Tier-1 regulator announcing a strongly material, negative event. */
export function bearishTier1Post(overrides: Partial<FixturePost> = {}): FixturePost {
  return {
    postId: 'post-tsla-probe-1',
    handle: 'sec_news',
    displayName: 'U.S. Securities and Exchange Commission',
    verified: true,
    followerCount: 900_000,
    text:
      'The SEC has opened a formal investigation into Tesla over accounting irregularities ' +
      'in its 2025 filings, seeking documents covering $1.2B of recognised revenue. $TSLA',
    minutesAgo: 6,
    likes: 5400,
    reposts: 3200,
    replies: 900,
    quotes: 700,
    baselineEngagement: 400,
    ...overrides,
  };
}

/** Obvious noise: promotional, meme, giveaway and cashtag-stuffed posts. */
export function noisePosts(): FixturePost[] {
  return [
    {
      postId: 'noise-giveaway',
      handle: 'moonboy420',
      text: 'GIVEAWAY! Free shares of $NVDA to 10 lucky followers. Like and retweet to enter to win!',
      minutesAgo: 3,
      likes: 40_000,
      reposts: 30_000,
    },
    {
      postId: 'noise-promo',
      handle: 'signalsguru',
      text: 'My premium group called $NVDA before the move. Use code MOON for 50% off my newsletter today only.',
      minutesAgo: 4,
      likes: 900,
    },
    {
      postId: 'noise-stuffing',
      handle: 'tickerspam',
      text: 'Watchlist today: $NVDA $AAPL $TSLA $AMD $MSFT $PFE all setting up nicely for a big move soon.',
      minutesAgo: 5,
      likes: 120,
    },
    {
      postId: 'noise-meme',
      handle: 'apeinvestor',
      text: 'STONKS ONLY GO UP 🚀🚀🚀 $NVDA diamond hands, apes together strong, this is not financial advice',
      minutesAgo: 6,
      likes: 22_000,
    },
  ];
}

/** Ten accounts repeating one story verbatim — one piece of evidence, not ten. */
export function echoChamber(count = 10): FixturePost[] {
  return Array.from({ length: count }, (_, i) => ({
    postId: `echo-${i}`,
    handle: `retailtrader${i}`,
    text:
      'Nvidia lifts quarterly guidance to $32.5 billion on accelerating data centre demand, ' +
      'well ahead of analyst expectations of $29.1 billion. $NVDA',
    minutesAgo: 3,
    likes: 20 + i,
    reposts: 5,
    baselineEngagement: 15,
  }));
}
