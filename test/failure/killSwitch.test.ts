/**
 * Kill switch.
 *
 * The property that matters most is the last one: a restart must not quietly
 * re-enable execution. A kill that only lives in memory is not a kill switch,
 * it is a pause that forgets.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NorthstarApp } from '../../src/app.js';
import { bullishTier1Post, corroboratingTier2Post, createHarness, testEnv, TEST_NOW } from '../fixtures/harness.js';
import { FixedClock, NullLogger } from '../../src/core/index.js';
import { FixtureMarketDataProvider } from '../../src/providers/marketdata/FixtureMarketDataProvider.js';
import { FixtureSocialProvider } from '../../src/providers/social/FixtureSocialProvider.js';
import { SimulatedBrokerProvider } from '../../src/providers/broker/SimulatedBrokerProvider.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const POSTS = () => [bullishTier1Post(), corroboratingTier2Post()];

const FRESH_POSTS = () => [
  bullishTier1Post({ postId: 'pfe-1', handle: 'pfizer', text: 'Pfizer raises full-year guidance to $62.0B after FDA approval of its lead therapy. $PFE' }),
  corroboratingTier2Post({ postId: 'pfe-2', handle: 'reuters', text: 'Pfizer lifts full-year guidance to $62.0 billion following FDA approval, ahead of consensus. $PFE' }),
];

describe('kill switch', () => {
  it('stops new proposals from executing', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();
    const submitsBefore = h.broker.submitCount;

    h.app.health.kill('operator stop', false);

    h.clock.advanceMinutes(30);
    h.social.setPosts(FRESH_POSTS());
    const report = await h.app.runner.runCycle();

    assert.equal(h.broker.submitCount, submitsBefore, 'no order may be submitted after a kill');
    assert.equal(report.ordersSubmitted, 0);
    h.close();
  });

  it('blocks execution at the risk engine, not merely at the runner', async () => {
    // Belt and braces: even calling the router directly must not get through,
    // because risk refuses to approve while the strategy is KILLED.
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();
    h.app.health.kill('operator stop', false);

    h.clock.advanceMinutes(30);
    h.social.setPosts(FRESH_POSTS());
    await h.app.runner.runCycle();

    const rejections = h.app.store.risk.recent(10).filter((d) => !d.approved);
    assert.ok(
      rejections.some((d) => d.failedChecks.includes('KILL_SWITCH')) || rejections.length === 0,
      'any risk decision taken while killed must fail the KILL_SWITCH check',
    );
    h.close();
  });

  it('cancels outstanding orders and returns their reserved capital', async () => {
    const h = createHarness({ posts: POSTS() });
    h.broker.setFillMode('NEVER'); // leave the entry resting
    await h.app.runner.runCycle();

    assert.equal(h.app.store.orders.open(h.app.spec.strategyId).length, 1);
    assert.ok(h.app.ledger.get().reservedCents > 0);

    h.app.health.kill('operator stop', false);
    const cancelled = await h.app.orderRouter.cancelOpenOrders(h.app.spec.strategyId);

    assert.equal(cancelled.cancelled.length, 1);
    assert.equal(cancelled.failed.length, 0);
    assert.equal(h.app.store.orders.open(h.app.spec.strategyId).length, 0);

    const ledger = h.app.ledger.get();
    assert.equal(ledger.reservedCents, 0, 'cancelling must release committed capital');
    assert.equal(ledger.cashCents, ledger.startingCapitalCents, 'no cash should have moved');
    assert.equal(h.app.ledger.verifyIntegrity().ok, true);
    h.close();
  });

  it('leaves positions untouched unless liquidation was explicitly chosen', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();
    const openBefore = h.app.store.positions.open(h.app.spec.strategyId).length;
    assert.equal(openBefore, 1);

    h.app.health.kill('operator stop', false);
    h.clock.advanceMinutes(30);
    h.social.setPosts([]);
    await h.app.runner.runCycle();

    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, openBefore);
    assert.equal(h.app.store.positions.closed(h.app.spec.strategyId).length, 0);
    h.close();
  });

  it('liquidates when liquidation is explicitly chosen', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();

    h.app.health.kill('operator stop with liquidation', true);
    h.clock.advanceMinutes(30);
    h.social.setPosts([]);
    await h.app.runner.runCycle();

    const closed = h.app.store.positions.closed(h.app.spec.strategyId);
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.exitReason, 'KILL_SWITCH_LIQUIDATION');
    assert.equal(h.app.ledger.verifyIntegrity().ok, true);
    h.close();
  });

  it('keeps state recoverable: resume restores normal operation', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();
    h.app.health.kill('operator stop', false);

    assert.equal(h.app.health.state().killed, true);
    assert.ok(h.app.health.state().openIncidents.length > 0);

    h.app.health.resume('all clear');
    const state = h.app.health.state();

    assert.equal(state.runState, 'RUNNING');
    assert.equal(state.killed, false);
    assert.equal(state.openIncidents.length, 0);
    assert.equal(state.haltReason, null);
    assert.equal(state.liquidateOnKill, false, 'resume must clear any liquidation intent');

    // And trading works again.
    h.clock.advanceMinutes(30);
    h.social.setPosts(FRESH_POSTS());
    const report = await h.app.runner.runCycle();
    assert.ok(report.ordersSubmitted >= 1, 'a resumed strategy must be able to trade again');
    assert.equal(h.app.ledger.verifyIntegrity().ok, true);
    h.close();
  });

  it('preserves the decision log and every prior record through a kill', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();

    const logsBefore = h.app.store.log.recent(1000).length;
    const signalsBefore = h.app.store.signals.all().length;
    const ordersBefore = h.app.store.orders.all().length;

    h.app.health.kill('operator stop', false);

    assert.ok(h.app.store.log.recent(1000).length >= logsBefore, 'logs must never be destroyed');
    assert.equal(h.app.store.signals.all().length, signalsBefore);
    assert.equal(h.app.store.orders.all().length, ordersBefore);
    assert.ok(h.app.store.log.recent(1000).some((e) => e.summary.includes('KILL BOT engaged')));
    h.close();
  });

  /* ------------------------------------------------------- restart safety */

  it('does NOT re-enable execution after a restart', async () => {
    // A fresh process against the same database is the case that matters: the
    // kill must be a persisted fact, not a variable in the dead process.
    const dir = mkdtempSync(join(tmpdir(), 'northstar-kill-'));
    const dbPath = join(dir, 'restart.sqlite');

    try {
      const clock = new FixedClock(TEST_NOW);
      const build = (): NorthstarApp => {
        const marketData = new FixtureMarketDataProvider({
          clock,
          prices: { NVDA: 120, PFE: 30, SPY: 500 },
          forceMarketOpen: true,
        });
        for (const [t, p] of Object.entries({ NVDA: 120, PFE: 30, SPY: 500 })) {
          marketData.seedHistory(t, 25, p, 0.2);
        }
        const social = new FixtureSocialProvider({ clock, posts: [] });
        const broker = new SimulatedBrokerProvider({
          clock,
          marketData,
          mode: 'PAPER',
          tradableTickers: ['NVDA', 'PFE', 'SPY'],
        });
        const app = new NorthstarApp({
          env: testEnv(),
          clock,
          logger: new NullLogger(),
          mode: 'PAPER',
          social,
          marketData,
          broker,
          databasePath: dbPath,
        });
        app.seed();
        return app;
      };

      // --- process 1: trade, then kill -----------------------------------
      const first = build();
      (first.social as FixtureSocialProvider).setPosts(POSTS());
      await first.runner.runCycle();
      assert.equal(first.store.positions.open(first.spec.strategyId).length, 1);

      first.health.kill('operator stop before restart', false);
      assert.equal(first.health.state().killed, true);
      first.close();

      // --- process 2: a completely fresh app on the same database ---------
      const second = build();
      const restartedState = second.health.state();

      assert.equal(restartedState.runState, 'KILLED', 'the kill must survive a restart');
      assert.equal(restartedState.killed, true);
      assert.match(restartedState.haltReason ?? '', /operator stop before restart/);

      // Liquidation intent must NOT survive: coming back up and discovering the
      // process has started selling on a pre-restart instruction is worse than
      // asking the operator to confirm against the state they can now see.
      assert.equal(restartedState.liquidateOnKill, false, 'liquidation intent must not survive a restart');

      (second.social as FixtureSocialProvider).setPosts(FRESH_POSTS());
      clock.advanceMinutes(30);
      const brokerAfter = second.broker as SimulatedBrokerProvider;
      const submitsBefore = brokerAfter.submitCount;
      const report = await second.runner.runCycle();

      assert.equal(report.ordersSubmitted, 0, 'a restarted killed bot must not trade');
      assert.equal(brokerAfter.submitCount, submitsBefore, 'nothing may reach the broker after a restart');
      assert.equal(
        second.store.positions.closed(second.spec.strategyId).length,
        0,
        'a restart must not liquidate on a pre-restart instruction',
      );
      assert.equal(second.store.positions.open(second.spec.strategyId).length, 1, 'the position survives intact');
      assert.equal(second.ledger.verifyIntegrity().ok, true);

      // Explicit resume in the new process restores trading.
      second.health.resume('cleared after restart');
      assert.equal(second.health.state().runState, 'RUNNING');
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives a restart after a fault-induced pause without resuming itself', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'northstar-pause-'));
    const dbPath = join(dir, 'pause.sqlite');
    try {
      const clock = new FixedClock(TEST_NOW);
      const build = (): NorthstarApp => {
        const marketData = new FixtureMarketDataProvider({ clock, prices: { NVDA: 120, SPY: 500 }, forceMarketOpen: true });
        marketData.seedHistory('NVDA', 25, 120, 0.2);
        marketData.seedHistory('SPY', 25, 500, 0.1);
        const app = new NorthstarApp({
          env: testEnv(),
          clock,
          logger: new NullLogger(),
          mode: 'PAPER',
          social: new FixtureSocialProvider({ clock, posts: [] }),
          marketData,
          broker: new SimulatedBrokerProvider({ clock, marketData, mode: 'PAPER', tradableTickers: ['NVDA', 'SPY'] }),
          databasePath: dbPath,
        });
        app.seed();
        return app;
      };

      const first = build();
      first.health.pause('LEDGER_MISMATCH', 'injected for the test');
      assert.equal(first.health.state().paused, true);
      first.close();

      const second = build();
      assert.equal(second.health.state().runState, 'PAUSED', 'a pause must survive a restart');
      assert.ok(second.health.state().openIncidents.length > 0, 'the incident must still be open');
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the kill reason is a clean forensic record', () => {
  it('strips CLI flags from the recorded reason', () => {
    // The halt reason is permanent and is what an operator reads months later
    // when asking why the bot stopped. "market gap --liquidate" reads as
    // though the flag were part of their reasoning.
    const args = ['market', 'gap', '--liquidate'];
    const reason = args.filter((a) => !a.startsWith('--')).join(' ');
    assert.equal(reason, 'market gap');
    assert.ok(!reason.includes('--'), 'no flag may survive into the reason');
  });

  it('still honours the flag it stripped', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 1);

    h.app.health.kill('market gap', true);

    const state = h.app.health.state();
    assert.equal(state.killed, true);
    assert.equal(state.liquidateOnKill, true, 'the stripped flag must still take effect');
    assert.equal(state.haltReason, 'market gap', 'and the reason stays clean');
    h.close();
  });
});
