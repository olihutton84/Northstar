/**
 * Offline paper simulation.
 *
 * Drives the real pipeline — the same ingestion, filter, resolver, signal
 * engine, risk engine, order router and exit engine used in production —
 * against a deterministic synthetic X stream and synthetic prices.
 *
 * Its purpose is qualification, not backtesting. It answers "does the machinery
 * run end to end, and do the risk controls actually bind?", NOT "is this
 * strategy profitable". The price series is synthetic, so any P&L it produces
 * is a property of the generator, not evidence about X. The report says so.
 */
import { FixedClock, NullLogger, formatSignedUsd, formatUsd } from '../core/index.js';
import { NorthstarApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import { FixtureMarketDataProvider } from '../providers/marketdata/FixtureMarketDataProvider.js';
import { FixtureSocialProvider, type FixturePost } from '../providers/social/FixtureSocialProvider.js';
import { SimulatedBrokerProvider } from '../providers/broker/SimulatedBrokerProvider.js';
import { SourceRegistry } from '../providers/social/sourceRegistry.js';

const START = '2026-03-02T14:45:00.000Z'; // Monday, 09:45 New York

const TICKERS = ['NVDA', 'AAPL', 'TSLA', 'AMD', 'PFE', 'MSFT'] as const;
const START_PRICES: Record<string, number> = {
  NVDA: 120, AAPL: 200, TSLA: 250, AMD: 150, PFE: 30, MSFT: 400, SPY: 500,
};

/**
 * Deterministic pseudo-random generator, so a simulation run is exactly
 * reproducible from its seed. (Math.random would make the report unrepeatable.)
 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

interface Scenario {
  ticker: string;
  /** Where the underlying goes after the news, in percent. */
  driftPct: number;
  posts: FixturePost[];
}

/** Builds a realistic mix: real stories, noise, echo chambers, rumours. */
function scenarioFor(cycle: number, random: () => number): Scenario | null {
  const roll = random();
  const ticker = TICKERS[Math.floor(random() * TICKERS.length)] ?? 'NVDA';
  const id = `c${cycle}`;

  // 45% of cycles carry no tradable news at all — that is what real days
  // mostly look like, and the bot must be content doing nothing.
  if (roll < 0.45) {
    return {
      ticker,
      driftPct: (random() - 0.5) * 2,
      posts: [
        {
          postId: `${id}-chat`,
          handle: 'apeinvestor',
          text: `Watching ${ticker} closely here, chart looks interesting but nothing confirmed yet. $${ticker}`,
          minutesAgo: 4,
          likes: Math.floor(random() * 500),
          baselineEngagement: 200,
        },
        {
          postId: `${id}-promo`,
          handle: 'signalsguru',
          text: `My premium group nailed $${ticker} again. Use code MOON for 50% off my newsletter.`,
          minutesAgo: 6,
          likes: 300,
        },
      ],
    };
  }

  // 20%: an echo chamber with no credible origin — must not trade.
  if (roll < 0.65) {
    const claim = `Hearing ${ticker} may raise guidance next week, could be a monster beat. $${ticker}`;
    return {
      ticker,
      driftPct: (random() - 0.5) * 4,
      posts: Array.from({ length: 12 }, (_, i) => ({
        postId: `${id}-echo-${i}`,
        handle: `retail${i}`,
        text: claim,
        minutesAgo: 3 + (i % 5),
        likes: 40 + i * 3,
        baselineEngagement: 30,
      })),
    };
  }

  // 35%: a genuine, corroborated Tier-1/Tier-2 story.
  const bullish = random() < 0.55;
  const magnitude = 3 + random() * 9;
  const drift = bullish ? magnitude : -magnitude;

  const bullText = [
    `${ticker} raises full-year guidance to $${(20 + random() * 40).toFixed(1)}B, ahead of prior outlook. $${ticker}`,
    `${ticker} wins a contract worth $${(1 + random() * 8).toFixed(1)}B, the largest in its history. $${ticker}`,
    `${ticker} receives FDA approval for its lead therapy after a successful phase 3 trial. $${ticker}`,
  ];
  const bearText = [
    `${ticker} cuts full-year guidance to $${(10 + random() * 20).toFixed(1)}B, citing weak demand. $${ticker}`,
    `SEC opens a formal investigation into ${ticker} over accounting irregularities covering $${(0.5 + random() * 3).toFixed(1)}B. $${ticker}`,
    `${ticker} announces a product recall affecting 2.4M units after a safety review. $${ticker}`,
  ];
  const pool = bullish ? bullText : bearText;
  const headline = pool[Math.floor(random() * pool.length)]!;

  return {
    ticker,
    driftPct: drift,
    posts: [
      {
        postId: `${id}-t1`,
        handle: bullish ? 'reuters' : 'sec_news',
        text: headline,
        minutesAgo: 5,
        likes: 2000 + Math.floor(random() * 6000),
        reposts: 800 + Math.floor(random() * 2000),
        replies: 200,
        quotes: 150,
        baselineEngagement: 700,
      },
      {
        postId: `${id}-t2`,
        handle: 'cnbc',
        text: headline.replace(`$${ticker}`, `${ticker} shares in focus. $${ticker}`),
        minutesAgo: 4,
        likes: 1200 + Math.floor(random() * 3000),
        reposts: 500,
        replies: 120,
        quotes: 90,
        baselineEngagement: 600,
      },
      // Noise arrives alongside real news, as it does in reality.
      {
        postId: `${id}-noise`,
        handle: 'tickerspam',
        text: `$NVDA $AAPL $TSLA $AMD $MSFT $PFE all moving today, huge day for the market`,
        minutesAgo: 3,
        likes: 90,
      },
    ],
  };
}

export interface SimulationOptions {
  cycles?: number;
  seed?: number;
  /** Minutes of simulated time between cycles. */
  intervalMinutes?: number;
  databasePath?: string;
  verbose?: boolean;
}

export interface SimulationResult {
  cycles: number;
  seed: number;
  app: NorthstarApp;
  perCycle: {
    cycle: number;
    at: string;
    signals: number;
    proposals: number;
    riskApproved: number;
    riskRejected: number;
    orders: number;
    exits: number;
    equityCents: number;
  }[];
}

export async function runSimulation(opts: SimulationOptions = {}): Promise<SimulationResult> {
  const cycles = opts.cycles ?? 60;
  const seed = opts.seed ?? 20260310;
  const intervalMinutes = opts.intervalMinutes ?? 45;

  const clock = new FixedClock(START);
  const logger = new NullLogger();
  const registry = new SourceRegistry();
  const random = rng(seed);

  const prices = { ...START_PRICES };
  const marketData = new FixtureMarketDataProvider({ clock, prices, forceMarketOpen: true });
  for (const [ticker, price] of Object.entries(prices)) marketData.seedHistory(ticker, 30, price, 0.05);

  const social = new FixtureSocialProvider({ clock, registry, posts: [] });
  const broker = new SimulatedBrokerProvider({
    clock,
    marketData,
    mode: 'PAPER',
    tradableTickers: Object.keys(prices),
    slippageBps: 5,
  });

  const env = { ...loadEnv(), useFixtures: true, databasePath: opts.databasePath ?? ':memory:' };
  const app = new NorthstarApp({
    env,
    clock,
    logger,
    mode: 'PAPER',
    social,
    marketData,
    broker,
    databasePath: opts.databasePath ?? ':memory:',
  });
  app.seed();

  const perCycle: SimulationResult['perCycle'] = [];
  /** Pending price moves: news moves the tape over the following cycles. */
  const pendingDrift = new Map<string, { remainingCycles: number; perCyclePct: number }>();

  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    // Apply any in-flight drift from earlier news.
    for (const [ticker, drift] of [...pendingDrift]) {
      const current = prices[ticker] ?? 0;
      prices[ticker] = current * (1 + drift.perCyclePct / 100);
      marketData.setPrice(ticker, prices[ticker]!);
      drift.remainingCycles -= 1;
      if (drift.remainingCycles <= 0) pendingDrift.delete(ticker);
    }

    // Background market noise on everything else.
    for (const ticker of Object.keys(prices)) {
      if (pendingDrift.has(ticker)) continue;
      const move = (random() - 0.5) * 1.2;
      prices[ticker] = (prices[ticker] ?? 1) * (1 + move / 100);
      marketData.setPrice(ticker, prices[ticker]!);
    }
    // The benchmark drifts mildly upward, as an index tends to.
    prices['SPY'] = (prices['SPY'] ?? 500) * (1 + (random() - 0.42) * 0.6 / 100);
    marketData.setPrice('SPY', prices['SPY']);

    const scenario = scenarioFor(cycle, random);
    social.setPosts(scenario?.posts ?? []);
    if (scenario && Math.abs(scenario.driftPct) > 2) {
      // The news plays out over the next four cycles.
      pendingDrift.set(scenario.ticker, { remainingCycles: 4, perCyclePct: scenario.driftPct / 4 });
    }

    const report = await app.runner.runCycle();

    perCycle.push({
      cycle,
      at: report.finishedAt,
      signals: report.signalsGenerated,
      proposals: report.proposalsCreated,
      riskApproved: report.riskApproved,
      riskRejected: report.riskRejected,
      orders: report.ordersSubmitted,
      exits: report.exitsTriggered.length,
      equityCents: report.equityCents,
    });

    if (opts.verbose) {
      process.stdout.write(
        `cycle ${String(cycle).padStart(3)}  signals ${report.signalsGenerated}  ` +
        `proposals ${report.proposalsCreated}  approved ${report.riskApproved}  ` +
        `rejected ${report.riskRejected}  orders ${report.ordersSubmitted}  ` +
        `exits ${report.exitsTriggered.length}  equity ${formatUsd(report.equityCents)}` +
        `${report.halted ? `  HALTED: ${report.haltReason}` : ''}\n`,
      );
    }

    // Refresh history so forward-return measurement has bars to read.
    for (const ticker of Object.keys(prices)) marketData.seedHistory(ticker, 30, prices[ticker]!, 0.05);
    clock.advanceMinutes(intervalMinutes);
  }

  await app.forwardReturns.measurePending();
  app.survival.persist();

  return { cycles, seed, app, perCycle };
}

/** One-line summary used by the CLI. */
export function summarise(result: SimulationResult): string {
  const { app } = result;
  const ledger = app.ledger.get();
  const survival = app.survival.compute();
  return (
    `${result.cycles} cycles · ${app.store.signals.all().length} signals · ` +
    `${app.store.positions.closed(app.spec.strategyId).length} closed trades · ` +
    `equity ${formatUsd(ledger.equityCents)} (${formatSignedUsd(ledger.equityCents - ledger.startingCapitalCents)}) · ` +
    `status ${survival.status}`
  );
}
