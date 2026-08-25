/**
 * Reconciliation, readiness, the signal audit trail and the observability
 * payload behind the health panel.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildObservability } from '../../src/api/observability.js';
import { BrokerError } from '../../src/providers/broker/BrokerProvider.js';
import { bullishTier1Post, corroboratingTier2Post, createHarness, noisePosts } from '../fixtures/harness.js';

const POSTS = () => [bullishTier1Post(), corroboratingTier2Post()];

/* ------------------------------------------------------- reconciliation --- */

describe('reconciliation', () => {
  it('reports clean books and mutates nothing', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();

    const before = {
      ledger: { ...h.app.ledger.get() },
      positions: h.app.store.positions.all(h.app.spec.strategyId).length,
      orders: h.app.store.orders.all().length,
      logs: h.app.store.log.recent(1000).length,
    };

    const report = await h.app.reconciliation.reconcile();

    assert.equal(report.ok, true, report.summary);
    assert.equal(report.reachedBroker, true);
    assert.equal(report.ledger.integrityOk, true);
    assert.match(report.summary, /Nothing was modified/);

    // Read-only, asserted rather than assumed.
    assert.deepEqual({ ...h.app.ledger.get() }, before.ledger, 'reconciliation must not touch the ledger');
    assert.equal(h.app.store.positions.all(h.app.spec.strategyId).length, before.positions);
    assert.equal(h.app.store.orders.all().length, before.orders);
    assert.equal(h.app.store.log.recent(1000).length, before.logs, 'reconciliation must not write log entries');
    h.close();
  });

  it('flags a ledger corrupted behind its back', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();

    const ledger = h.app.ledger.get();
    h.app.store.ledger.save({ ...ledger, cashCents: ledger.cashCents + 5000 });

    const report = await h.app.reconciliation.reconcile();
    assert.equal(report.ok, false);
    assert.ok(report.discrepancies.some((d) => d.area === 'LEDGER' && d.severity === 'CRITICAL'));
    h.close();
  });

  it('does not treat a larger broker position as a discrepancy', async () => {
    // The account is shared: other strategies or manual trades may hold more.
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();
    const position = h.app.store.positions.open(h.app.spec.strategyId)[0]!;

    h.app.store.positions.save({ ...position, quantity: position.quantity / 4 });

    const report = await h.app.reconciliation.reconcile();
    assert.ok(
      !report.discrepancies.some((d) => d.area === 'POSITIONS'),
      'the broker holding MORE than the strategy claims is normal on a shared account',
    );
    h.close();
  });
});

/* -------------------------------------------------------------- readiness --- */

describe('readiness', () => {
  it('reports NOT READY without credentials, and submits no orders', async () => {
    const h = createHarness();
    const submitsBefore = h.broker.submitCount;

    const report = await h.app.readiness.run();

    assert.equal(report.overall, 'FAIL');
    assert.equal(report.liveDataConfigured, false);
    assert.equal(h.broker.submitCount, submitsBefore, 'readiness must never submit an order');

    const credentials = report.checks.find((c) => c.id === 'credentials')!;
    assert.equal(credentials.status, 'FAIL');
    assert.match(credentials.detail, /ABSENT/);
    assert.ok(credentials.remedy);
    h.close();
  });

  it('covers every required gate', async () => {
    const h = createHarness();
    const report = await h.app.readiness.run();
    const ids = report.checks.map((c) => c.id);

    for (const required of [
      'credentials', 'x-reachable', 'tiingo-reachable', 'alpaca-paper-reachable',
      'market-status', 'ledger-reconciled', 'kill-switch', 'migrations',
      'clean-state', 'banner-accurate',
    ]) {
      assert.ok(ids.includes(required), `readiness is missing the ${required} gate`);
    }
    h.close();
  });

  it('proves the kill-switch interlock without engaging it', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();

    const runStateBefore = h.app.health.state().runState;
    const report = await h.app.readiness.run();
    const check = report.checks.find((c) => c.id === 'kill-switch')!;

    assert.equal(check.status, 'PASS', check.detail);
    assert.match(check.detail, /not touched/);
    assert.equal(h.app.health.state().runState, runStateBefore, 'the dry-run must not change the run state');
    assert.equal(h.app.health.state().killed, false);
    h.close();
  });

  it('fails when the strategy state is corrupt', async () => {
    const h = createHarness();
    const ledger = h.app.ledger.get();
    h.app.store.ledger.save({ ...ledger, reservedCents: ledger.cashCents + 1000 });

    const report = await h.app.readiness.run();
    const check = report.checks.find((c) => c.id === 'clean-state')!;
    assert.equal(check.status, 'FAIL');
    assert.equal(report.overall, 'FAIL');
    h.close();
  });

  it('warns rather than passing when an incident is unresolved', async () => {
    const h = createHarness();
    h.app.health.pause('STALE_MARKET_DATA', 'injected');

    const report = await h.app.readiness.run();
    const check = report.checks.find((c) => c.id === 'clean-state')!;
    assert.equal(check.status, 'WARN');
    assert.match(check.detail, /unresolved incident|PAUSED/);
    h.close();
  });

  it('verifies the banner agrees with the credential state', async () => {
    const h = createHarness();
    const report = await h.app.readiness.run();
    const check = report.checks.find((c) => c.id === 'banner-accurate')!;

    assert.equal(check.status, 'PASS');
    assert.match(check.detail, /FIXTURE/);
    h.close();
  });

  it('does not claim the ledger is fine when the broker is unreachable', async () => {
    const h = createHarness();
    h.broker.setFailure(new BrokerError('down', 'UNAVAILABLE', true));

    const report = await h.app.readiness.run();
    const check = report.checks.find((c) => c.id === 'ledger-reconciled')!;
    assert.notEqual(check.status, 'PASS', 'an unreachable broker cannot yield a clean reconciliation PASS');
    h.close();
  });
});

/* ----------------------------------------------------------------- audit --- */

describe('signal audit', () => {
  it('assembles the full evidential record for a traded signal', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();

    const signal = h.app.store.signals.recent(5).find((s) => s.ticker === 'NVDA')!;
    const view = h.app.audit.audit(signal.signalId)!;

    assert.ok(view, 'the audit view should exist');
    assert.equal(view.sources.length, 2, 'both source posts must appear');
    for (const src of view.sources) {
      assert.ok(src.handle);
      assert.ok(src.sourceTier);
      assert.ok(src.text.length > 0);
      assert.ok(src.resolution, 'each source must carry its entity resolution');
      assert.ok(src.resolution.confidence > 0);
    }

    // Every dimension the spec requires, with its point contribution.
    const names = view.components.map((c) => c.name);
    for (const dimension of [
      'sentiment', 'materiality', 'novelty', 'credibility',
      'engagementVelocity', 'crossSourceConfirmation', 'priceConfirmation', 'recency',
    ]) {
      assert.ok(names.includes(dimension), `audit is missing ${dimension}`);
    }

    assert.equal(typeof view.resolution.minConfidence, 'number');
    assert.equal(view.resolution.passesThreshold, true);
    assert.ok(view.priceConfirmation, 'price confirmation detail should be present');
    assert.equal(view.signal.score, signal.score);

    // Why it DID become a proposal.
    assert.equal(view.outcome.disposition, 'PROPOSED');
    assert.ok(view.outcome.proposal, 'the proposal must be linked');
    assert.ok(view.outcome.riskDecision, 'the risk decision must be linked');
    assert.ok(view.outcome.orders.length > 0, 'the order must be linked');
    assert.ok(view.outcome.position, 'the position must be linked');
    assert.ok(view.outcome.narrative.length >= 4, 'the narrative should walk the whole chain');
    h.close();
  });

  it('explains why a signal did NOT become a proposal', async () => {
    // Noise produces weak-or-no signals; whatever survives must be explained.
    const h = createHarness({ posts: [...noisePosts(), ...POSTS()] });
    await h.app.runner.runCycle();

    // Second cycle on the same stale evidence: novelty decays, so the repeat
    // signal is below threshold and must say so.
    h.clock.advanceHours(3);
    h.social.setPosts([]);
    await h.app.runner.runCycle();

    const signals = h.app.store.signals.all();
    assert.ok(signals.length >= 1);

    for (const signal of signals) {
      const view = h.app.audit.audit(signal.signalId)!;
      assert.notEqual(view.outcome.disposition, 'NO_RECORD', `${signal.ticker} has no disposition`);
      assert.ok(view.outcome.detail.length > 15, 'the disposition must be explained in words');
    }

    const blocked = signals
      .map((s) => h.app.audit.audit(s.signalId)!)
      .find((v) => v.outcome.disposition !== 'PROPOSED');
    if (blocked) {
      assert.ok(
        ['BELOW_SIGNAL_THRESHOLD', 'RISK_REJECTED', 'NOT_LONG', 'NOT_SIZEABLE', 'NO_MARKET_PRICE', 'STRATEGY_RISK_BREACH']
          .includes(blocked.outcome.disposition),
        `unexpected disposition ${blocked.outcome.disposition}`,
      );
    }
    h.close();
  });

  it('returns null for an unknown signal rather than throwing', () => {
    const h = createHarness();
    assert.equal(h.app.audit.audit('sig_does_not_exist'), null);
    h.close();
  });
});

/* --------------------------------------------------------- observability --- */

describe('observability payload', () => {
  it('reports every field the health panel needs', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();

    const o = buildObservability(h.app);

    assert.equal(o.providers.x, 'FIXTURE');
    assert.equal(o.providers.marketData, 'FIXTURE');
    assert.equal(o.providers.broker, 'SIMULATED');
    assert.equal(o.providers.mode, 'PAPER');
    assert.ok(o.providers.ids.social && o.providers.ids.marketData && o.providers.ids.broker);

    assert.ok(o.process.lastXIngestAt, 'a successful ingest must be timestamped');
    assert.ok(o.process.lastMarketDataRefreshAt, 'a successful price refresh must be timestamped');
    assert.equal(o.process.consecutiveFailures.social, 0);

    assert.ok(o.stored.lastStoredEventAt);
    assert.ok(o.stored.storedEventsLast24h >= 2);
    assert.ok(o.stored.lastSignalAt);

    assert.ok(o.ledger.equity.startsWith('$'));
    assert.equal(o.ledger.integrityOk, true);

    assert.equal(o.exposure.openPositions, 1);
    assert.equal(o.exposure.maxPositions, 5);

    assert.equal(o.risk.breached, false);
    assert.equal(o.strategy.runState, 'RUNNING');
    assert.equal(o.killSwitch.engaged, false);
    h.close();
  });

  it('surfaces provider failures and the kill state', async () => {
    const h = createHarness({ posts: POSTS() });
    h.broker.setFailure(new BrokerError('down', 'UNAVAILABLE', true));
    await h.app.runner.runCycle();

    const failing = buildObservability(h.app);
    assert.ok(failing.process.consecutiveFailures.broker > 0, 'broker failures must be visible');
    assert.ok(failing.process.lastFailureDetail.broker, 'the failure reason must be visible');

    h.broker.setFailure(null);
    h.app.health.kill('operator stop', true);
    const killed = buildObservability(h.app);

    assert.equal(killed.killSwitch.engaged, true);
    assert.equal(killed.killSwitch.liquidateOnKill, true);
    assert.equal(killed.strategy.runState, 'KILLED');
    assert.ok(killed.killSwitch.openIncidents.length > 0);
    h.close();
  });

  it('never leaks a credential', async () => {
    const h = createHarness({ posts: POSTS() });
    await h.app.runner.runCycle();
    const serialised = JSON.stringify(buildObservability(h.app));

    for (const forbidden of ['bearer', 'secret', 'apiKey', 'api_key', 'token', 'password']) {
      assert.ok(
        !serialised.toLowerCase().includes(forbidden.toLowerCase()),
        `observability payload contained "${forbidden}"`,
      );
    }
    h.close();
  });
});
