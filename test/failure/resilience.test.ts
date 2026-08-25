/**
 * Failure modes.
 *
 * The requirement is that no failure creates an uncontrolled order loop, and
 * that the strategy degrades to inaction rather than to guessing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BrokerError } from '../../src/providers/broker/BrokerProvider.js';
import { MarketDataError } from '../../src/providers/marketdata/MarketDataProvider.js';
import { SocialProviderError } from '../../src/providers/social/SocialDataProvider.js';
import { bullishTier1Post, corroboratingTier2Post, createHarness } from '../fixtures/harness.js';

const POSTS = () => [bullishTier1Post(), corroboratingTier2Post()];

describe('X provider failures', () => {
  it('survives X being unavailable and keeps managing existing positions', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 1);

    h.social.setFailure(new SocialProviderError('X is down', 'UNAVAILABLE'));
    h.clock.advanceMinutes(30);
    h.marketData.setPrice('NVDA', 120 * 0.85); // trigger the stop loss

    const report = await h.app.runner.runCycle();
    assert.ok(report.errors.some((e) => e.startsWith('ingest:')), 'the ingest failure should be reported');
    assert.ok(
      report.exitsTriggered.some((e) => e.reason === 'STOP_LOSS'),
      'existing positions must still be protected while X is down',
    );
    h.close();
  });

  it('pauses the strategy after the configured X failure tolerance', async () => {
    const h = createHarness({ posts: POSTS() });
    h.social.setFailure(new SocialProviderError('X is down', 'UNAVAILABLE'));

    for (let i = 0; i < 3; i += 1) {
      h.clock.advanceMinutes(15);
      await h.app.runner.runCycle();
    }

    const state = h.app.health.state();
    assert.equal(state.paused, true, 'repeated X failures must pause the strategy');
    assert.ok(state.openIncidents.some((i) => i.fault === 'SOCIAL_PROVIDER_FAILURE'));
    h.close();
  });

  it('pauses immediately on an X authentication failure', async () => {
    const h = createHarness({ posts: POSTS() });
    h.social.setFailure(new SocialProviderError('Bad token', 'AUTH'));
    await h.app.runner.runCycle();

    assert.equal(h.app.health.state().paused, true, 'an auth failure is never transient');
    h.close();
  });

  it('treats a rate limit as a failure without retrying into a loop', async () => {
    const h = createHarness({ posts: POSTS() });
    h.social.setFailure(new SocialProviderError('Rate limited', 'RATE_LIMIT', 900));
    const before = h.social.fetchCount;
    await h.app.runner.runCycle();

    assert.equal(h.social.fetchCount, before + 1, 'one cycle must make exactly one fetch attempt');
    assert.equal(h.app.store.orders.all().length, 0);
    h.close();
  });
});

describe('market data failures', () => {
  it('produces no order when prices are unavailable', async () => {
    const h = createHarness({ posts: POSTS() });
    h.marketData.setFailure(new MarketDataError('Tiingo down', 'UNAVAILABLE'));
    const report = await h.app.runner.runCycle();

    assert.equal(report.ordersSubmitted, 0, 'no price means no trade');
    assert.equal(h.broker.submitCount, 0);
    h.close();
  });

  it('does not let stale data reach the broker', async () => {
    const h = createHarness({ posts: POSTS() });
    h.marketData.setQuoteAgeMinutes(90);
    await h.app.runner.runCycle();

    assert.equal(h.broker.submitCount, 0);
    const failed = h.app.store.risk.recent(5).flatMap((d) => d.failedChecks);
    assert.ok(failed.includes('MARKET_DATA_FRESHNESS'));
    h.close();
  });
});

describe('broker failures', () => {
  it('releases reserved capital when a submission is rejected', async () => {
    const h = createHarness({ posts: POSTS() });
    h.broker.setSubmitFailure(new BrokerError('Order rejected by exchange', 'REJECTED'));

    const before = h.app.ledger.get();
    const report = await h.app.runner.runCycle();
    const after = h.app.ledger.get();

    assert.ok(report.errors.length > 0);
    assert.equal(after.reservedCents, 0, 'a failed order must not strand reserved capital');
    assert.equal(after.cashCents, before.cashCents, 'no cash may move on a rejected order');
    assert.equal(h.app.ledger.verifyIntegrity().ok, true);
    h.close();
  });

  it('does not retry a rejected order into a loop', async () => {
    const h = createHarness({ posts: POSTS() });
    h.broker.setSubmitFailure(new BrokerError('Order rejected', 'REJECTED'));
    await h.app.runner.runCycle();
    const attemptsAfterFirst = h.broker.submitCount;

    // Same posts, next cycle: the failed proposal must not be resubmitted.
    h.clock.advanceMinutes(20);
    await h.app.runner.runCycle();

    assert.ok(
      h.broker.submitCount - attemptsAfterFirst <= 1,
      'a rejected order must not be retried repeatedly within the same story',
    );
    h.close();
  });

  it('refuses to trade when the broker is unavailable, and pauses after repeated failures', async () => {
    const h = createHarness({ posts: POSTS() });
    h.broker.setFailure(new BrokerError('Alpaca is down', 'UNAVAILABLE', true));

    for (let i = 0; i < 4; i += 1) {
      h.clock.advanceMinutes(15);
      h.social.setPosts([]);
      await h.app.runner.runCycle();
    }

    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 0);
    assert.equal(h.app.health.state().paused, true, 'repeated broker failures must pause the strategy');
    h.close();
  });

  it('pauses immediately on a broker authentication failure', async () => {
    const h = createHarness({ posts: POSTS() });
    h.broker.setFailure(new BrokerError('Bad key', 'AUTH'));
    await h.app.runner.runCycle();

    const state = h.app.health.state();
    assert.equal(state.paused, true);
    assert.ok(state.openIncidents.some((i) => i.fault === 'BROKER_AUTH_FAILURE'));
    h.close();
  });

  it('does not submit when the broker reports the market closed', async () => {
    const h = createHarness({ posts: POSTS() });
    h.broker.setMarketOpen(false);
    h.marketData.setMarketOpen(false);
    await h.app.runner.runCycle();

    assert.equal(h.broker.submitCount, 0);
    h.close();
  });

  it('handles insufficient buying power at the broker without corrupting the ledger', async () => {
    const h = createHarness({ posts: POSTS() });
    h.broker.setSubmitFailure(new BrokerError('Insufficient buying power', 'INSUFFICIENT_FUNDS'));
    await h.app.runner.runCycle();

    const ledger = h.app.ledger.get();
    assert.equal(ledger.reservedCents, 0);
    assert.equal(ledger.cashCents, ledger.startingCapitalCents);
    assert.equal(h.app.ledger.verifyIntegrity().ok, true);
    h.close();
  });
});

describe('order lifecycle failures', () => {
  it('opens a correctly-sized position on a partial fill and returns the unused capital', async () => {
    const h = createHarness({ posts: POSTS() });
    h.broker.setFillMode('PARTIAL');

    await h.app.runner.runCycle();

    const positions = h.app.store.positions.open(h.app.spec.strategyId);
    assert.equal(positions.length, 1, 'a partial fill still opens a position');
    const position = positions[0]!;
    const order = h.app.store.orders.byId(position.entryOrderId)!;

    assert.ok(position.quantity > 0);
    assert.ok(
      position.entryCostCents <= (order.notionalCents ?? Number.MAX_SAFE_INTEGER),
      'the position must not cost more than was reserved',
    );
    assert.equal(h.app.ledger.verifyIntegrity().ok, true, 'the ledger must reconcile after a partial fill');

    const ledger = h.app.ledger.get();
    assert.equal(
      ledger.cashCents + ledger.positionsValueCents,
      ledger.equityCents,
      'equity must still reconcile after a partial fill',
    );
    h.close();
  });

  it('never records the same fill twice', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();

    const cashAfterFirst = h.app.ledger.get().cashCents;
    // Reconcile repeatedly: the broker keeps reporting the same filled order.
    await h.app.positionManager.reconcile();
    await h.app.positionManager.reconcile();
    await h.app.positionManager.reconcile();

    assert.equal(h.app.ledger.get().cashCents, cashAfterFirst, 'repeat reconciliation must not re-spend cash');
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 1);
    assert.equal(h.app.ledger.verifyIntegrity().ok, true);
    h.close();
  });

  it('is idempotent on duplicate client order ids', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();
    const submitsAfterFirst = h.broker.submitCount;

    const proposal = h.app.store.proposals.recent(1)[0]!;
    const risk = h.app.store.risk.byProposal(proposal.proposalId)!;
    const signal = h.app.store.signals.byId(proposal.signalId)!;

    const outcome = await h.app.orderRouter.submitEntry(proposal, risk, signal);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'DUPLICATE');
    assert.equal(h.broker.submitCount, submitsAfterFirst, 'the broker must not receive a second order');
    h.close();
  });

  it('ignores a duplicate X event rather than double-counting it', async () => {
    const h = createHarness({ posts: POSTS() });
    const first = await h.app.runner.runCycle();
    assert.equal(first.ingested, 2);

    // The provider returns exactly the same posts again.
    h.clock.advanceMinutes(5);
    const second = await h.app.runner.runCycle();
    assert.equal(second.ingested, 0, 'already-seen posts must not be stored again');
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 1, 'and must not open a second position');
    h.close();
  });

  it('leaves the position open and retries when an exit order is rejected', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 1);

    h.broker.setSubmitFailure(new BrokerError('Exit rejected', 'REJECTED'));
    h.marketData.setPrice('NVDA', 120 * 0.85);
    h.clock.advanceMinutes(30);
    h.social.setPosts([]);
    await h.app.runner.runCycle();

    assert.equal(
      h.app.store.positions.open(h.app.spec.strategyId).length,
      1,
      'a rejected exit must leave the position open, not silently mark it closed',
    );

    // Once the broker recovers, the exit goes through.
    h.broker.setSubmitFailure(null);
    h.clock.advanceMinutes(15);
    await h.app.runner.runCycle();

    const closed = h.app.store.positions.closed(h.app.spec.strategyId);
    assert.equal(closed.length, 1, 'the exit must be retried and succeed');
    assert.equal(closed[0]!.exitReason, 'STOP_LOSS');
    h.close();
  });
});

describe('kill switch and state integrity', () => {
  it('stops new orders but leaves positions untouched by default', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();
    const openBefore = h.app.store.positions.open(h.app.spec.strategyId).length;
    assert.equal(openBefore, 1);

    h.app.health.kill('Operator stop', false);
    h.clock.advanceMinutes(20);
    h.social.setPosts([
      bullishTier1Post({ postId: 'pfe-1', handle: 'pfizer', text: 'Pfizer raises full-year guidance to $62.0B after FDA approval. $PFE' }),
      corroboratingTier2Post({ postId: 'pfe-2', handle: 'reuters', text: 'Pfizer lifts full-year guidance to $62.0 billion after FDA approval. $PFE' }),
    ]);
    const submitsBefore = h.broker.submitCount;
    await h.app.runner.runCycle();

    assert.equal(h.broker.submitCount, submitsBefore, 'a killed bot must submit nothing');
    assert.equal(
      h.app.store.positions.open(h.app.spec.strategyId).length,
      openBefore,
      'killing the bot must not liquidate positions unless liquidation was chosen',
    );
    h.close();
  });

  it('liquidates only when liquidation is explicitly selected', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();

    h.app.health.kill('Operator stop with liquidation', true);
    h.clock.advanceMinutes(20);
    h.social.setPosts([]);
    await h.app.runner.runCycle();

    const closed = h.app.store.positions.closed(h.app.spec.strategyId);
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.exitReason, 'KILL_SWITCH_LIQUIDATION');
    h.close();
  });

  it('preserves the decision log through a kill', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();
    const before = h.app.store.log.recent(500).length;

    h.app.health.kill('Operator stop', false);
    const after = h.app.store.log.recent(500).length;

    assert.ok(after >= before, 'the kill switch must never destroy logs');
    assert.ok(h.app.store.log.recent(500).some((e) => e.summary.includes('KILL BOT engaged')));
    h.close();
  });

  it('pauses on a ledger mismatch and refuses to trade on it', async () => {
    const h = createHarness({ posts: POSTS() });
    const ledger = h.app.ledger.get();
    h.app.store.ledger.save({ ...ledger, cashCents: ledger.cashCents - 1234 });

    const report = await h.app.runner.runCycle();

    assert.equal(report.halted, true);
    assert.equal(h.app.health.state().paused, true);
    assert.ok(h.app.health.state().openIncidents.some((i) => i.fault === 'LEDGER_MISMATCH'));
    assert.equal(h.broker.submitCount, 0);
    h.close();
  });

  it('pauses on corrupt strategy state', async () => {
    const h = createHarness();
    const strategy = h.app.store.strategies.byId(h.app.spec.strategyId)!;
    h.app.store.strategies.upsert({ ...strategy, allocatedCapitalCents: -1 });

    const report = await h.app.runner.runCycle();
    assert.equal(report.halted, true);
    assert.ok(h.app.health.state().openIncidents.some((i) => i.fault === 'CORRUPT_STRATEGY_STATE'));
    h.close();
  });

  it('resumes cleanly after a fault is cleared', async () => {
    const h = createHarness({ posts: POSTS() });
    h.social.setFailure(new SocialProviderError('Bad token', 'AUTH'));
    await h.app.runner.runCycle();
    assert.equal(h.app.health.state().paused, true);

    h.social.setFailure(null);
    h.app.health.resume('Token rotated');
    const state = h.app.health.state();

    assert.equal(state.runState, 'RUNNING');
    assert.equal(state.openIncidents.length, 0);
    assert.equal(state.failureCounts.social, 0);
    h.close();
  });
});
