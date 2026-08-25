/**
 * Risk limits, capital accounting and exit rules.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dollarsToCents, formatUsd, quantityForCents } from '../../src/core/index.js';
import { X_SIGNAL_V1 } from '../../src/config/strategyRegistry.js';
import type { Position, Quote, RiskCheckId } from '../../src/domain/types.js';
import { ExitEngine } from '../../src/pipeline/execution/ExitEngine.js';
import { bullishTier1Post, corroboratingTier2Post, createHarness, TEST_NOW } from '../fixtures/harness.js';

const NOW_MS = new Date(TEST_NOW).getTime();

/* ------------------------------------------------------------ risk limits */

describe('risk engine', () => {
  /** Runs one cycle, then evaluates a fresh proposal under a modified world. */
  async function setup() {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();
    return h;
  }

  function failedChecks(h: Awaited<ReturnType<typeof setup>>): RiskCheckId[] {
    const decisions = h.app.store.risk.recent(20);
    return decisions.flatMap((d) => d.failedChecks);
  }

  it('applies the v1 limits from the strategy version, not from code constants', () => {
    const limits = X_SIGNAL_V1.riskLimits;
    assert.equal(limits.startingCapitalCents, dollarsToCents(50));
    assert.equal(limits.maxPositionPctOfEquity, 20);
    assert.equal(limits.maxConcurrentPositions, 5);
    assert.equal(limits.maxDailyLossPct, 4);
    assert.equal(limits.maxDrawdownPct, 12);
    assert.equal(limits.allowLeverage, false);
    assert.equal(limits.allowMargin, false);
    assert.equal(limits.allowOptions, false);
    assert.equal(limits.allowShorting, false);
  });

  it('never permits a position larger than the position cap', async () => {
    const h = await setup();
    const decision = h.app.store.risk.recent(1)[0]!;
    const ledger = h.app.ledger.get();
    const cap = Math.floor((ledger.equityCents * X_SIGNAL_V1.riskLimits.maxPositionPctOfEquity) / 100);
    assert.ok(
      decision.permittedCapitalCents <= cap,
      `permitted ${formatUsd(decision.permittedCapitalCents)} exceeds the cap ${formatUsd(cap)}`,
    );
    h.close();
  });

  it('blocks a second position in the same ticker', async () => {
    const h = await setup();
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 1);

    // A fresh, equally strong story on the same name.
    h.clock.advanceHours(1);
    h.social.setPosts([
      bullishTier1Post({ postId: 'nvda-2', text: 'NVIDIA raises full-year guidance again to $36.0B on record demand. $NVDA' }),
      corroboratingTier2Post({ postId: 'nvda-3', text: 'Nvidia lifts full-year guidance to $36.0 billion, ahead of the $33.0 billion consensus. $NVDA' }),
    ]);
    await h.app.runner.runCycle();

    assert.ok(failedChecks(h).includes('DUPLICATE_EXPOSURE'), 'duplicate exposure must be blocked');
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 1, 'still exactly one NVDA position');
    h.close();
  });

  it('refuses to trade on stale market data', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    h.marketData.setQuoteAgeMinutes(120); // beyond the 30-minute limit
    await h.app.runner.runCycle();

    assert.ok(failedChecks(h).includes('MARKET_DATA_FRESHNESS'));
    assert.equal(h.app.store.positions.open(h.app.spec.strategyId).length, 0);
    h.close();
  });

  it('refuses to trade when the market is closed', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    h.marketData.setMarketOpen(false);
    h.broker.setMarketOpen(false);
    await h.app.runner.runCycle();

    assert.ok(failedChecks(h).includes('MARKET_HOURS'));
    assert.equal(h.app.store.orders.all().length, 0, 'no order may be submitted with the market closed');
    h.close();
  });

  it('never even looks at a security outside the permitted universe', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    const nvda = h.app.universe.byTickerOrNull('NVDA')!;
    h.app.universe.add({ ...nvda, universeSources: [] });
    const report = await h.app.runner.runCycle();

    // The allowlist gates ingestion and filtering, so an out-of-universe name
    // never reaches the signal engine at all.
    assert.equal(report.signalsGenerated, 0);
    assert.equal(report.proposalsCreated, 0);
    assert.equal(h.app.store.orders.all().length, 0);
    h.close();
  });

  it('re-checks universe membership at risk time, in case it changed since the signal', async () => {
    const h = await setup();
    const proposal = h.app.store.proposals.recent(1)[0]!;
    const signal = h.app.store.signals.byId(proposal.signalId)!;

    // The security leaves the universe between signal and order.
    const nvda = h.app.universe.byTickerOrNull('NVDA')!;
    h.app.universe.add({ ...nvda, universeSources: [] });

    const decision = h.app.riskEngine.evaluate(proposal, {
      strategy: h.app.store.strategies.byId(h.app.spec.strategyId)!,
      signal,
      marketStatus: await h.marketData.getMarketStatus(),
      marketDataAgeMinutes: 0,
      marketDataStale: false,
      openPositions: h.app.store.positions.open(h.app.spec.strategyId),
      providersHealthy: true,
      providerHealthDetail: 'healthy',
      brokerReportsMarketOpen: true,
    });

    assert.equal(decision.approved, false);
    assert.ok(decision.failedChecks.includes('UNIVERSE_MEMBERSHIP'));
    assert.equal(decision.permittedCapitalCents, 0, 'a rejected proposal must permit zero capital');
    h.close();
  });

  it('trips the daily-loss circuit breaker before the drawdown one', async () => {
    const h = await setup();
    // A 50% loss on a 20% position is ~9% of equity: past the 4% daily limit
    // but still inside the 12% drawdown limit. The tighter limit must bind.
    h.marketData.setPrice('NVDA', 120 * 0.5);
    h.clock.advanceMinutes(30);
    h.social.setPosts([]);
    await h.app.runner.runCycle();

    const breach = h.app.riskEngine.strategyBreach(X_SIGNAL_V1.riskLimits);
    assert.equal(breach.breached, true);
    assert.ok(breach.reasons.some((r) => r.includes('Daily loss')), JSON.stringify(breach.reasons));
    assert.ok(h.app.ledger.drawdownPct() < X_SIGNAL_V1.riskLimits.maxDrawdownPct);
    h.close();
  });

  it('trips the drawdown breaker on a large enough loss', async () => {
    const h = await setup();
    h.marketData.setPrice('NVDA', 120 * 0.02);
    h.clock.advanceMinutes(30);
    h.social.setPosts([]);
    await h.app.runner.runCycle();

    const breach = h.app.riskEngine.strategyBreach(X_SIGNAL_V1.riskLimits);
    assert.equal(breach.breached, true);
    assert.ok(
      breach.reasons.some((r) => r.includes('Drawdown')),
      `expected a drawdown breach, got ${JSON.stringify(breach.reasons)}`,
    );
    h.close();
  });

  it('stops opening new positions once a strategy limit is breached', async () => {
    const h = await setup();
    h.marketData.setPrice('NVDA', 120 * 0.5);
    h.clock.advanceMinutes(30);
    h.social.setPosts([]);
    await h.app.runner.runCycle();

    // A fresh, strong story on a DIFFERENT name must still be refused.
    h.clock.advanceMinutes(30);
    h.social.setPosts([
      bullishTier1Post({ postId: 'pfe-1', handle: 'pfizer', text: 'Pfizer raises full-year guidance to $62.0B after FDA approval of its lead therapy. $PFE' }),
      corroboratingTier2Post({ postId: 'pfe-2', handle: 'reuters', text: 'Pfizer lifts full-year guidance to $62.0 billion following FDA approval, ahead of consensus. $PFE' }),
    ]);
    const report = await h.app.runner.runCycle();

    assert.equal(report.proposalsCreated, 0, 'no new proposals may be created while a limit is breached');
    assert.equal(report.ordersSubmitted, 0);
    h.close();
  });

  it('reports every check it ran, passed or failed', async () => {
    const h = await setup();
    const decision = h.app.store.risk.recent(1)[0]!;
    const checkIds = decision.checks.map((c) => c.check);
    for (const expected of [
      'KILL_SWITCH', 'UNIVERSE_MEMBERSHIP', 'DIRECTION_ALLOWED', 'SIGNAL_THRESHOLD',
      'MARKET_DATA_FRESHNESS', 'MARKET_HOURS', 'DUPLICATE_EXPOSURE', 'MAX_CONCURRENT_POSITIONS',
      'MAX_POSITION_SIZE', 'AVAILABLE_CASH', 'DAILY_LOSS_LIMIT', 'MAX_DRAWDOWN', 'LEDGER_INTEGRITY',
    ]) {
      assert.ok(checkIds.includes(expected as RiskCheckId), `risk must report the ${expected} check`);
    }
    for (const check of decision.checks) {
      assert.ok(check.detail.length > 5, `${check.check} must explain itself`);
    }
    h.close();
  });

  it('overrides the signal engine: a maximal signal with a failing check does not trade', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    h.app.health.kill('Test kill', false);
    await h.app.runner.runCycle();

    assert.equal(h.app.store.orders.all().length, 0, 'a killed strategy submits nothing');
    h.close();
  });
});

/* ------------------------------------------------------- capital accounting */

describe('capital ledger', () => {
  it('starts at exactly the $50 allocation', () => {
    const h = createHarness();
    const ledger = h.app.ledger.get();
    assert.equal(ledger.startingCapitalCents, 5000);
    assert.equal(ledger.cashCents, 5000);
    assert.equal(ledger.equityCents, 5000);
    assert.equal(formatUsd(ledger.equityCents), '$50.00');
    h.close();
  });

  it('is separate from the broker account balance', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    const account = await h.broker.getAccount();
    assert.ok(account.cash >= 100_000, 'the simulated broker account holds far more than $50');

    await h.app.runner.runCycle();
    const ledger = h.app.ledger.get();
    assert.ok(
      ledger.equityCents < 20_000,
      'the strategy ledger must stay near its own $50 allocation, not the account balance',
    );
    h.close();
  });

  it('cannot spend more than its own allocation even when the account is rich', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();
    const ledger = h.app.ledger.get();
    assert.ok(ledger.cashCents >= 0, 'cash must never go negative');
    assert.ok(
      ledger.cashCents + ledger.positionsValueCents <= 5000 * 1.5,
      'the strategy cannot deploy more than its allocation',
    );
    h.close();
  });

  it('reserves capital so two proposals cannot spend the same dollar', () => {
    const h = createHarness();
    const before = h.app.ledger.availableCents();
    assert.equal(h.app.ledger.reserve(2000, 'p1'), true);
    assert.equal(h.app.ledger.availableCents(), before - 2000);
    assert.equal(h.app.ledger.reserve(4000, 'p2'), false, 'the second reservation must be refused');
    h.app.ledger.releaseReservation(2000, 'p1');
    assert.equal(h.app.ledger.availableCents(), before);
    h.close();
  });

  it('reconciles cash against the append-only entry log', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();
    const integrity = h.app.ledger.verifyIntegrity();
    assert.equal(integrity.ok, true, integrity.detail);
    assert.equal(integrity.differenceCents, 0);
    h.close();
  });

  it('detects a corrupted ledger', () => {
    const h = createHarness();
    // Simulate a corrupt write that the entry log cannot explain.
    const ledger = h.app.ledger.get();
    h.app.store.ledger.save({ ...ledger, cashCents: ledger.cashCents + 9999 });
    const integrity = h.app.ledger.verifyIntegrity();
    assert.equal(integrity.ok, false);
    assert.equal(integrity.differenceCents, 9999);
    h.close();
  });

  it('fully retires a reservation once the order is filled', async () => {
    // Regression: releasing only the UNSPENT part of a reservation left the
    // spent part committed forever, so `reserved` climbed above `cash` over a
    // long run and the strategy eventually refused to trade.
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();

    const ledger = h.app.ledger.get();
    assert.equal(ledger.reservedCents, 0, 'a filled entry must leave nothing reserved');
    assert.ok(ledger.reservedCents <= ledger.cashCents, 'reserved may never exceed cash');
    assert.equal(h.app.health.verifyStateIntegrity().ok, true);

    const proposal = h.app.store.proposals.recent(1)[0]!;
    assert.equal(h.app.ledger.reservedFor(proposal.proposalId), 0);
    h.close();
  });

  it('keeps reserved within cash across many trading cycles', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    for (let i = 0; i < 12; i += 1) {
      await h.app.runner.runCycle();
      const ledger = h.app.ledger.get();
      assert.ok(
        ledger.reservedCents <= ledger.cashCents,
        `cycle ${i}: reserved ${ledger.reservedCents} exceeded cash ${ledger.cashCents}`,
      );
      assert.equal(h.app.health.verifyStateIntegrity().ok, true, `cycle ${i}: state integrity broke`);
      h.clock.advanceHours(4);
      h.marketData.setPrice('NVDA', 120 * (1 + (i % 5) * 0.03));
      h.social.setPosts([]);
    }
    h.close();
  });

  it('computes equity, drawdown and daily loss from the ledger', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();

    h.marketData.setPrice('NVDA', 120 * 0.5);
    h.clock.advanceMinutes(30);
    h.app.ledger.mark(new Map([['NVDA', 60]]));

    assert.ok(h.app.ledger.drawdownPct() > 0, 'a 50% position loss must show as drawdown');
    assert.ok(h.app.ledger.totalReturnPct() < 0);
    h.close();
  });

  it('keeps money arithmetic exact in integer cents', () => {
    assert.equal(dollarsToCents(50), 5000);
    assert.equal(dollarsToCents(0.1) + dollarsToCents(0.2), dollarsToCents(0.3));
    assert.equal(formatUsd(5197), '$51.97');
    assert.equal(formatUsd(-1234), '-$12.34');
    // Fractional sizing must never round UP into more capital than allowed.
    const qty = quantityForCents(1000, 120);
    assert.ok(qty * 120 * 100 <= 1000);
  });
});

/* ------------------------------------------------------------- exit rules */

describe('exit rules', () => {
  function position(over: Partial<Position> = {}): Position {
    return {
      positionId: 'pos-1',
      strategyId: 'x-signal-v1',
      strategyVersion: '1.0.0',
      securityId: 'sec_NVDA',
      ticker: 'NVDA',
      direction: 'LONG',
      status: 'OPEN',
      quantity: 0.08,
      entryPrice: 120,
      entryCostCents: 960,
      openedAt: new Date(NOW_MS - 3_600_000).toISOString(),
      entryOrderId: 'ord-1',
      entrySignalId: 'sig-1',
      entryProposalId: 'prop-1',
      entrySignalScore: 80,
      invalidationCondition: {
        description: 'test',
        signalReversalBelow: 0,
        stopLossPct: 8,
        thesisExpiryHours: 48,
        maxHoldingHours: 72,
      },
      highWaterPrice: 120,
      lastMarkPrice: 120,
      lastMarkAt: new Date(NOW_MS).toISOString(),
      unrealisedPnlCents: 0,
      exitOrderId: null,
      exitPrice: null,
      exitProceedsCents: null,
      closedAt: null,
      exitReason: null,
      exitNote: null,
      realisedPnlCents: null,
      feesCents: 0,
      mode: 'PAPER',
      ...over,
    };
  }

  function quote(price: number): Map<string, Quote> {
    return new Map([['NVDA', { ticker: 'NVDA', price, asOf: new Date(NOW_MS).toISOString(), ageMinutes: 0, stale: false }]]);
  }

  function engine() {
    const h = createHarness();
    const e = new ExitEngine(h.app.store, X_SIGNAL_V1.exitRules, h.clock, h.app.logger, 'x-signal-v1');
    return { h, e };
  }

  it('holds when no rule triggers', () => {
    const { h, e } = engine();
    const decision = e.evaluate(position(), {
      quotes: quote(121), strategyRiskShutdown: false, strategyRiskDetail: '', killSwitchLiquidate: false,
    });
    assert.equal(decision.shouldExit, false);
    assert.ok(decision.evaluations.length >= 8, 'a hold must be as explainable as an exit');
    h.close();
  });

  it('fires the stop loss', () => {
    const { h, e } = engine();
    const decision = e.evaluate(position(), {
      quotes: quote(120 * 0.9), strategyRiskShutdown: false, strategyRiskDetail: '', killSwitchLiquidate: false,
    });
    assert.equal(decision.shouldExit, true);
    assert.equal(decision.reason, 'STOP_LOSS');
    h.close();
  });

  it('fires the take profit', () => {
    const { h, e } = engine();
    const decision = e.evaluate(position(), {
      quotes: quote(120 * 1.15), strategyRiskShutdown: false, strategyRiskDetail: '', killSwitchLiquidate: false,
    });
    assert.equal(decision.shouldExit, true);
    assert.equal(decision.reason, 'TAKE_PROFIT');
    h.close();
  });

  it('only arms the trailing stop once the position has been in profit', () => {
    const { h, e } = engine();
    const neverProfitable = e.evaluate(position({ highWaterPrice: 120 }), {
      quotes: quote(120 * 0.97), strategyRiskShutdown: false, strategyRiskDetail: '', killSwitchLiquidate: false,
    });
    assert.equal(neverProfitable.shouldExit, false, 'the trailing stop must not fire on entry noise');

    const gaveBackGains = e.evaluate(position({ highWaterPrice: 132 }), {
      quotes: quote(122), strategyRiskShutdown: false, strategyRiskDetail: '', killSwitchLiquidate: false,
    });
    assert.equal(gaveBackGains.shouldExit, true);
    assert.equal(gaveBackGains.reason, 'TRAILING_STOP');
    h.close();
  });

  it('fires on the maximum holding period', () => {
    const { h, e } = engine();
    const decision = e.evaluate(position({ openedAt: new Date(NOW_MS - 80 * 3_600_000).toISOString() }), {
      quotes: quote(121), strategyRiskShutdown: false, strategyRiskDetail: '', killSwitchLiquidate: false,
    });
    assert.equal(decision.shouldExit, true);
    // A 80h-old position hits thesis expiry (48h) before the 72h max hold.
    assert.ok(decision.reason === 'THESIS_EXPIRY' || decision.reason === 'MAX_HOLDING_PERIOD');
    h.close();
  });

  it('prioritises capital preservation over thesis rules', () => {
    const { h, e } = engine();
    // Both the stop loss and the holding period are breached; the stop wins.
    const decision = e.evaluate(position({ openedAt: new Date(NOW_MS - 80 * 3_600_000).toISOString() }), {
      quotes: quote(120 * 0.8), strategyRiskShutdown: false, strategyRiskDetail: '', killSwitchLiquidate: false,
    });
    assert.equal(decision.reason, 'STOP_LOSS');
    h.close();
  });

  it('exits on a strategy-level risk shutdown', () => {
    const { h, e } = engine();
    const decision = e.evaluate(position(), {
      quotes: quote(121), strategyRiskShutdown: true, strategyRiskDetail: 'Daily loss 5% >= limit 4%', killSwitchLiquidate: false,
    });
    assert.equal(decision.shouldExit, true);
    assert.equal(decision.reason, 'STRATEGY_RISK_SHUTDOWN');
    assert.ok(decision.note.includes('Daily loss'));
    h.close();
  });

  it('liquidates only when kill-switch liquidation was explicitly selected', () => {
    const { h, e } = engine();
    const withoutLiquidation = e.evaluate(position(), {
      quotes: quote(121), strategyRiskShutdown: false, strategyRiskDetail: '', killSwitchLiquidate: false,
    });
    assert.equal(withoutLiquidation.shouldExit, false, 'killing the bot must not liquidate by default');

    const withLiquidation = e.evaluate(position(), {
      quotes: quote(121), strategyRiskShutdown: false, strategyRiskDetail: '', killSwitchLiquidate: true,
    });
    assert.equal(withLiquidation.reason, 'KILL_SWITCH_LIQUIDATION');
    h.close();
  });

  it('exits on signal reversal, but only on a signal generated after entry', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();
    const open = h.app.store.positions.open(h.app.spec.strategyId);
    assert.equal(open.length, 1);

    // A bearish story on the same name, an hour later.
    h.clock.advanceHours(1);
    h.social.setPosts([
      {
        postId: 'nvda-bear-1',
        handle: 'sec_news',
        text:
          'The SEC has opened a formal investigation into NVIDIA over accounting irregularities ' +
          'covering $2.1B of recognised revenue. $NVDA',
        minutesAgo: 5,
        likes: 9000,
        reposts: 4000,
        baselineEngagement: 400,
      },
      {
        postId: 'nvda-bear-2',
        handle: 'reuters',
        text:
          'Nvidia faces an SEC probe into accounting irregularities covering $2.1 billion of revenue, ' +
          'according to a filing. $NVDA',
        minutesAgo: 4,
        likes: 4000,
        reposts: 2000,
        baselineEngagement: 900,
      },
    ]);

    const report = await h.app.runner.runCycle();
    const reversal = report.exitsTriggered.find((e) => e.reason === 'SIGNAL_REVERSAL');
    assert.ok(reversal, `expected a signal-reversal exit, got ${JSON.stringify(report.exitsTriggered)}`);

    const closed = h.app.store.positions.closed(h.app.spec.strategyId);
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.exitReason, 'SIGNAL_REVERSAL');
    assert.ok(closed[0]!.exitNote!.length > 0, 'the exit reason must be recorded with detail');
    h.close();
  });
});
