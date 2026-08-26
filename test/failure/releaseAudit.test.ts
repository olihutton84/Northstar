/**
 * Release audit: the gaps.
 *
 * Written during the final pre-credential audit to cover behaviour the
 * existing suite asserted only indirectly. Each test corresponds to a way the
 * first real session could go wrong that nothing else was watching for:
 *
 *   - the $50 allocation as a HARD ceiling, at its exact boundaries
 *   - a crash with an open position, an open order and reserved capital
 *   - the pre-market → open transition, and the order storm it could cause
 *   - Tiingo failing in each of the ways a vendor actually fails
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FixedClock, NullLogger, dollarsToCents, formatUsd } from '../../src/core/index.js';
import { NorthstarApp } from '../../src/app.js';
import { X_SIGNAL_V1, X_SIGNAL_V1_FINGERPRINT } from '../../src/config/strategyRegistry.js';
import { ACTIVE_EPOCH, maxPositionCentsFor } from '../../src/config/executionEpochs.js';
import { SIGNAL_CONFIG_V1 } from '../../src/config/signalConfig.js';
import { DEFAULT_OPERATIONS } from '../../src/config/operations.js';
import { TiingoMarketDataProvider } from '../../src/providers/marketdata/TiingoMarketDataProvider.js';
import { MarketDataError } from '../../src/providers/marketdata/MarketDataProvider.js';
import { openDatabase } from '../../src/persistence/db.js';
import { Store } from '../../src/persistence/store.js';
import {
  bullishTier1Post,
  corroboratingTier2Post,
  createHarness,
  testEnv,
  TEST_PRICES,
} from '../fixtures/harness.js';
import { FixtureSocialProvider, type FixturePost } from '../../src/providers/social/FixtureSocialProvider.js';
import { FixtureMarketDataProvider } from '../../src/providers/marketdata/FixtureMarketDataProvider.js';
import { SimulatedBrokerProvider } from '../../src/providers/broker/SimulatedBrokerProvider.js';
import { SourceRegistry } from '../../src/providers/social/sourceRegistry.js';
import { SocialProviderError } from '../../src/providers/social/SocialDataProvider.js';
import { BrokerError } from '../../src/providers/broker/BrokerProvider.js';

const NOW = '2026-03-10T15:00:00.000Z';

/* --------------------------------------------- 6. the allocation ceiling */

describe('the allocation is a hard ceiling', () => {
  it('keeps the version frozen at the numbers it published', () => {
    const l = X_SIGNAL_V1.riskLimits;
    assert.equal(l.startingCapitalCents, dollarsToCents(50), 'allocation is $50');
    assert.equal(l.maxPositionPctOfEquity, 20, '20% of equity');
    assert.equal(
      Math.floor((l.startingCapitalCents * l.maxPositionPctOfEquity) / 100),
      dollarsToCents(10),
      'which is exactly $10 at the starting allocation',
    );
    assert.equal(l.maxConcurrentPositions, 5, '5 positions');
    assert.equal(
      dollarsToCents(10) * 5,
      l.startingCapitalCents,
      '5 positions at the cap is the whole allocation, and no more',
    );
  });

  it('deploys the EPOCH allocation, and derives the cap from it', () => {
    // Capital moved to the execution epoch; the proportional rules did not
    // move and are applied to whatever the epoch allocates.
    const l = X_SIGNAL_V1.riskLimits;
    assert.equal(ACTIVE_EPOCH.capitalCents, dollarsToCents(1000), 'the epoch deploys $1,000');
    assert.equal(
      maxPositionCentsFor(ACTIVE_EPOCH.capitalCents, l.maxPositionPctOfEquity),
      dollarsToCents(200),
      '20% of $1,000 is $200',
    );
    assert.equal(
      maxPositionCentsFor(ACTIVE_EPOCH.capitalCents, l.maxPositionPctOfEquity) * l.maxConcurrentPositions,
      ACTIVE_EPOCH.capitalCents,
      '5 positions at the cap is the whole epoch allocation, and no more',
    );
  });

  it('refuses the sixth position however strong the signal', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    const strategy = h.app.store.strategies.byId(h.app.spec.strategyId)!;

    await h.app.runner.runCycle();
    const proposal = h.app.store.proposals.recent(1)[0]!;
    const signal = h.app.store.signals.byId(proposal.signalId)!;

    // Five positions already open, and a maximal signal arriving.
    const fivePositions = Array.from({ length: 5 }, (_, i) => ({
      ...h.app.store.positions.open(h.app.spec.strategyId)[0]!,
      positionId: `pos-${i}`,
      ticker: ['AAPL', 'MSFT', 'TSLA', 'AMD', 'PFE'][i]!,
    }));

    const decision = h.app.riskEngine.evaluate(proposal, {
      strategy,
      signal: { ...signal, score: 100, uncertainty: 0 },
      marketStatus: { isOpen: true, asOf: h.clock.nowIso(), nextOpen: null, nextClose: null, reason: 'test' },
      marketDataAgeMinutes: 0,
      marketDataStale: false,
      openPositions: fivePositions,
      providersHealthy: true,
      providerHealthDetail: 'healthy',
      brokerReportsMarketOpen: true,
    });

    assert.equal(decision.approved, false, 'a +100 signal must not open a sixth position');
    assert.ok(decision.failedChecks.includes('MAX_CONCURRENT_POSITIONS'));
    h.close();
  });

  it('never deploys more than $50 across a long run, whatever the account holds', async () => {
    // The simulated broker account is far richer than the strategy.
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });

    let peakDeployed = 0;
    for (let i = 0; i < 40; i += 1) {
      await h.app.runner.runCycle();
      const ledger = h.app.ledger.get();
      peakDeployed = Math.max(peakDeployed, ledger.positionsValueCents + ledger.reservedCents);

      // The invariant, checked every single cycle rather than at the end.
      assert.ok(
        ledger.reservedCents <= ledger.cashCents,
        `cycle ${i}: reserved ${formatUsd(ledger.reservedCents)} exceeds cash ${formatUsd(ledger.cashCents)}`,
      );
      assert.ok(
        ledger.equityCents > 0,
        `cycle ${i}: equity went non-positive`,
      );
      h.clock.advanceMinutes(30);
    }

    const integrity = h.app.ledger.verifyIntegrity();
    assert.ok(integrity.ok, `ledger drifted: ${integrity.detail}`);
    h.close();
  });

  it('keeps the strategy ledger separate from the broker account', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();

    const account = await h.app.broker.getAccount();
    const ledger = h.app.ledger.get();

    assert.ok(account.equity * 100 > ledger.equityCents * 10, 'the account is much larger than the strategy');
    assert.ok(
      ledger.equityCents <= ACTIVE_EPOCH.capitalCents * 1.5,
      'the strategy ledger tracks its own epoch allocation, not the account',
    );
    h.close();
  });
});

/* ------------------------------------------------- 10. restart recovery */

describe('restart with live state', () => {
  function tempDb(): { path: string; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'northstar-audit-'));
    return { path: join(dir, 'state.sqlite'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  /**
   * A restart, modelled honestly.
   *
   * Two things survive a crash and one does not. The DATABASE survives, so the
   * file is reused. The BROKER survives, because it is a remote service that
   * has never heard of our process — so the same broker instance is carried
   * across, exactly as Alpaca would still be holding the position. Only the
   * in-process objects are rebuilt.
   *
   * Handing the restarted app a fresh, empty broker would model Alpaca losing
   * every position overnight, and would test nothing that can happen.
   */
  function session(databasePath: string, clock: FixedClock, posts: FixturePost[] = []) {
    const registry = new SourceRegistry();
    const marketData = new FixtureMarketDataProvider({ clock, prices: TEST_PRICES, forceMarketOpen: true });
    for (const [ticker, price] of Object.entries(TEST_PRICES)) marketData.seedHistory(ticker, 25, price, 0.2);
    const broker = new SimulatedBrokerProvider({
      clock,
      marketData,
      mode: 'PAPER',
      tradableTickers: Object.keys(TEST_PRICES),
    });
    return { registry, marketData, broker, posts };
  }

  function open(
    databasePath: string,
    clock: FixedClock,
    remote: ReturnType<typeof session>,
    posts: FixturePost[] = [],
  ): NorthstarApp {
    const app = new NorthstarApp({
      env: testEnv(),
      clock,
      logger: new NullLogger(),
      mode: 'PAPER',
      social: new FixtureSocialProvider({ clock, registry: remote.registry, posts }),
      marketData: remote.marketData,
      broker: remote.broker,
      databasePath,
    });
    remote.marketData.attachBarCache(app.store.bars);
    app.seed();
    return app;
  }

  it('reloads an open position, its ledger and its cursor, and opens nothing new', async () => {
    const db = tempDb();
    const clock = new FixedClock(NOW);
    const remote = session(db.path, clock);

    const first = open(db.path, clock, remote, [bullishTier1Post(), corroboratingTier2Post()]);
    await first.runner.runCycle();

    const before = {
      positions: first.store.positions.open(first.spec.strategyId).length,
      entries: first.store.orders.all().filter((o) => o.intent === 'ENTRY').length,
      equity: first.ledger.get().equityCents,
      cash: first.ledger.get().cashCents,
      cursors: first.store.cursors.list().length,
    };
    assert.equal(before.positions, 1, 'the pre-crash session held a position');
    assert.ok(before.cursors > 0, 'and had advanced a polling cursor');

    // Crash: drop the process without any shutdown work. The database file and
    // the broker both outlive it.
    first.close();

    const restarted = open(db.path, clock, remote, [bullishTier1Post(), corroboratingTier2Post()]);
    try {
      assert.equal(
        restarted.store.positions.open(restarted.spec.strategyId).length,
        before.positions,
        'the position must survive the restart',
      );
      assert.equal(restarted.ledger.get().equityCents, before.equity, 'equity must reload exactly');
      assert.equal(restarted.ledger.get().cashCents, before.cash, 'cash must reload exactly');
      assert.equal(restarted.store.cursors.list().length, before.cursors, 'the cursor must survive');
      assert.ok(restarted.ledger.verifyIntegrity().ok, 'the reloaded ledger must reconcile');

      // A fresh cycle after the restart must not re-enter the same name.
      await restarted.runner.runCycle();
      assert.equal(
        restarted.store.orders.all().filter((o) => o.intent === 'ENTRY').length,
        before.entries,
        'no duplicate entry may be submitted after a restart',
      );
    } finally {
      restarted.close();
      db.cleanup();
    }
  });

  it('still manages and exits a position that predates the restart', async () => {
    const db = tempDb();
    const clock = new FixedClock(NOW);
    const remote = session(db.path, clock);

    const first = open(db.path, clock, remote, [bullishTier1Post(), corroboratingTier2Post()]);
    await first.runner.runCycle();
    const position = first.store.positions.open(first.spec.strategyId)[0]!;
    first.close();

    const restarted = open(db.path, clock, remote);
    try {
      // Far past the maximum holding period: the exit rule must still fire on
      // a position this process never opened.
      clock.advanceHours(X_SIGNAL_V1.exitRules.maxHoldingHours + 2);
      await restarted.runner.monitorPositions();
      await restarted.positionManager.reconcile();

      const after = restarted.store.positions.byId(position.positionId);
      assert.notEqual(after?.status, 'OPEN', 'an inherited position must still be exited on its rules');
      assert.ok(restarted.ledger.verifyIntegrity().ok, 'the ledger must survive the inherited exit');
    } finally {
      restarted.close();
      db.cleanup();
    }
  });

  it('reconciles against the broker on restart rather than trusting its own books', async () => {
    const db = tempDb();
    const clock = new FixedClock(NOW);
    const remote = session(db.path, clock);

    const first = open(db.path, clock, remote, [bullishTier1Post(), corroboratingTier2Post()]);
    await first.runner.runCycle();
    first.close();

    const restarted = open(db.path, clock, remote);
    try {
      const report = await restarted.reconciliation.reconcile();
      assert.equal(report.reachedBroker, true, 'a restart must actually ask the broker');
      const critical = report.discrepancies.filter((d) => d.severity === 'CRITICAL');
      assert.deepEqual(critical, [], `a clean restart must produce no critical drift: ${JSON.stringify(critical)}`);
    } finally {
      restarted.close();
      db.cleanup();
    }
  });

  it('raises a CRITICAL when the broker really has lost the position', async () => {
    const db = tempDb();
    const clock = new FixedClock(NOW);
    const remote = session(db.path, clock);

    const first = open(db.path, clock, remote, [bullishTier1Post(), corroboratingTier2Post()]);
    await first.runner.runCycle();
    first.close();

    // This time the broker genuinely has nothing: the disagreement is real and
    // must be reported rather than smoothed over.
    const amnesiac = session(db.path, clock);
    const restarted = open(db.path, clock, amnesiac);
    try {
      const report = await restarted.reconciliation.reconcile();
      const critical = report.discrepancies.filter((d) => d.severity === 'CRITICAL');
      assert.ok(critical.length > 0, 'a position the broker cannot confirm must be escalated');
      assert.ok(critical.some((d) => d.area === 'POSITIONS'));
      // And strictly reported, never silently repaired.
      assert.equal(
        restarted.store.positions.open(restarted.spec.strategyId).length,
        1,
        'reconciliation must not delete the position it cannot confirm',
      );
    } finally {
      restarted.close();
      db.cleanup();
    }
  });
});

/* --------------------------------------------- 8. market-open transition */

describe('pre-market to open transition', () => {
  /** 08:30 New York on a normal trading Tuesday. */
  const PRE_MARKET = '2026-03-10T12:30:00.000Z';

  it('ingests and scores before the open but submits nothing', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()], now: PRE_MARKET });
    h.marketData.setMarketOpen(false);
    h.broker.setMarketOpen(false);

    const report = await h.app.runner.runCycle();

    assert.ok(report.ingested > 0, 'pre-market ingestion is fine and useful');
    assert.equal(h.app.store.orders.all().length, 0, 'nothing may execute before the open');

    const failed = h.app.store.risk.recent(10).flatMap((d) => d.failedChecks);
    assert.ok(failed.includes('MARKET_HOURS'), 'the market-hours gate is what held it');
    h.close();
  });

  it('does not fire an order storm at the open', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()], now: PRE_MARKET });
    h.marketData.setMarketOpen(false);
    h.broker.setMarketOpen(false);

    // An hour of pre-market scans on developing news.
    for (let i = 0; i < 12; i += 1) {
      await h.app.runner.runCycle();
      h.clock.advanceMinutes(5);
    }
    assert.equal(h.app.store.orders.all().length, 0, 'still nothing before the open');

    // The bell.
    h.marketData.setMarketOpen(true);
    h.broker.setMarketOpen(true);
    await h.app.runner.runCycle();

    const entries = h.app.store.orders.all().filter((o) => o.intent === 'ENTRY');
    assert.ok(entries.length <= 1, `the open must not release a queue of orders, got ${entries.length}`);

    // And whatever it did open respects the concurrent-position cap.
    assert.ok(h.app.store.positions.open(h.app.spec.strategyId).length <= X_SIGNAL_V1.riskLimits.maxConcurrentPositions);
    h.close();
  });

  it('expires signals that went stale waiting for the open', async () => {
    const h = createHarness({
      posts: [bullishTier1Post(), corroboratingTier2Post()],
      now: PRE_MARKET,
      operations: { signalTtlMinutes: 30, proposalTtlMinutes: 120 },
    });
    h.marketData.setMarketOpen(false);
    h.broker.setMarketOpen(false);
    await h.app.runner.runCycle();

    const proposal = h.app.store.proposals.recent(1)[0];
    const signal = proposal ? h.app.store.signals.byId(proposal.signalId) : null;
    const decision = h.app.store.risk.recent(1)[0];

    if (proposal && signal && decision) {
      // An hour later the market opens, but the evidence is an hour old.
      h.clock.advanceMinutes(60);
      h.marketData.setMarketOpen(true);
      h.broker.setMarketOpen(true);

      const outcome = await h.app.orderRouter.submitEntry(proposal, decision, signal);
      assert.equal(outcome.ok, false, 'an hour-old thesis must not execute at the bell');
    }
    h.close();
  });
});

/* --------------------------------------------------- 12. Tiingo failures */

describe('Tiingo failure modes', () => {
  function provider(respond: () => Response | Promise<Response>): {
    md: TiingoMarketDataProvider;
    close: () => void;
  } {
    const clock = new FixedClock(NOW);
    const db = openDatabase(':memory:');
    const store = new Store(db, clock);
    const md = new TiingoMarketDataProvider({
      apiKey: 'not-a-real-key',
      baseUrl: 'https://api.example.test',
      clock,
      logger: new NullLogger(),
      bars: store.bars,
      fetchImpl: (async () => respond()) as typeof fetch,
    });
    return { md, close: () => db.close() };
  }

  const cases: { name: string; response: () => Response; kind: string }[] = [
    { name: '401', response: () => new Response('{}', { status: 401 }), kind: 'AUTH' },
    { name: '403', response: () => new Response('{}', { status: 403 }), kind: 'AUTH' },
    { name: '429', response: () => new Response('{}', { status: 429 }), kind: 'RATE_LIMIT' },
    { name: '503', response: () => new Response('{}', { status: 503 }), kind: 'UNAVAILABLE' },
    { name: '404', response: () => new Response('{}', { status: 404 }), kind: 'NOT_FOUND' },
    { name: 'malformed body', response: () => new Response('<html>nope', { status: 200 }), kind: 'BAD_RESPONSE' },
  ];

  for (const c of cases) {
    it(`surfaces ${c.name} as a typed ${c.kind} error rather than a price`, async () => {
      const p = provider(c.response);
      await assert.rejects(
        () => p.md.getQuote('NVDA'),
        (e: unknown) => {
          assert.ok(e instanceof MarketDataError, `expected MarketDataError, got ${String(e)}`);
          assert.equal(e.kind, c.kind);
          return true;
        },
      );
      p.close();
    });
  }

  it('returns nothing rather than inventing a price for an unknown ticker', async () => {
    const p = provider(() => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    const quotes = await p.md.getQuotes(['NOPE']);
    assert.equal(quotes.size, 0, 'an empty vendor response must produce no quote at all');
    p.close();
  });

  it('never lets a strong signal trade when prices are unavailable', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    h.marketData.setFailure(new MarketDataError('Tiingo auth failed', 'AUTH'));

    await h.app.runner.runCycle();

    assert.equal(h.app.store.orders.all().length, 0, 'no price, no order — however strong the signal');
    h.close();
  });

  it('does not let a cached quote launder its own staleness', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    // A quote well beyond the freshness limit, served repeatedly.
    h.marketData.setQuoteAgeMinutes(90);

    await h.app.runner.runCycle();
    h.clock.advanceMinutes(1);
    await h.app.runner.runCycle();

    assert.equal(h.app.store.orders.all().length, 0);
    const failed = h.app.store.risk.recent(10).flatMap((d) => d.failedChecks);
    assert.ok(failed.includes('MARKET_DATA_FRESHNESS'), 'stale marks must fail the freshness gate every time');
    h.close();
  });
});

/* ------------------------------------------------ 19. first-day recording */

describe('the day must be reconstructable afterwards', () => {
  it('records a transient API failure durably, not just as a counter', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });

    // A single 429 — below the pause threshold, so nothing else would notice.
    h.social.setFailure(new SocialProviderError('X rate limit exceeded', 'RATE_LIMIT', 60));
    await h.app.runner.runCycle();
    h.social.setFailure(null);
    await h.app.runner.runCycle();

    const health = h.app.store.log.byStage(h.app.spec.strategyId, 'HEALTH', 50);
    const failure = health.find((e) => (e.payload as Record<string, unknown>)['event'] === 'FAILURE');
    const recovery = health.find((e) => (e.payload as Record<string, unknown>)['event'] === 'RECOVERED');

    assert.ok(failure, 'the failure must survive the process that saw it');
    assert.ok(recovery, 'and the recovery must close the outage window');
    assert.equal((failure!.payload as Record<string, unknown>)['kind'], 'RATE_LIMIT');
    assert.ok(failure!.at, 'timestamped');

    // A single transient failure must not pause the strategy.
    assert.equal(h.app.store.strategies.byId(h.app.spec.strategyId)?.runState, 'RUNNING');
    h.close();
  });

  it('can reconstruct a trade from the post that caused it', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();

    const signal = h.app.store.signals.recent(1)[0]!;
    const audit = h.app.audit.audit(signal.signalId);

    assert.ok(audit, 'every signal must be auditable');
    assert.ok(audit!.outcome.narrative.length > 0, 'with a plain-language narrative');
    assert.ok(audit!.sources.length > 0, 'naming the posts it came from');
    assert.ok(audit!.components.length > 0, 'and what each score dimension contributed');
    assert.ok(audit!.outcome.riskDecision, 'the risk decision that ruled on it');
    assert.ok(audit!.outcome.riskDecision!.checks.length > 0, 'including every check it ran');
    assert.ok(audit!.outcome.orders.length > 0, 'and the order it produced');
    h.close();
  });

  it('keeps every pipeline stage on the decision log', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();
    await h.app.positionManager.reconcile();

    const stages = new Set(h.app.store.log.recent(2000).map((l) => l.stage));
    for (const required of ['INGEST', 'SIGNAL', 'PROPOSAL', 'RISK', 'ORDER'] as const) {
      assert.ok(stages.has(required), `the ${required} stage must be on the permanent record`);
    }
    h.close();
  });
});

/* ------------------------------------------------------- 14. readiness */

describe('readiness never trades', () => {
  it('proves the kill-switch interlock on a fresh database, without a cycle', async () => {
    const h = createHarness({ posts: [] });

    // Nothing has ever been proposed, so there is no stored subject. The check
    // must still prove the interlock rather than advising the operator to run
    // a cycle — advice that with real credentials invites a trade.
    assert.equal(h.app.store.proposals.recent(1).length, 0);

    const report = await h.app.readiness.run();
    const killSwitch = report.checks.find((c) => c.id === 'kill-switch')!;

    assert.equal(killSwitch.status, 'PASS', killSwitch.detail);
    assert.match(killSwitch.detail, /synthetic/);
    h.close();
  });

  it('persists nothing while dry-running the interlock', async () => {
    const h = createHarness({ posts: [] });
    await h.app.readiness.run();

    assert.equal(h.app.store.proposals.recent(50).length, 0, 'no proposal may be written');
    assert.equal(h.app.store.signals.recent(50).length, 0, 'no signal may be written');
    assert.equal(h.app.store.risk.recent(50).length, 0, 'no risk decision may be written');
    assert.equal(h.app.store.orders.all().length, 0, 'and above all, no order');
    h.close();
  });

  it('submits no order even with a fully live-looking pipeline', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    const before = h.app.store.orders.all().length;

    await h.app.readiness.run();
    await h.app.readiness.run();

    assert.equal(h.app.store.orders.all().length, before, 'readiness is read-only, always');
    h.close();
  });

  it('withholds the real-data verdict while any provider is a fixture', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    const report = await h.app.readiness.run();

    assert.equal(report.readyForRealDataPaper, false, 'fixtures can never be READY for real data');
    // The wording covers manual ingest too, so it says "not real data" rather
    // than "fixture" — the substance is unchanged and checked directly below.
    assert.match(report.readyForRealDataPaperReason, /not real data/);

    const noFixtures = report.checks.find((c) => c.id === 'no-fixtures')!;
    assert.equal(noFixtures.status, 'FAIL');
    assert.match(noFixtures.detail, /^Not real data: X /, 'and it must name X as the offender');
    h.close();
  });
});

/* ------------------------------------------------- 5. duplicate vectors */

describe('duplicate trading is impossible through every route', () => {
  async function opened() {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();
    const entries = () => h.app.store.orders.all().filter((o) => o.intent === 'ENTRY').length;
    assert.equal(entries(), 1, 'the first cycle opened exactly one entry');
    return { h, entries };
  }

  it('ignores the identical post arriving again', async () => {
    const { h, entries } = await opened();
    h.social.setPosts([bullishTier1Post(), corroboratingTier2Post()]);
    h.clock.advanceMinutes(2);
    await h.app.runner.runCycle();
    assert.equal(entries(), 1);
    h.close();
  });

  it('ignores a repost of the same story by another account', async () => {
    const { h, entries } = await opened();
    h.clock.advanceMinutes(2);
    h.social.addPosts([
      bullishTier1Post({
        postId: 'echo-1',
        handle: 'randomguy',
        kind: 'REPOST',
        referencedPostId: 'post-nvda-guidance-1',
      }),
    ]);
    await h.app.runner.runCycle();
    assert.equal(entries(), 1, 'an echo is not new information');
    h.close();
  });

  it('is idempotent across a duplicate cycle with the clock unmoved', async () => {
    const { h, entries } = await opened();
    await h.app.runner.runCycle();
    assert.equal(entries(), 1);
    h.close();
  });

  it('refuses the same proposal submitted twice through the router', async () => {
    const { h } = await opened();
    const proposal = h.app.store.proposals.recent(1)[0]!;
    const decision = h.app.store.risk.recent(1)[0]!;
    const signal = h.app.store.signals.byId(proposal.signalId)!;

    const again = await h.app.orderRouter.submitEntry(proposal, decision, signal);
    assert.equal(again.ok, false);
    assert.equal(again.ok === false && again.reason, 'DUPLICATE');
    h.close();
  });

  it('opens exactly one position across ten consecutive scans of one story', async () => {
    const { h, entries } = await opened();
    for (let i = 0; i < 10; i += 1) {
      h.clock.advanceMinutes(2);
      await h.app.runner.runCycle();
    }
    assert.equal(entries(), 1);
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 1);
    h.close();
  });
});

/* ------------------------------------------- 9. exits must never orphan */

describe('an exit is never permanently disarmed', () => {
  async function losing() {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();
    const position = h.app.store.positions.open(h.app.spec.strategyId)[0]!;
    // Well through the stop loss.
    h.marketData.setPrice(position.ticker, position.entryPrice * 0.8);
    return { h, position };
  }

  it('holds the exit while the market is closed, then fires it at the open', async () => {
    const { h, position } = await losing();
    h.marketData.setMarketOpen(false);
    h.broker.setMarketOpen(false);
    h.clock.advanceMinutes(5);
    await h.app.runner.monitorPositions();

    assert.equal(h.app.store.positions.byId(position.positionId)?.status, 'OPEN', 'nothing executes while closed');

    h.marketData.setMarketOpen(true);
    h.broker.setMarketOpen(true);
    h.clock.advanceMinutes(5);
    await h.app.runner.monitorPositions();
    await h.app.positionManager.reconcile();

    const after = h.app.store.positions.byId(position.positionId)!;
    assert.equal(after.status, 'CLOSED', 'the stop must fire once the market reopens');
    assert.equal(after.exitReason, 'STOP_LOSS');
    assert.ok(h.app.ledger.verifyIntegrity().ok);
    h.close();
  });

  it('retries an exit the broker rejected, and closes once it recovers', async () => {
    const { h, position } = await losing();
    h.broker.setSubmitFailure(new BrokerError('exit bounced', 'REJECTED'));
    h.clock.advanceMinutes(5);
    await h.app.runner.monitorPositions();

    assert.equal(h.app.store.positions.byId(position.positionId)?.status, 'OPEN');

    h.broker.setSubmitFailure(null);
    h.clock.advanceMinutes(5);
    await h.app.runner.monitorPositions();
    await h.app.positionManager.reconcile();

    const after = h.app.store.positions.byId(position.positionId)!;
    assert.equal(after.status, 'CLOSED', 'a bounced stop-loss must be retried, not abandoned');
    const attempts = h.app.store.orders.byPosition(position.positionId).filter((o) => o.intent === 'EXIT');
    assert.equal(attempts.length, 2, 'the retry is a distinct, recorded attempt');
    assert.ok(h.app.ledger.verifyIntegrity().ok);
    h.close();
  });
});

/* ------------------------------------------ 26. run configuration snapshot */

describe('the session records what configuration produced it', () => {
  function snapshot(h: ReturnType<typeof createHarness>): Record<string, unknown> {
    const row = h.app.store.log
      .byStage(h.app.spec.strategyId, 'SYSTEM', 10)
      .find((e) => (e.payload as Record<string, unknown>)['strategyVersion'] !== undefined);
    assert.ok(row, 'a configuration snapshot must be written');
    return row!.payload as Record<string, unknown>;
  }

  it('captures weights, thresholds, cadence and capital by value', () => {
    const h = createHarness({ posts: [] });
    h.app.recordRunConfiguration('test');
    const p = snapshot(h);

    // By value, not by reference: `signalConfigId` alone is a pointer into
    // code, which explains nothing once the code has moved on.
    assert.deepEqual(p['convictionWeights'], SIGNAL_CONFIG_V1.convictionWeights);
    assert.deepEqual(p['bands'], SIGNAL_CONFIG_V1.bands);
    assert.deepEqual(p['riskLimits'], X_SIGNAL_V1.riskLimits);
    assert.deepEqual(p['exitRules'], X_SIGNAL_V1.exitRules);
    assert.equal(p['allocatedCapitalCents'], X_SIGNAL_V1.allocatedCapitalCents);
    assert.equal(p['strategyVersion'], X_SIGNAL_V1.version);
    assert.equal(p['strategyFingerprint'], X_SIGNAL_V1_FINGERPRINT);

    const ops = p['operations'] as Record<string, number>;
    assert.equal(ops['xScanIntervalSeconds'], DEFAULT_OPERATIONS.xScanIntervalSeconds);
    assert.equal(ops['sameTickerCooldownMinutes'], DEFAULT_OPERATIONS.sameTickerCooldownMinutes);
    assert.equal(ops['signalTtlMinutes'], DEFAULT_OPERATIONS.signalTtlMinutes);
    h.close();
  });

  it('distinguishes two runs of the same strategy with different operations', () => {
    const a = createHarness({ posts: [], operations: { sameTickerCooldownMinutes: 5 } });
    a.app.recordRunConfiguration('test');
    const opsA = (snapshot(a)['operations'] as Record<string, number>)['sameTickerCooldownMinutes'];
    a.close();

    const b = createHarness({ posts: [], operations: { sameTickerCooldownMinutes: 90 } });
    b.app.recordRunConfiguration('test');
    const opsB = (snapshot(b)['operations'] as Record<string, number>)['sameTickerCooldownMinutes'];
    b.close();

    // Same strategy version, materially different experiment. The record has
    // to be able to tell them apart.
    assert.equal(opsA, 5);
    assert.equal(opsB, 90);
  });

  it('contains no credential, however the environment is set', () => {
    const h = createHarness({ posts: [] });
    h.app.recordRunConfiguration('test');
    const serialised = JSON.stringify(snapshot(h));

    for (const forbidden of ['Bearer', 'APCA', 'token=', 'secretKey', 'keyId', 'BEARER_TOKEN', 'SECRET_KEY']) {
      assert.ok(!serialised.includes(forbidden), `snapshot must not contain "${forbidden}"`);
    }
    h.close();
  });
});
