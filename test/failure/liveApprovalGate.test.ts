/**
 * The live approval gate.
 *
 * The Definition of Done requires that no route allows an X or model-derived
 * signal to reach a live-money order without explicit human approval of that
 * exact order. These tests attack that claim from every direction available in
 * the codebase.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintTerms, termsFor } from '../../src/pipeline/proposal.js';
import { bullishTier1Post, corroboratingTier2Post, createHarness } from '../fixtures/harness.js';

async function liveHarness() {
  const h = createHarness({
    mode: 'LIVE',
    liveTradingEnabled: true,
    posts: [bullishTier1Post(), corroboratingTier2Post()],
  });
  h.app.setMode('LIVE');
  const report = await h.app.runner.runCycle();
  return { h, report };
}

describe('LIVE mode approval gate', () => {
  it('stops at AWAITING_APPROVAL and submits nothing on its own', async () => {
    const { h, report } = await liveHarness();

    assert.ok(report.signalsGenerated >= 1, 'the signal engine still runs in live mode');
    assert.equal(report.proposalsCreated, 1);
    assert.equal(report.riskApproved, 1);
    assert.equal(report.awaitingApproval, 1);
    assert.equal(report.ordersSubmitted, 0, 'LIVE mode must never auto-submit');

    assert.equal(h.broker.submitCount, 0, 'nothing reached the broker');
    assert.equal(h.app.store.orders.all().length, 0);
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 0);

    const proposal = h.app.store.proposals.recent(1)[0]!;
    assert.equal(proposal.status, 'AWAITING_APPROVAL');
    h.close();
  });

  it('refuses submission when the OrderRouter is called directly with no approval', async () => {
    const { h } = await liveHarness();
    const proposal = h.app.store.proposals.recent(1)[0]!;
    const risk = h.app.store.risk.byProposal(proposal.proposalId)!;
    const signal = h.app.store.signals.byId(proposal.signalId)!;

    // Bypass the approval service entirely and go straight at the router.
    const outcome = await h.app.orderRouter.submitEntry(proposal, risk, signal);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'NO_APPROVAL');
    assert.equal(h.broker.submitCount, 0, 'the broker must not have been touched');
    h.close();
  });

  it('refuses submission when the user REJECTED the proposal', async () => {
    const { h } = await liveHarness();
    const proposal = h.app.store.proposals.recent(1)[0]!;
    const risk = h.app.store.risk.byProposal(proposal.proposalId)!;
    const signal = h.app.store.signals.byId(proposal.signalId)!;

    h.app.approvals.reject(proposal.proposalId, 'operator', 'Not convinced');
    const outcome = await h.app.orderRouter.submitEntry(proposal, risk, signal);

    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'NO_APPROVAL');
    assert.equal(h.broker.submitCount, 0);
    assert.equal(h.app.store.proposals.byId(proposal.proposalId)!.status, 'REJECTED_BY_USER');
    h.close();
  });

  it('refuses an approval whose fingerprint does not match the displayed terms', async () => {
    const { h } = await liveHarness();
    const proposal = h.app.store.proposals.recent(1)[0]!;

    const result = await h.app.approvals.approve(proposal.proposalId, 'operator', 'a-stale-fingerprint');

    assert.equal(result.ok, false);
    assert.match(result.detail, /changed since it was displayed/);
    assert.equal(h.broker.submitCount, 0);
    assert.equal(h.app.store.proposals.byId(proposal.proposalId)!.status, 'INVALIDATED');
    h.close();
  });

  it('invalidates rather than executes when the price moves materially before approval', async () => {
    const { h } = await liveHarness();
    const proposal = h.app.store.proposals.recent(1)[0]!;
    const signal = h.app.store.signals.byId(proposal.signalId)!;
    const fingerprint = fingerprintTerms(termsFor(proposal, signal.score));

    // The user reviews, then the market moves 5% before they click.
    h.marketData.setPrice('NVDA', proposal.referencePrice * 1.05);
    const result = await h.app.approvals.approve(proposal.proposalId, 'operator', fingerprint);

    assert.equal(result.ok, false);
    assert.equal(result.outcome?.ok === false && result.outcome.reason, 'INVALIDATED');
    assert.match(result.detail, /Price moved/);
    assert.equal(h.broker.submitCount, 0, 'a moved market must not execute the stale order');
    h.close();
  });

  it('submits exactly once when a human approves the exact terms', async () => {
    const { h } = await liveHarness();
    const proposal = h.app.store.proposals.recent(1)[0]!;
    const signal = h.app.store.signals.byId(proposal.signalId)!;
    const fingerprint = fingerprintTerms(termsFor(proposal, signal.score));

    const result = await h.app.approvals.approve(proposal.proposalId, 'operator', fingerprint, 'Looks right');

    assert.equal(result.ok, true, result.detail);
    assert.equal(h.broker.submitCount, 1);

    const approval = h.app.store.approvals.latestForProposal(proposal.proposalId)!;
    assert.equal(approval.decision, 'APPROVED');
    assert.equal(approval.decidedBy, 'operator');
    assert.equal(approval.approvalFingerprint, fingerprint, 'the approval binds to the exact terms');

    // The order exists and is live-mode.
    const orders = h.app.store.orders.byProposal(proposal.proposalId);
    assert.equal(orders.length, 1);
    assert.equal(orders[0]!.mode, 'LIVE');

    // A second approval must not create a second order.
    const again = await h.app.approvals.approve(proposal.proposalId, 'operator', fingerprint);
    assert.equal(again.outcome?.ok === false && again.outcome.reason, 'DUPLICATE');
    assert.equal(h.broker.submitCount, 1, 'double-clicking approve must not double-buy');
    h.close();
  });

  it('refuses an expired proposal even with a valid approval', async () => {
    const { h } = await liveHarness();
    const proposal = h.app.store.proposals.recent(1)[0]!;
    const signal = h.app.store.signals.byId(proposal.signalId)!;
    const fingerprint = fingerprintTerms(termsFor(proposal, signal.score));

    h.clock.advanceHours(2); // well past the 15-minute TTL
    const result = await h.app.approvals.approve(proposal.proposalId, 'operator', fingerprint);

    assert.equal(result.ok, false);
    assert.match(result.detail, /expired/i);
    assert.equal(h.broker.submitCount, 0);
    h.close();
  });

  it('shows the user everything the spec requires before they approve', async () => {
    const { h } = await liveHarness();
    const proposal = h.app.store.proposals.recent(1)[0]!;
    const quote = await h.marketData.getQuote(proposal.ticker);
    const view = h.app.approvals.present(proposal.proposalId, quote.price)!;

    assert.ok(view.ticker);
    assert.equal(view.direction, 'LONG');
    assert.ok(view.dollarAmount.startsWith('$'));
    assert.ok(view.approximateShares > 0);
    assert.ok(view.signal.explanation.length > 50, 'the signal reasoning must be shown');
    assert.ok(view.reasoning.length > 50);
    assert.ok(view.sources.length >= 2, 'the sources behind the signal must be shown');
    assert.ok(view.strategyPnl.equity.startsWith('$'), 'current strategy P&L must be shown');
    assert.ok(view.resultingExposure.exposureAfterPct > view.resultingExposure.currentExposurePct);
    assert.ok(view.riskImpact.checks.length > 10, 'the risk impact must be shown');
    assert.ok(view.invalidationCondition.length > 20);
    assert.ok(view.approvalFingerprint.length > 0);
    assert.equal(view.actionable, true);
    h.close();
  });

  it('marks a proposal unactionable once it can no longer be approved', async () => {
    const { h } = await liveHarness();
    const proposal = h.app.store.proposals.recent(1)[0]!;
    h.clock.advanceHours(2);

    const view = h.app.approvals.present(proposal.proposalId, 120)!;
    assert.equal(view.actionable, false);
    assert.ok(view.blockReason);
    h.close();
  });

  it('will not construct a LIVE broker without explicit live-trading opt-in', async () => {
    const { loadAlpacaCredentials } = await import('../../src/config/env.js');
    const saved = { ...process.env };
    try {
      delete process.env['NORTHSTAR_LIVE_TRADING_ENABLED'];
      process.env['ALPACA_LIVE_KEY_ID'] = 'k';
      process.env['ALPACA_LIVE_SECRET_KEY'] = 's';
      assert.throws(() => loadAlpacaCredentials('LIVE'), /LIVE trading is disabled/);

      // And even with the opt-in, it refuses a paper endpoint.
      process.env['NORTHSTAR_LIVE_TRADING_ENABLED'] = 'true';
      process.env['ALPACA_LIVE_BASE_URL'] = 'https://paper-api.alpaca.markets';
      assert.throws(() => loadAlpacaCredentials('LIVE'), /paper endpoint/);
    } finally {
      process.env = saved;
    }
  });

  it('never mixes PAPER and LIVE credentials', async () => {
    const { loadAlpacaCredentials } = await import('../../src/config/env.js');
    const saved = { ...process.env };
    try {
      process.env['ALPACA_PAPER_KEY_ID'] = 'paper-key';
      process.env['ALPACA_PAPER_SECRET_KEY'] = 'paper-secret';
      delete process.env['ALPACA_LIVE_KEY_ID'];
      delete process.env['ALPACA_LIVE_SECRET_KEY'];
      process.env['NORTHSTAR_LIVE_TRADING_ENABLED'] = 'true';

      // LIVE must NOT silently fall back to the paper credentials that exist.
      assert.throws(() => loadAlpacaCredentials('LIVE'), /LIVE credentials missing/);

      const paper = loadAlpacaCredentials('PAPER');
      assert.equal(paper.mode, 'PAPER');
      assert.ok(paper.baseUrl.includes('paper-api'));
    } finally {
      process.env = saved;
    }
  });
});
