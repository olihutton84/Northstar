/**
 * Day-one trading controls.
 *
 * Everything here answers one question: can the bot act more times, or on older
 * evidence, than it is allowed to? Each control is tested through the real
 * pipeline rather than in isolation, because the failure mode that matters is a
 * control that exists but is not reached.
 *
 * The most important test in this file asserts that a quiet day produces zero
 * trades. There is no minimum, no quota and no floor anywhere in the bot, and
 * that has to stay true.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FixedClock, NullLogger } from '../../src/core/index.js';
import { DEFAULT_OPERATIONS } from '../../src/config/operations.js';
import { SessionWatch, phaseFor } from '../../src/runtime/SessionWatch.js';
import {
  bullishTier1Post,
  corroboratingTier2Post,
  createHarness,
  noisePosts,
} from '../fixtures/harness.js';

/* --------------------------------------------------- event-driven trading */

describe('event-driven trading', () => {
  it('does not re-score a security when nothing new arrived', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });

    const first = await h.app.runner.runCycle();
    assert.equal(first.signalsGenerated, 1);
    assert.equal(first.candidatesWithoutNewEvidence, 0);

    // Time passes; the same posts are still in the window; nothing new arrives.
    h.clock.advanceMinutes(10);
    const second = await h.app.runner.runCycle();

    assert.equal(second.ingested, 0, 'the cursor means nothing new comes back');
    assert.equal(second.signalsGenerated, 0, 'no new event, no new signal');
    assert.equal(second.candidates, 1, 'the candidate still exists…');
    assert.equal(second.candidatesWithoutNewEvidence, 1, '…and was deliberately skipped');
    h.close();
  });

  it('never turns the passage of time alone into a trade', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();
    const ordersAfterFirst = h.app.store.orders.all().length;

    // Six hours of scans on unchanged evidence.
    for (let i = 0; i < 12; i += 1) {
      h.clock.advanceMinutes(30);
      await h.app.runner.runCycle();
    }

    assert.equal(h.app.store.orders.all().length, ordersAfterFirst, 'no order came from waiting');
    h.close();
  });

  it('scores again as soon as genuinely new evidence lands', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();

    h.clock.advanceMinutes(20);
    h.social.addPosts([
      corroboratingTier2Post({
        postId: 'post-nvda-guidance-3',
        handle: 'bloomberg',
        displayName: 'Bloomberg',
        text: 'Nvidia confirms the raised $32.5 billion outlook in an 8-K filing. $NVDA',
        minutesAgo: 1,
      }),
    ]);

    const report = await h.app.runner.runCycle();
    assert.ok(report.ingested > 0, 'the new post was ingested');
    assert.equal(report.signalsGenerated, 1, 'new evidence produces a new signal');
    h.close();
  });
});

/* ---------------------------------------------------- same-ticker cooldown */

describe('same-ticker cooldown', () => {
  it('rejects a second entry in the same name inside the cooldown', async () => {
    // Duplicate exposure would also block a second NVDA entry, so the position
    // is closed first: this isolates the cooldown as the reason.
    const h = createHarness({
      posts: [bullishTier1Post(), corroboratingTier2Post()],
      operations: { sameTickerCooldownMinutes: 30 },
    });
    await h.app.runner.runCycle();

    const position = h.app.store.positions.open(h.app.spec.strategyId)[0];
    assert.ok(position, 'the first cycle opened a position');

    await h.app.orderRouter.submitExit(position!, 'MANUAL', 'test close');
    await h.app.positionManager.reconcile();
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 0);

    // A fresh story on the same name, 10 minutes later — inside the cooldown.
    h.clock.advanceMinutes(10);
    h.social.setPosts([
      bullishTier1Post({ postId: 'nvda-b1', text: 'NVIDIA raises full-year guidance again to $36.0B on record demand. $NVDA' }),
      corroboratingTier2Post({ postId: 'nvda-b2', text: 'Nvidia lifts full-year guidance to $36.0 billion, ahead of the $33.0 billion consensus. $NVDA' }),
    ]);
    await h.app.runner.runCycle();

    const failed = h.app.store.risk.recent(5).flatMap((d) => d.failedChecks);
    assert.ok(failed.includes('SAME_TICKER_COOLDOWN'), `expected the cooldown to hold, got ${failed.join(', ')}`);
    h.close();
  });

  it('allows the entry once the cooldown has elapsed', async () => {
    const h = createHarness({
      posts: [bullishTier1Post(), corroboratingTier2Post()],
      operations: { sameTickerCooldownMinutes: 30 },
    });
    await h.app.runner.runCycle();

    const position = h.app.store.positions.open(h.app.spec.strategyId)[0]!;
    await h.app.orderRouter.submitExit(position, 'MANUAL', 'test close');
    await h.app.positionManager.reconcile();

    h.clock.advanceMinutes(45);
    h.social.setPosts([
      bullishTier1Post({ postId: 'nvda-c1', text: 'NVIDIA raises full-year guidance again to $36.0B on record demand. $NVDA' }),
      corroboratingTier2Post({ postId: 'nvda-c2', text: 'Nvidia lifts full-year guidance to $36.0 billion, ahead of the $33.0 billion consensus. $NVDA' }),
    ]);
    await h.app.runner.runCycle();

    const latest = h.app.store.risk.recent(1)[0];
    assert.ok(latest, 'a fresh risk decision was made');
    assert.ok(
      !latest!.failedChecks.includes('SAME_TICKER_COOLDOWN'),
      'the cooldown must not hold 45 minutes after the last entry',
    );
    h.close();
  });

  it('is an operational control, so v1 risk limits stay untouched', async () => {
    const h = createHarness({ operations: { sameTickerCooldownMinutes: 5 } });
    const limits = h.app.spec.riskLimits;
    // The cooldown lives in OperationsConfig; if it had leaked into RiskLimits
    // every cadence change would republish the strategy version.
    assert.equal('sameTickerCooldownMinutes' in limits, false);
    assert.equal('signalTtlMinutes' in limits, false);
    h.close();
  });
});

/* ------------------------------------------------------------ signal TTL */

describe('signal expiry', () => {
  it('refuses to submit an order on a signal past its TTL', async () => {
    // The signal TTL is set below the proposal TTL so this test isolates the
    // evidence-age gate. With the defaults the proposal expires first, which
    // is also a correct refusal — the signal check is the deeper interlock,
    // covering the case where the terms are still live but the story is not.
    const h = createHarness({
      posts: [bullishTier1Post(), corroboratingTier2Post()],
      operations: { signalTtlMinutes: 2, proposalTtlMinutes: 30 },
    });
    await h.app.runner.runCycle();

    const proposal = h.app.store.proposals.recent(1)[0]!;
    const signal = h.app.store.signals.byId(proposal.signalId)!;
    const decision = h.app.store.risk.recent(1)[0]!;

    // The gap between "signal produced" and "order submitted" is where a stale
    // thesis would otherwise slip through — in LIVE, a human approving late.
    h.clock.advanceMinutes(10);

    const outcome = await h.app.orderRouter.submitEntry(proposal, decision, signal);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'SIGNAL_EXPIRED');
    h.close();
  });

  it('still refuses when the proposal itself has aged out', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();

    const proposal = h.app.store.proposals.recent(1)[0]!;
    const signal = h.app.store.signals.byId(proposal.signalId)!;
    const decision = h.app.store.risk.recent(1)[0]!;

    h.clock.advanceMinutes(DEFAULT_OPERATIONS.proposalTtlMinutes + 5);
    const outcome = await h.app.orderRouter.submitEntry(proposal, decision, signal);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false && outcome.reason, 'EXPIRED');
    h.close();
  });

  it('rejects an over-age signal at the risk gate too', async () => {
    const h = createHarness({
      posts: [bullishTier1Post(), corroboratingTier2Post()],
      operations: { signalTtlMinutes: 1 },
    });
    await h.app.runner.runCycle();

    const proposal = h.app.store.proposals.recent(1)[0]!;
    const signal = h.app.store.signals.byId(proposal.signalId)!;
    const strategy = h.app.store.strategies.byId(h.app.spec.strategyId)!;

    h.clock.advanceMinutes(10);
    const decision = h.app.riskEngine.evaluate(proposal, {
      strategy,
      signal,
      marketStatus: { isOpen: true, asOf: h.clock.nowIso(), nextOpen: null, nextClose: null, reason: 'test' },
      marketDataAgeMinutes: 0,
      marketDataStale: false,
      openPositions: [],
      providersHealthy: true,
      providerHealthDetail: 'healthy',
      brokerReportsMarketOpen: true,
      operational: { sameTickerCooldownMinutes: 30, lastEntryAt: null, signalTtlMinutes: 1 },
    });

    assert.equal(decision.approved, false);
    assert.ok(decision.failedChecks.includes('SIGNAL_FRESHNESS'));
    h.close();
  });
});

/* ------------------------------------------------------- zero-trade day */

describe('day-one trading behaviour', () => {
  it('trades zero times on a day with no material news', async () => {
    const h = createHarness({ posts: noisePosts() });

    for (let i = 0; i < 20; i += 1) {
      await h.app.runner.runCycle();
      h.clock.advanceMinutes(2);
    }

    assert.equal(h.app.store.orders.all().length, 0, 'noise must never produce an order');
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 0);
    // And equity is untouched: no fees, no slippage, no "just to be doing
    // something" entry.
    assert.equal(h.app.ledger.get().equityCents, h.app.spec.riskLimits.startingCapitalCents);
    h.close();
  });

  it('trades zero times on a day with no posts at all', async () => {
    const h = createHarness({ posts: [] });

    for (let i = 0; i < 20; i += 1) {
      await h.app.runner.runCycle();
      h.clock.advanceMinutes(2);
    }

    assert.equal(h.app.store.orders.all().length, 0);
    const funnel = h.app.funnel.report();
    assert.equal(funnel.stages.find((s) => s.stage === 'Entry orders')?.count, 0);
    h.close();
  });

  it('reports a zero-trade day as a complete, correct day', async () => {
    const h = createHarness({ posts: noisePosts() });
    await h.app.runner.runCycle();

    const report = h.app.dailyReport.build();
    assert.equal(report.tradesClosed, 0);
    const rendered = h.app.dailyReport.render(report);
    assert.match(rendered, /No trades today/);
    assert.match(rendered, /Zero trades is a valid outcome/);
    h.close();
  });
});

/* ------------------------------------------------------------- funnel */

describe('funnel diagnosis', () => {
  it('names the stage where a noisy day stopped', async () => {
    const h = createHarness({ posts: noisePosts() });
    await h.app.runner.runCycle();

    const funnel = h.app.funnel.report();
    const stored = funnel.stages.find((s) => s.stage === 'Posts stored (new)')!;
    assert.ok(stored.count > 0, 'noise was still ingested and stored');

    // Whatever stage held, the funnel must name it rather than leave the
    // operator to guess.
    assert.ok(funnel.stalledAt !== null);
    assert.match(funnel.narrative, /reached zero at/);
    h.close();
  });

  it('carries every stage through on a day that trades', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();

    const funnel = h.app.funnel.report();
    const byStage = new Map(funnel.stages.map((s) => [s.stage, s.count]));
    assert.ok((byStage.get('Signals generated') ?? 0) > 0);
    assert.ok((byStage.get('Proposals built') ?? 0) > 0);
    assert.ok((byStage.get('Entry orders') ?? 0) > 0);
    h.close();
  });
});

/* ---------------------------------------------------------- scheduler */

describe('scheduler', () => {
  it('runs a bounded number of X scans and stops', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    // Rebuilding the scheduler is the only way to bound it; the app's own
    // instance is unbounded by design.
    const { Scheduler } = await import('../../src/runtime/Scheduler.js');
    const { PollingPolicy } = await import('../../src/runtime/PollingPolicy.js');
    const fastOps = { ...DEFAULT_OPERATIONS, xScanIntervalSeconds: 1 };
    const events: string[] = [];
    const scheduler = new Scheduler({
      runner: h.app.runner,
      reconciliation: h.app.reconciliation,
      polling: new PollingPolicy(fastOps, h.clock, new NullLogger(), h.app.apiMeter),
      meter: h.app.apiMeter,
      ops: fastOps,
      clock: h.clock,
      logger: new NullLogger(),
      maxScans: 2,
      onEvent: (e) => events.push(e.task),
    });

    await scheduler.start();

    assert.equal(scheduler.status().scans, 2);
    assert.equal(events.filter((e) => e === 'X_SCAN').length, 2);
    // An order was submitted on the first scan, so a reconciliation must have
    // been triggered immediately rather than waiting for its own interval.
    assert.ok(events.includes('RECONCILE'), 'an order event triggers an immediate reconciliation');
    h.close();
  });

  it('runs one of each task on demand', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    const { Scheduler } = await import('../../src/runtime/Scheduler.js');
    const tasks: string[] = [];
    const scheduler = new Scheduler({
      runner: h.app.runner,
      reconciliation: h.app.reconciliation,
      polling: h.app.polling,
      meter: h.app.apiMeter,
      ops: DEFAULT_OPERATIONS,
      clock: h.clock,
      logger: new NullLogger(),
      onEvent: (e) => tasks.push(e.task),
    });

    await scheduler.runOnce();
    assert.deepEqual(tasks, ['X_SCAN', 'POSITION_MONITOR', 'RECONCILE']);
    h.close();
  });

  it('monitors positions without spending an X request', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();

    const fetchesBefore = h.social.fetchCount;
    const monitor = await h.app.runner.monitorPositions();

    assert.equal(h.social.fetchCount, fetchesBefore, 'the position loop must never touch X');
    assert.equal(monitor.openPositions, 1);
    assert.ok(monitor.equityCents > 0);
    h.close();
  });

  it('cannot open a position from the position loop', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });

    // Never ran a full cycle, so there is nothing but unprocessed posts.
    const before = h.app.store.orders.all().length;
    await h.app.runner.monitorPositions();
    assert.equal(h.app.store.orders.all().length, before, 'monitoring is not a trading path');
    h.close();
  });
});

/* ----------------------------------------------------- session watch */

describe('session transitions', () => {
  function watch(clock: FixedClock, hooks: { onOpen?: () => void; onEndOfDay?: (d: string) => void } = {}) {
    return new SessionWatch({
      clock,
      logger: new NullLogger(),
      ops: { ...DEFAULT_OPERATIONS, endOfDayReportDelayMinutes: 10 },
      ...hooks,
    });
  }

  it('recognises pre-market, open and after-hours', () => {
    // 13:00 UTC is 09:00 New York in March.
    assert.equal(phaseFor(new FixedClock('2026-03-10T13:00:00.000Z')), 'PRE_MARKET');
    assert.equal(phaseFor(new FixedClock('2026-03-10T15:00:00.000Z')), 'OPEN');
    assert.equal(phaseFor(new FixedClock('2026-03-10T21:00:00.000Z')), 'AFTER_HOURS');
    assert.equal(phaseFor(new FixedClock('2026-03-08T15:00:00.000Z')), 'CLOSED', 'Sunday');
  });

  it('is safe to start before the open and clears the cache at the bell', async () => {
    const clock = new FixedClock('2026-03-10T13:00:00.000Z');
    let cleared = 0;
    const w = watch(clock, { onOpen: () => { cleared += 1; } });

    assert.equal(w.prime(), 'PRE_MARKET');
    assert.equal(await w.tick(), null, 'still pre-market, nothing to do');
    assert.equal(cleared, 0);

    clock.advanceHours(2); // 09:00 → 11:00 New York
    const transition = await w.tick();
    assert.equal(transition?.to, 'OPEN');
    assert.equal(cleared, 1, 'pre-market marks must not price the first session trade');

    await w.tick();
    assert.equal(cleared, 1, 'the open fires exactly once');
  });

  it('emits the end-of-day report once, after a settling delay', async () => {
    const clock = new FixedClock('2026-03-10T19:30:00.000Z'); // 15:30 New York
    const days: string[] = [];
    const w = watch(clock, { onEndOfDay: (d) => days.push(d) });
    w.prime();

    clock.advanceMinutes(35); // past the 16:00 close
    await w.tick();
    assert.deepEqual(days, [], 'not immediately at the close — late fills land first');

    clock.advanceMinutes(11);
    await w.tick();
    assert.equal(days.length, 1, 'the report is emitted once the delay has passed');

    clock.advanceMinutes(60);
    await w.tick();
    assert.equal(days.length, 1, 'and never twice for the same day');
  });

  it('does not fire a report for a day it never traded through', async () => {
    // Starting the bot at 6pm should not immediately print a report for a
    // session it was not running during.
    const clock = new FixedClock('2026-03-10T22:00:00.000Z');
    const days: string[] = [];
    const w = watch(clock, { onEndOfDay: (d) => days.push(d) });
    w.prime();

    clock.advanceMinutes(30);
    await w.tick();
    assert.deepEqual(days, []);
  });
});
