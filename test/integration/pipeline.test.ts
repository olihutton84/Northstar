/**
 * End-to-end integration:
 *
 *   X event -> Signal -> TradeProposal -> Risk -> Alpaca Paper -> Fill ->
 *   Position -> Exit -> Outcome -> Analytics
 *
 * This is the Definition of Done for v0.1, asserted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  bullishTier1Post,
  corroboratingTier2Post,
  createHarness,
  echoChamber,
  noisePosts,
} from '../fixtures/harness.js';

describe('end-to-end paper pipeline', () => {
  it('carries an X post all the way to a filled position and an analytics record', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });

    const report = await h.app.runner.runCycle();

    /* --- ingestion -------------------------------------------------- */
    assert.equal(report.ingested, 2, 'both posts should be ingested');
    assert.equal(report.errors.length, 0, `cycle should be clean: ${report.errors.join('; ')}`);

    /* --- signal ------------------------------------------------------ */
    assert.ok(report.signalsGenerated >= 1, 'a signal should be generated');
    const signal = h.app.store.signals.recent(10).find((s) => s.ticker === 'NVDA');
    assert.ok(signal, 'an NVDA signal should exist');
    assert.ok(signal.score >= 35, `signal should be strong, got ${signal.score}`);
    assert.equal(signal.band, signal.score >= 60 ? 'STRONG_BULLISH' : 'BULLISH');
    assert.equal(signal.dominantEventType, 'GUIDANCE_CHANGE');
    assert.equal(signal.triggeringEventIds.length, 2, 'both posts should back the signal');
    assert.ok(signal.explanation.length > 80, 'every signal must carry a narrative explanation');
    assert.ok(signal.supportingEvidence.length > 0, 'supporting evidence must be recorded');
    assert.ok(signal.contributions.length >= 8, 'every component must report its contribution');
    assert.ok(signal.independentSourceCount > 1, 'two distinct credible sources should corroborate');

    /* --- proposal ---------------------------------------------------- */
    assert.equal(report.proposalsCreated, 1);
    const proposal = h.app.store.proposals.recent(5)[0];
    assert.ok(proposal);
    assert.equal(proposal.ticker, 'NVDA');
    assert.equal(proposal.direction, 'LONG');
    assert.equal(proposal.side, 'BUY');
    assert.ok(proposal.proposedCapitalCents > 0);
    assert.ok(proposal.proposedQuantity > 0);
    assert.ok(proposal.invalidationCondition.stopLossPct > 0, 'a proposal must carry an invalidation condition');
    assert.ok(proposal.approvalFingerprint.length > 0);

    /* --- risk --------------------------------------------------------- */
    assert.equal(report.riskApproved, 1);
    const risk = h.app.store.risk.byProposal(proposal.proposalId);
    assert.ok(risk);
    assert.equal(risk.approved, true, risk.summary);
    assert.ok(risk.checks.length >= 20, 'the risk engine must report every check it ran');
    assert.ok(risk.permittedCapitalCents <= proposal.proposedCapitalCents, 'risk may only reduce size');

    /* --- order and fill ------------------------------------------------ */
    assert.equal(report.ordersSubmitted, 1);
    const orders = h.app.store.orders.byProposal(proposal.proposalId);
    assert.equal(orders.length, 1);
    assert.equal(orders[0]!.mode, 'PAPER');

    /* --- position ------------------------------------------------------ */
    const positions = h.app.store.positions.open(h.app.spec.strategyId);
    assert.equal(positions.length, 1, 'the fill should have opened one position');
    const position = positions[0]!;
    assert.equal(position.ticker, 'NVDA');
    assert.ok(position.quantity > 0);
    assert.equal(position.entrySignalId, signal.signalId, 'position must link back to its signal');

    /* --- ledger -------------------------------------------------------- */
    const ledger = h.app.ledger.get();
    assert.ok(ledger.cashCents < ledger.startingCapitalCents, 'cash should have been spent');
    assert.ok(ledger.positionsValueCents > 0);
    assert.equal(h.app.ledger.verifyIntegrity().ok, true, 'the ledger must reconcile after a fill');
    assert.ok(
      Math.abs(ledger.equityCents - (ledger.cashCents + ledger.positionsValueCents)) <= 1,
      'equity must equal cash plus position value',
    );

    /* --- exit ---------------------------------------------------------- */
    // Move the price up past the take-profit and run another cycle.
    h.marketData.setPrice('NVDA', 120 * 1.2);
    h.clock.advanceHours(2);
    h.social.setPosts([]);
    const exitReport = await h.app.runner.runCycle();

    assert.ok(exitReport.exitsTriggered.length >= 1, 'the take-profit rule should have fired');
    assert.equal(exitReport.exitsTriggered[0]!.reason, 'TAKE_PROFIT');

    const closed = h.app.store.positions.closed(h.app.spec.strategyId);
    assert.equal(closed.length, 1, 'the position should be closed');
    const trade = closed[0]!;
    assert.equal(trade.exitReason, 'TAKE_PROFIT');
    assert.ok(trade.exitNote && trade.exitNote.length > 0, 'the exit reason must be recorded with detail');
    assert.ok((trade.realisedPnlCents ?? 0) > 0, 'a 20% move should realise a profit');
    assert.ok(trade.closedAt);

    /* --- ledger after the round trip ------------------------------------ */
    const finalLedger = h.app.ledger.get();
    assert.equal(h.app.ledger.verifyIntegrity().ok, true, 'the ledger must still reconcile after the exit');
    assert.ok(finalLedger.realisedPnlCents > 0);
    assert.ok(finalLedger.equityCents > finalLedger.startingCapitalCents, 'equity should exceed the $50 start');

    /* --- analytics ------------------------------------------------------ */
    const outcomes = h.app.store.outcomes.forSignal(signal.signalId);
    assert.equal(outcomes.length, 4, 'all four forward horizons should be registered');
    assert.deepEqual(
      outcomes.map((o) => o.horizon).sort(),
      ['1d', '1h', '1m', '1w'],
    );

    // Advance a day and measure.
    h.clock.advanceDays(1);
    h.marketData.seedHistory('NVDA', 25, 144, 0.2);
    h.marketData.seedHistory('SPY', 25, 505, 0.1);
    await h.app.forwardReturns.measurePending();

    const measured = h.app.store.outcomes.measured(h.app.spec.strategyId);
    assert.ok(measured.length >= 1, 'at least one horizon should now be measured');
    const daily = measured.find((o) => o.horizon === '1d');
    assert.ok(daily, '1d outcome should be measured');
    assert.ok(daily.forwardReturnPct !== null);
    assert.ok(daily.measuredAt !== null);

    /* --- survival ------------------------------------------------------- */
    const survival = h.app.survival.compute();
    assert.equal(survival.tradeCount, 1);
    assert.equal(survival.status, 'TESTING', 'one trade can never promote a strategy past TESTING');
    assert.equal(survival.sampleAdequate, false);

    /* --- decision log --------------------------------------------------- */
    const chain = h.app.store.log.byCorrelation(proposal.correlationId);
    const stages = chain.map((e) => e.stage);
    for (const stage of ['INGEST', 'SIGNAL', 'PROPOSAL', 'RISK', 'ORDER', 'FILL', 'POSITION']) {
      assert.ok(stages.includes(stage as never), `decision log should contain a ${stage} entry`);
    }

    h.close();
  });

  it('rejects noise and does not let an echo chamber manufacture confirmation', async () => {
    const h = createHarness({ posts: [...noisePosts(), ...echoChamber(10)] });
    const report = await h.app.runner.runCycle();

    assert.ok(report.filtered.rejected >= 4, 'the four obvious noise posts should be rejected');

    // Ten identical retellings collapse: the first is kept, the rest are
    // rejected as exact duplicates, so confirmation cannot be manufactured.
    const signals = h.app.store.signals.recent(10);
    for (const signal of signals) {
      assert.ok(
        signal.independentSourceCount <= 1.1,
        `an echo chamber must not count as many independent sources, got ${signal.independentSourceCount}`,
      );
    }

    // Retail echo alone must not clear the trading bar.
    assert.equal(report.ordersSubmitted, 0, 'noise and echo must not produce an order');

    h.close();
  });

  it('does not open a position when only unverified accounts are talking', async () => {
    const h = createHarness({
      posts: [
        {
          postId: 'anon-1',
          handle: 'anonalpha',
          text: 'Hearing NVIDIA might raise guidance next week, could be a huge beat. $NVDA',
          minutesAgo: 5,
          likes: 4000,
          baselineEngagement: 100,
        },
      ],
    });

    const report = await h.app.runner.runCycle();
    assert.equal(report.ordersSubmitted, 0, 'a single Tier-4 rumour must not trade');
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 0);
    h.close();
  });
});
