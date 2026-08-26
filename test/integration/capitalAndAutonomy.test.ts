/**
 * $1,000 of strategy capital, and the gate that decides whether the bot may
 * act on its own.
 *
 * Two properties are proved here, and they are the two that make autonomous
 * paper trading safe to switch on:
 *
 *   CAPITAL ISOLATION — the Alpaca account holds ~$100,000. The strategy is
 *   allowed $1,000 and must behave as though the rest does not exist. Buying
 *   power the bot can SEE is not buying power it may USE, and the broker will
 *   happily accept an order far larger than the mandate.
 *
 *   AUTONOMY COHERENCE — an order may only route without a human when the data
 *   behind it and the account in front of it are the same kind of real. Alpaca
 *   PAPER is a real account with a real audit trail; fixture-driven orders
 *   written into it would be a fictional track record that looks exactly like a
 *   genuine one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NorthstarApp } from '../../src/app.js';
import { FixedClock, NullLogger } from '../../src/core/index.js';

import { bullishTier1Post, corroboratingTier2Post, createHarness, testEnv, TEST_NOW, TEST_PRICES } from '../fixtures/harness.js';
import { ACTIVE_EPOCH, EPOCH_PAPER_50, EPOCH_PAPER_1000, maxPositionCentsFor } from '../../src/config/executionEpochs.js';
import { X_SIGNAL_V1, X_SIGNAL_V1_FINGERPRINT, fingerprintVersion } from '../../src/config/strategyRegistry.js';
import { dollarsToCents } from '../../src/core/index.js';
import { SimulatedBrokerProvider } from '../../src/providers/broker/SimulatedBrokerProvider.js';

const CAPITAL = ACTIVE_EPOCH.capitalCents;
const MAX_POSITION = maxPositionCentsFor(CAPITAL, X_SIGNAL_V1.riskLimits.maxPositionPctOfEquity);

/* ============================================================ 1. capital == */

describe('the $1,000 epoch', () => {
  it('deploys $1,000 while the strategy version still declares $50', () => {
    // The version is frozen; capital is an execution setting. Both are true at
    // once, and that is the whole design.
    assert.equal(CAPITAL, dollarsToCents(1000));
    assert.equal(X_SIGNAL_V1.allocatedCapitalCents, dollarsToCents(50));
    assert.equal(X_SIGNAL_V1.riskLimits.startingCapitalCents, dollarsToCents(50));
    assert.equal(fingerprintVersion(X_SIGNAL_V1), X_SIGNAL_V1_FINGERPRINT, 'the fingerprint has not moved');
  });

  it('derives $200 as the maximum position, and preserves every other limit', () => {
    assert.equal(MAX_POSITION, dollarsToCents(200));
    assert.equal(X_SIGNAL_V1.riskLimits.maxPositionPctOfEquity, 20);
    assert.equal(X_SIGNAL_V1.riskLimits.maxConcurrentPositions, 5);
    assert.equal(X_SIGNAL_V1.riskLimits.allowLeverage, false);
    assert.equal(X_SIGNAL_V1.riskLimits.allowMargin, false);
    assert.equal(X_SIGNAL_V1.riskLimits.allowOptions, false);
    assert.equal(X_SIGNAL_V1.riskLimits.allowShorting, false);
    assert.equal(X_SIGNAL_V1.riskLimits.minSignalScore, 35, 'the entry threshold is unchanged');
  });

  it('records the allocation in the epoch, so a run stays reconstructable', () => {
    const h = createHarness();
    const stored = h.app.store.epochs.active(h.app.spec.strategyId);
    assert.ok(stored, 'the active epoch must be persisted');
    assert.equal(stored.capitalCents, CAPITAL);
    assert.equal(stored.strategyFingerprint, X_SIGNAL_V1_FINGERPRINT);
    assert.equal(stored.configSnapshot['maxPositionCents'], MAX_POSITION);
    assert.equal(stored.configSnapshot['maxConcurrentPositions'], 5);
    assert.ok(stored.universeVersion.length > 0, 'the universe in force is recorded too');
    h.close();
  });

  it('leaves the superseded $50 run intact rather than rewriting it', () => {
    const h = createHarness({ epoch: EPOCH_PAPER_50 });
    assert.equal(h.app.ledger.get().startingCapitalCents, dollarsToCents(50));
    assert.equal(h.app.ledger.get().epochId, EPOCH_PAPER_50.epochId);
    h.close();
  });

  it('starts the new epoch clean: full cash, no positions, nothing reserved', () => {
    const h = createHarness();
    const l = h.app.ledger.get();
    assert.equal(l.cashCents, CAPITAL);
    assert.equal(l.equityCents, CAPITAL);
    assert.equal(l.reservedCents, 0);
    assert.equal(l.positionsValueCents, 0);
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 0);
    h.close();
  });
});

/* ================================================== 2. capital isolation == */

describe('capital isolation from the Alpaca account', () => {
  /** A harness whose broker account is far richer than the mandate. */
  function richAccount(prices = TEST_PRICES) {
    const h = createHarness({
      posts: [bullishTier1Post(), corroboratingTier2Post()],
      prices,
    });
    return h;
  }

  it('ignores the account balance entirely when sizing', async () => {
    const h = richAccount();
    const account = await h.app.broker.getAccount();
    assert.ok(account.cash >= 100_000, 'precondition: the account is ~100x the allocation');

    await h.app.runner.runCycle();

    for (const p of h.app.store.positions.open(h.app.spec.strategyId)) {
      assert.ok(
        p.entryCostCents <= MAX_POSITION,
        `${p.ticker} at ${p.entryCostCents}c exceeds the ${MAX_POSITION}c cap`,
      );
    }
    h.close();
  });

  it('binds the $200 cap exactly: permitted at the cap, refused one dollar above', async () => {
    /*
     * Driven through the risk engine directly, because the pipeline's cooldowns
     * mean a passive run never approaches the cap — and a cap that is never
     * approached is a cap that has not been tested.
     *
     * The proposal is retargeted to a ticker with no open position, so the
     * duplicate-order check cannot mask the size check and make this pass for
     * the wrong reason.
     */
    const h = richAccount();
    await h.app.runner.runCycle();
    const strategy = h.app.store.strategies.byId(h.app.spec.strategyId)!;
    const proposal = h.app.store.proposals.recent(1)[0]!;
    const signal = h.app.store.signals.byId(proposal.signalId)!;
    const free = { ...proposal, securityId: 'sec_MSFT', ticker: 'MSFT' };

    const ctx = {
      strategy,
      signal: { ...signal, score: 100, uncertainty: 0 },
      marketStatus: { isOpen: true, asOf: h.clock.nowIso(), nextOpen: null, nextClose: null, reason: 'test' },
      marketDataAgeMinutes: 0,
      marketDataStale: false,
      openPositions: [],
      providersHealthy: true,
      providerHealthDetail: 'healthy',
      brokerReportsMarketOpen: true,
    };

    const atCap = h.app.riskEngine.evaluate({ ...free, proposedCapitalCents: MAX_POSITION }, ctx);
    assert.ok(
      !atCap.failedChecks.includes('MAX_POSITION_SIZE'),
      `exactly $200 must be permitted; failed ${atCap.failedChecks.join(', ')}`,
    );

    const overCap = h.app.riskEngine.evaluate(
      { ...free, proposedCapitalCents: MAX_POSITION + dollarsToCents(1) }, ctx);
    assert.ok(
      overCap.failedChecks.includes('MAX_POSITION_SIZE'),
      'one dollar above the cap must trip the position-size check',
    );
    assert.equal(overCap.approved, false);

    // And the whole allocation in one position is refused for size AND cash.
    const wholeLot = h.app.riskEngine.evaluate({ ...free, proposedCapitalCents: CAPITAL }, ctx);
    assert.ok(wholeLot.failedChecks.includes('MAX_POSITION_SIZE'));
    assert.equal(wholeLot.approved, false);
    h.close();
  });

  it('refuses a sixth position at $1,000 exactly as it did at $50', async () => {
    const h = richAccount();
    await h.app.runner.runCycle();
    const strategy = h.app.store.strategies.byId(h.app.spec.strategyId)!;
    const proposal = h.app.store.proposals.recent(1)[0]!;
    const signal = h.app.store.signals.byId(proposal.signalId)!;

    const five = Array.from({ length: 5 }, (_, i) => ({
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
      openPositions: five,
      providersHealthy: true,
      providerHealthDetail: 'healthy',
      brokerReportsMarketOpen: true,
    });

    assert.equal(decision.approved, false, 'a +100 signal must not open a sixth position');
    assert.ok(decision.failedChecks.includes('MAX_CONCURRENT_POSITIONS'));
    h.close();
  });

  it('refuses to commit capital the allocation does not have, at full exposure', async () => {
    // Five positions at the cap IS the whole allocation. A sixth dollar has to
    // come from somewhere, and the only somewhere is the broker account — which
    // is exactly what must never happen.
    const h = richAccount();
    assert.equal(MAX_POSITION * 5, CAPITAL, 'precondition: 5 x cap is the whole allocation');

    assert.equal(h.app.ledger.reserve(CAPITAL, 'everything'), true);
    assert.equal(h.app.ledger.availableCents(), 0);
    assert.equal(
      h.app.ledger.reserve(1, 'one-cent-of-the-brokers-money'),
      false,
      'the account holds $100,000; the strategy may not touch one cent of it',
    );
    h.close();
  });

  it('takes no short, no option and no margin position', async () => {
    const h = richAccount();
    for (let i = 0; i < 10; i += 1) {
      h.social.setPosts([bullishTier1Post({ postId: `p-${i}` }), corroboratingTier2Post({ postId: `c-${i}` })]);
      await h.app.runner.runCycle();
      h.clock.advanceMinutes(35);
    }

    for (const o of h.app.store.orders.all()) {
      assert.ok(o.quantity >= 0, `order ${o.orderId} has negative quantity — that would be a short`);
    }
    for (const p of h.app.store.positions.open(h.app.spec.strategyId)) {
      assert.equal(p.direction, 'LONG', 'every position must be long');
      assert.ok(p.quantity > 0);
    }
    // Cash never goes below zero, which is what borrowing would look like here.
    assert.ok(h.app.ledger.get().cashCents >= 0, 'negative cash would mean margin');
    h.close();
  });

  it('counts reserved capital against the allocation, not just filled positions', async () => {
    // An order that has been submitted but not filled has committed capital.
    // If reservations did not count, two proposals could each spend the same
    // dollar and the pair would breach the allocation between them.
    const h = createHarness({
      posts: [bullishTier1Post(), corroboratingTier2Post()],
      broker: new SimulatedBrokerProvider({
        clock: createHarness({ seed: false }).clock,
        marketData: createHarness({ seed: false }).marketData,
        mode: 'PAPER',
        fillMode: 'NEVER',
        tradableTickers: Object.keys(TEST_PRICES),
      }),
    });

    const available = h.app.ledger.availableCents();
    assert.ok(h.app.ledger.reserve(available, 'all-of-it'), 'the whole allocation may be reserved');
    assert.equal(h.app.ledger.availableCents(), 0, 'nothing is left to spend');
    assert.equal(h.app.ledger.reserve(1, 'one-cent-more'), false, 'not one cent beyond the allocation');
    h.close();
  });

  it('accounts for a partial fill correctly, releasing what did not fill', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    h.broker.fillMode = 'PARTIAL';

    await h.app.runner.runCycle();
    await h.app.positionManager.reconcile();

    const l = h.app.ledger.get();
    // Whatever happened, the books must still add up and stay inside the
    // allocation: a partial fill must not leave capital committed to shares
    // that were never bought.
    assert.ok(h.app.ledger.verifyIntegrity().ok, h.app.ledger.verifyIntegrity().detail);
    assert.ok(l.cashCents >= 0);
    assert.ok(l.cashCents + l.positionsValueCents + l.reservedCents <= CAPITAL * 1.05);

    for (const o of h.app.store.orders.all()) {
      assert.ok(
        o.filledQuantity <= o.quantity + 1e-6,
        `order ${o.orderId} filled ${o.filledQuantity} of ${o.quantity} — a fill cannot exceed its order`,
      );
    }
    h.close();
  });

  it('keeps the ledger reconcilable after a full trading run', async () => {
    const h = richAccount();
    for (let i = 0; i < 10; i += 1) {
      h.social.setPosts([bullishTier1Post({ postId: `p-${i}` }), corroboratingTier2Post({ postId: `c-${i}` })]);
      await h.app.runner.runCycle();
      await h.app.runner.monitorPositions();
      h.clock.advanceMinutes(35);
    }
    const integrity = h.app.ledger.verifyIntegrity();
    assert.equal(integrity.ok, true, integrity.detail);
    h.close();
  });
});

/* ====================================================== 3. autonomy gate == */

describe('autonomous execution', () => {
  it('routes automatically in SIMULATION, where nothing real is touched', () => {
    const h = createHarness();
    const v = h.app.autonomy.evaluate();
    assert.equal(v.tier, 'SIMULATION');
    assert.equal(v.autonomous, true);
    assert.equal(v.requiresHumanApproval, false);
    h.close();
  });

  it('BLOCKS fixture data from reaching a real Alpaca PAPER account', () => {
    // The bug this gate exists for. Alpaca PAPER is a real account: fixture
    // orders written into it are a fictional track record.
    const h = createHarness();
    const v = h.app.autonomy.tier({
      ...h.app.describeProviders(),
      x: 'FIXTURE',
      marketData: 'FIXTURE',
      broker: 'ALPACA PAPER',
    });
    assert.equal(v, 'INCOHERENT', 'fixture data into a real account is never coherent');
    h.close();
  });

  it('BLOCKS half-real data too: live X but fixture prices', () => {
    const h = createHarness();
    assert.equal(
      h.app.autonomy.tier({
        ...h.app.describeProviders(),
        x: 'LIVE',
        marketData: 'FIXTURE',
        broker: 'ALPACA PAPER',
      }),
      'INCOHERENT',
    );
    h.close();
  });

  it('reaches PAPER only when X, prices and broker are all real', () => {
    const h = createHarness();
    assert.equal(
      h.app.autonomy.tier({
        ...h.app.describeProviders(),
        x: 'LIVE',
        marketData: 'TIINGO',
        broker: 'ALPACA PAPER',
      }),
      'PAPER',
    );
    h.close();
  });

  it('treats LIVE as LIVE even behind a simulated broker', () => {
    // A rehearsal of live trading that auto-submits teaches the system the one
    // reflex it must never learn.
    const h = createHarness({ mode: 'LIVE', liveTradingEnabled: false });
    const v = h.app.autonomy.evaluate();
    assert.equal(v.tier, 'LIVE');
    assert.equal(v.autonomous, false);
    assert.equal(v.requiresHumanApproval, true);
    h.close();
  });

  it('names the reason, not merely that it is blocked', () => {
    const h = createHarness({ mode: 'LIVE', liveTradingEnabled: false });
    const v = h.app.autonomy.evaluate();
    assert.ok(v.blockReason && v.blockReason.length > 0, 'a block must always carry a reason');
    assert.ok(
      v.checks.some((c) => c.id === 'not-live' && !c.passed),
      'the failing gate must be identifiable, not just summarised',
    );
    h.close();
  });

  it('withdraws autonomy the moment the kill switch is engaged', () => {
    const h = createHarness();
    assert.equal(h.app.autonomy.evaluate().autonomous, true);
    h.app.health.kill('operator test');
    const v = h.app.autonomy.evaluate();
    assert.equal(v.autonomous, false);
    assert.ok(v.checks.some((c) => c.id === 'kill-switch' && !c.passed));
    h.close();
  });

  it('withdraws autonomy when an operator pauses new entries', () => {
    const h = createHarness();
    h.app.health.pauseByOperator('closing the front door');
    assert.equal(h.app.autonomy.evaluate().autonomous, false);
    h.close();
  });

  it('evaluates every gate, so an operator sees all the problems at once', () => {
    const h = createHarness({ mode: 'LIVE', liveTradingEnabled: false });
    h.app.health.kill('and this too');
    const v = h.app.autonomy.evaluate();
    const failed = v.checks.filter((c) => !c.passed).map((c) => c.id);
    assert.ok(failed.includes('not-live'));
    assert.ok(failed.includes('kill-switch'));
    h.close();
  });
});

/* ============================================ 4. LIVE cannot be automated == */

describe('LIVE is never autonomous', () => {
  it('holds a qualifying LIVE proposal for a human and submits nothing', async () => {
    const h = createHarness({
      posts: [bullishTier1Post(), corroboratingTier2Post()],
      mode: 'LIVE',
      liveTradingEnabled: true,
    });
    const report = await h.app.runner.runCycle();

    assert.ok(report.proposalsCreated >= 1, 'the pipeline still runs in LIVE');
    assert.equal(report.ordersSubmitted, 0, 'LIVE must never submit on its own');
    assert.equal(report.awaitingApproval, report.proposalsCreated);
    assert.equal(h.app.store.orders.all().length, 0, 'nothing reached the broker');
    h.close();
  });

  it('records WHY the proposal was held, distinguishing LIVE from a blocked gate', async () => {
    const h = createHarness({
      posts: [bullishTier1Post(), corroboratingTier2Post()],
      mode: 'LIVE',
      liveTradingEnabled: true,
    });
    await h.app.runner.runCycle();

    const approvals = h.app.store.log.recent(200).filter((e) => e.stage === 'APPROVAL');
    assert.ok(approvals.length >= 1, 'holding a proposal must be recorded');
    const payload = approvals[0]!.payload as { requiresHumanApproval?: boolean; tier?: string };
    assert.equal(payload.requiresHumanApproval, true);
    assert.equal(payload.tier, 'LIVE');
    h.close();
  });

  it('keeps PAPER credentials from ever satisfying LIVE', () => {
    // Enforced at construction: a LIVE broker cannot be built from PAPER keys,
    // whatever the mode says.
    const h = createHarness({ mode: 'LIVE', liveTradingEnabled: false });
    assert.notEqual(h.app.broker.brokerId, 'alpaca', 'no real broker without its own LIVE credentials');
    h.close();
  });
});

/* ================================================ 5. epochs coexist ======= */

describe('a new epoch never rewrites the one before it', () => {
  it('keeps both ledgers in one database, and closes the superseded epoch', () => {
    /*
     * The $50 run is a record of what actually traded. Starting a larger epoch
     * must not reach back and restate it at the new allocation — that would
     * falsify its return, its drawdown and every trade taken under it.
     */
    const dir = mkdtempSync(join(tmpdir(), 'northstar-epochs-'));
    const databasePath = join(dir, 'db.sqlite');
    const clock = new FixedClock(TEST_NOW);
    const open = (epoch: typeof EPOCH_PAPER_50) =>
      new NorthstarApp({
        env: testEnv({ databasePath }),
        clock,
        logger: new NullLogger(),
        databasePath,
        mode: 'PAPER',
        epoch,
      });

    try {
      // Spend some of the old allocation.
      let app = open(EPOCH_PAPER_50);
      app.seed();
      assert.equal(app.ledger.reserve(dollarsToCents(10), 'legacy-order'), true);
      assert.equal(app.ledger.get().startingCapitalCents, dollarsToCents(50));
      app.close();

      // Start the new epoch against the SAME database.
      app = open(EPOCH_PAPER_1000);
      app.seed();
      assert.equal(app.ledger.get().startingCapitalCents, CAPITAL, 'the new epoch starts at $1,000');
      assert.equal(app.ledger.get().reservedCents, 0, 'and starts clean');

      // The old ledger is exactly as it was left.
      const legacy = app.store.ledger.get(app.spec.strategyId, EPOCH_PAPER_50.epochId);
      assert.ok(legacy, 'the superseded ledger must still exist');
      assert.equal(legacy.startingCapitalCents, dollarsToCents(50));
      assert.equal(legacy.reservedCents, dollarsToCents(10), 'untouched, down to the reservation');

      // Exactly one epoch is active; the other is closed, not deleted.
      const all = app.store.epochs.all(app.spec.strategyId);
      assert.equal(all.length, 2);
      assert.equal(all.filter((e) => e.status === 'ACTIVE').length, 1);
      assert.equal(app.store.epochs.active(app.spec.strategyId)?.epochId, EPOCH_PAPER_1000.epochId);
      assert.equal(all.find((e) => e.epochId === EPOCH_PAPER_50.epochId)?.status, 'CLOSED');
      app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stamps every order, position and ledger entry with its epoch', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();

    const orders = h.app.store.orders.all();
    assert.ok(orders.length >= 1, 'the run must have traded, or this proves nothing');
    for (const o of orders) assert.equal(o.epochId, ACTIVE_EPOCH.epochId);
    for (const p of h.app.store.positions.open(h.app.spec.strategyId)) {
      assert.equal(p.epochId, ACTIVE_EPOCH.epochId);
      assert.equal(p.strategyVersion, X_SIGNAL_V1.version);
    }
    for (const e of h.app.ledger.entries(50)) assert.equal(e.epochId, ACTIVE_EPOCH.epochId);
    h.close();
  });
});
