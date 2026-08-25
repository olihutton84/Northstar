/**
 * Execution stress.
 *
 * The complete list of broker/market failures the system must survive, each
 * asserted explicitly. The invariant behind all of them is the same: after any
 * failure the ledger must still reconcile, reserved capital must not exceed
 * cash, and no uncontrolled retry loop may form.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BrokerError } from '../../src/providers/broker/BrokerProvider.js';
import { MarketDataError } from '../../src/providers/marketdata/MarketDataProvider.js';
import { fingerprintTerms, termsFor } from '../../src/pipeline/proposal.js';
import { bullishTier1Post, corroboratingTier2Post, createHarness, type Harness } from '../fixtures/harness.js';

const POSTS = () => [bullishTier1Post(), corroboratingTier2Post()];

/** The invariants that must hold after ANY execution failure. */
function assertBooksSane(h: Harness, context: string): void {
  const ledger = h.app.ledger.get();
  const integrity = h.app.ledger.verifyIntegrity();
  const state = h.app.health.verifyStateIntegrity();

  assert.equal(integrity.ok, true, `${context}: ledger did not reconcile — ${integrity.detail}`);
  assert.ok(ledger.cashCents >= 0, `${context}: cash went negative`);
  assert.ok(ledger.reservedCents >= 0, `${context}: reserved went negative`);
  assert.ok(ledger.reservedCents <= ledger.cashCents, `${context}: reserved ${ledger.reservedCents} exceeded cash ${ledger.cashCents}`);
  assert.equal(state.ok, true, `${context}: state integrity broke — ${state.problems.join('; ')}`);
  assert.equal(
    ledger.equityCents,
    ledger.cashCents + ledger.positionsValueCents,
    `${context}: equity identity broke`,
  );
}

describe('execution stress', () => {
  it('survives an Alpaca 429 rate limit without retrying into a loop', async () => {
    const h = createHarness({ posts: POSTS() });
    h.broker.setSubmitFailure(new BrokerError('Too many requests', 'RATE_LIMIT', true));

    await h.app.runner.runCycle();
    const afterFirst = h.broker.submitCount;

    h.clock.advanceMinutes(20);
    await h.app.runner.runCycle();

    assert.ok(h.broker.submitCount - afterFirst <= 1, 'a 429 must not trigger a retry storm');
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 0);
    assertBooksSane(h, '429');
    h.close();
  });

  it('survives a network timeout', async () => {
    const h = createHarness({ posts: POSTS() });
    h.broker.setSubmitFailure(new BrokerError('The operation was aborted due to timeout', 'NETWORK', true));

    const report = await h.app.runner.runCycle();
    assert.ok(report.errors.length > 0, 'the timeout should be reported');
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 0);
    assertBooksSane(h, 'network timeout');
    h.close();
  });

  it('refuses a duplicate submission of the same proposal', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();
    const submits = h.broker.submitCount;

    const proposal = h.app.store.proposals.recent(1)[0]!;
    const risk = h.app.store.risk.byProposal(proposal.proposalId)!;
    const signal = h.app.store.signals.byId(proposal.signalId)!;

    for (let i = 0; i < 3; i += 1) {
      const outcome = await h.app.orderRouter.submitEntry(proposal, risk, signal);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.ok === false && outcome.reason, 'DUPLICATE');
    }
    assert.equal(h.broker.submitCount, submits, 'the broker must see exactly one submission');
    assertBooksSane(h, 'duplicate submission');
    h.close();
  });

  it('handles a partial fill and returns the unspent reservation', async () => {
    const h = createHarness({ posts: POSTS() });
    h.broker.setFillMode('PARTIAL');
    await h.app.runner.runCycle();

    const positions = h.app.store.positions.open(h.app.spec.strategyId);
    assert.equal(positions.length, 1);
    const order = h.app.store.orders.byId(positions[0]!.entryOrderId)!;
    assert.ok(positions[0]!.entryCostCents <= (order.notionalCents ?? Infinity));
    assertBooksSane(h, 'partial fill');
    h.close();
  });

  it('handles a rejected order', async () => {
    const h = createHarness({ posts: POSTS() });
    h.broker.setSubmitFailure(new BrokerError('Order rejected by exchange', 'REJECTED'));
    await h.app.runner.runCycle();

    const proposal = h.app.store.proposals.recent(1)[0]!;
    assert.equal(proposal.status, 'FAILED');
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 0);
    assertBooksSane(h, 'rejected order');
    h.close();
  });

  it('handles an order cancelled at the broker', async () => {
    const h = createHarness({ posts: POSTS() });
    h.broker.setFillMode('NEVER');
    await h.app.runner.runCycle();

    const orders = h.app.store.orders.open(h.app.spec.strategyId);
    assert.equal(orders.length, 1, 'an unfilled order should still be open');
    const ledgerDuring = h.app.ledger.get();
    assert.ok(ledgerDuring.reservedCents > 0, 'capital should be reserved while the order is live');

    // The kill switch cancels it; the reservation must come back.
    await h.app.orderRouter.cancelOpenOrders(h.app.spec.strategyId);
    const after = h.app.ledger.get();
    assert.equal(after.reservedCents, 0, 'cancelling must release the reservation');
    assert.equal(after.cashCents, after.startingCapitalCents, 'no cash should have moved');
    assertBooksSane(h, 'cancelled order');
    h.close();
  });

  it('handles the market closing mid-cycle', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 1);

    // The bell rings while a position is open and a new story arrives.
    h.marketData.setMarketOpen(false);
    h.broker.setMarketOpen(false);
    h.clock.advanceHours(1);
    h.social.setPosts([
      bullishTier1Post({ postId: 'pfe-x', handle: 'pfizer', text: 'Pfizer raises full-year guidance to $62.0B after FDA approval. $PFE' }),
      corroboratingTier2Post({ postId: 'pfe-y', handle: 'reuters', text: 'Pfizer lifts full-year guidance to $62.0 billion after FDA approval. $PFE' }),
    ]);

    const submitsBefore = h.broker.submitCount;
    const report = await h.app.runner.runCycle();

    assert.equal(h.broker.submitCount, submitsBefore, 'no order may be placed into a closed market');
    assert.ok(
      h.app.store.risk.recent(5).some((d) => d.failedChecks.includes('MARKET_HOURS')),
      'the closed market must be recorded as the reason',
    );
    assert.equal(report.errors.length, 0, 'a closed market is normal, not an error');
    assertBooksSane(h, 'market closed mid-cycle');
    h.close();
  });

  it('invalidates rather than executes when price moves materially before approval', async () => {
    const h = createHarness({ mode: 'LIVE', liveTradingEnabled: true, posts: POSTS() });
    h.app.setMode('LIVE');
    await h.app.runner.runCycle();

    const proposal = h.app.store.proposals.recent(1)[0]!;
    const signal = h.app.store.signals.byId(proposal.signalId)!;
    const fingerprint = fingerprintTerms(termsFor(proposal, signal.score));

    h.marketData.setPrice('NVDA', proposal.referencePrice * 1.04);
    const result = await h.app.approvals.approve(proposal.proposalId, 'operator', fingerprint);

    assert.equal(result.ok, false);
    assert.equal(h.broker.submitCount, 0);
    assert.equal(h.app.store.proposals.byId(proposal.proposalId)!.status, 'INVALIDATED');
    assertBooksSane(h, 'price drift before approval');
    h.close();
  });

  it('refuses to trade on a stale price', async () => {
    const h = createHarness({ posts: POSTS() });
    h.marketData.setQuoteAgeMinutes(240);
    await h.app.runner.runCycle();

    assert.equal(h.broker.submitCount, 0);
    assert.ok(h.app.store.risk.recent(5).some((d) => d.failedChecks.includes('MARKET_DATA_FRESHNESS')));
    assertBooksSane(h, 'stale price');
    h.close();
  });

  it('halts on a ledger mismatch and does not trade through it', async () => {
    const h = createHarness({ posts: POSTS() });
    const ledger = h.app.ledger.get();
    h.app.store.ledger.save({ ...ledger, cashCents: ledger.cashCents - 777 });

    const report = await h.app.runner.runCycle();
    assert.equal(report.halted, true);
    assert.equal(h.broker.submitCount, 0);
    assert.ok(h.app.health.state().openIncidents.some((i) => i.fault === 'LEDGER_MISMATCH'));
    h.close();
  });

  it('detects a broker/account position mismatch without repairing it', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();
    const position = h.app.store.positions.open(h.app.spec.strategyId)[0]!;

    // Northstar believes it holds more than the broker will confirm.
    h.app.store.positions.save({ ...position, quantity: position.quantity * 5 });

    const report = await h.app.reconciliation.reconcile();
    assert.equal(report.ok, false);
    assert.ok(
      report.discrepancies.some((d) => d.area === 'POSITIONS' && d.severity === 'CRITICAL'),
      `expected a critical position discrepancy, got ${JSON.stringify(report.discrepancies)}`,
    );

    // Read-only: the discrepancy is still there afterwards.
    const after = h.app.store.positions.open(h.app.spec.strategyId)[0]!;
    assert.equal(after.quantity, position.quantity * 5, 'reconciliation must not repair anything');
    h.close();
  });

  it('detects a Northstar-tagged broker order with no local record', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();

    // An order placed by some other process using the Northstar prefix.
    h.broker.setFillMode('NEVER');
    await h.broker.submitOrder({
      clientOrderId: 'ns-entry-ghost',
      ticker: 'AAPL',
      side: 'BUY',
      quantity: 1,
      type: 'MARKET',
      timeInForce: 'DAY',
    });

    const report = await h.app.reconciliation.reconcile();
    assert.ok(
      report.discrepancies.some((d) => d.area === 'ORDERS' && d.severity === 'CRITICAL'),
      'a Northstar-tagged order with no local record is critical',
    );
    h.close();
  });

  it('reports the broker being unreachable without claiming the books are wrong', async () => {
    const h = createHarness({ posts: POSTS() });
    h.broker.setFailure(new BrokerError('Alpaca is down', 'UNAVAILABLE', true));

    const report = await h.app.reconciliation.reconcile();
    assert.equal(report.reachedBroker, false);
    assert.ok(report.discrepancies.every((d) => d.severity !== 'CRITICAL'),
      'an unreachable broker is a warning, not proof of a books mismatch');
    assert.equal(report.ledger.integrityOk, true);
    h.close();
  });

  it('keeps the books sane through a gauntlet of consecutive failures', async () => {
    const h = createHarness({ posts: POSTS() });

    const faults: (() => void)[] = [
      () => h.broker.setSubmitFailure(new BrokerError('rate limited', 'RATE_LIMIT', true)),
      () => h.broker.setSubmitFailure(new BrokerError('timeout', 'NETWORK', true)),
      () => h.broker.setSubmitFailure(new BrokerError('rejected', 'REJECTED')),
      () => { h.broker.setSubmitFailure(null); h.marketData.setFailure(new MarketDataError('down', 'UNAVAILABLE')); },
      () => { h.marketData.setFailure(null); h.marketData.setQuoteAgeMinutes(500); },
      () => { h.marketData.setQuoteAgeMinutes(0); h.broker.setMarketOpen(false); },
      () => { h.broker.setMarketOpen(true); h.broker.setFillMode('PARTIAL'); },
      () => h.broker.setFillMode('IMMEDIATE'),
    ];

    for (const [i, applyFault] of faults.entries()) {
      applyFault();
      h.clock.advanceMinutes(20);
      await h.app.runner.runCycle();
      assertBooksSane(h, `gauntlet step ${i}`);
      // The strategy may pause; that is a valid response. It must never trade
      // through a fault into an inconsistent state.
      if (h.app.health.state().paused) h.app.health.resume('gauntlet: fault cleared');
    }
    h.close();
  });
});
