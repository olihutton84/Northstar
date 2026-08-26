/**
 * Ambiguous order submission.
 *
 * The dangerous broker failure is not a rejection — a rejection is an answer.
 * It is the request that times out AFTER the broker accepted the order. The
 * client sees a network error; the broker holds a live order. Treating that as
 * a rejection produces an orphaned position: real exposure that Northstar does
 * not know it has, does not mark, does not risk-check and will never exit.
 *
 * The rule is: on an ambiguous failure, ask the broker what actually happened
 * before deciding. The idempotency key makes that question answerable.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FixedClock, NullLogger } from '../../src/core/index.js';
import type {
  BrokerAccount,
  BrokerAsset,
  BrokerOrder,
  BrokerOrderRequest,
  BrokerProvider,
  BrokerPosition,
} from '../../src/providers/broker/BrokerProvider.js';
import { BrokerError } from '../../src/providers/broker/BrokerProvider.js';
import { bullishTier1Post, corroboratingTier2Post, createHarness } from '../fixtures/harness.js';

/**
 * A broker that accepts every order and then loses the response.
 *
 * This is the real-world shape of a timeout against a broker that is working
 * perfectly: the order exists, the answer did not arrive.
 */
class AcceptsThenTimesOutBroker implements BrokerProvider {
  /*
   * Identifies as SIMULATED, deliberately.
   *
   * This broker reproduces Alpaca's failure shapes, but it is not an Alpaca
   * account and the data driving these tests is fixture data. Claiming to be
   * 'alpaca' would (correctly) trip the autonomy gate, which refuses to let
   * fixture-derived orders reach a real account — the gate would be right, and
   * these tests are about ambiguous submissions, not about the gate.
   */
  readonly brokerId = 'simulated';
  readonly mode = 'PAPER' as const;

  /** Orders the broker really holds, keyed by client order id. */
  readonly accepted = new Map<string, BrokerOrder>();
  clientLookups = 0;

  constructor(private readonly clock: FixedClock) {}

  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    return { healthy: true, detail: 'ok' };
  }

  async getAccount(): Promise<BrokerAccount> {
    return {
      accountId: 'acct',
      equity: 100_000,
      cash: 100_000,
      buyingPower: 100_000,
      tradingBlocked: false,
      patternDayTrader: false,
      mode: 'PAPER',
    };
  }

  async getAsset(ticker: string): Promise<BrokerAsset | null> {
    return { ticker, tradable: true, fractionable: true, exchange: 'NASDAQ', name: ticker };
  }

  async listTradableAssets(): Promise<BrokerAsset[]> {
    return [];
  }

  async submitOrder(req: BrokerOrderRequest): Promise<BrokerOrder> {
    const now = this.clock.nowIso();
    // The broker accepts it…
    this.accepted.set(req.clientOrderId, {
      brokerOrderId: `broker-${req.clientOrderId}`,
      clientOrderId: req.clientOrderId,
      ticker: req.ticker,
      side: req.side,
      status: 'NEW',
      submittedQuantity: req.quantity ?? null,
      submittedNotionalCents: req.notionalCents ?? null,
      filledQuantity: 0,
      filledAvgPrice: null,
      submittedAt: now,
      updatedAt: now,
      rejectReason: null,
    });
    // …and the response never arrives.
    throw new BrokerError('Alpaca request failed: The operation was aborted', 'NETWORK', true);
  }

  async getOrderByClientId(clientOrderId: string): Promise<BrokerOrder | null> {
    this.clientLookups += 1;
    return this.accepted.get(clientOrderId) ?? null;
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrder | null> {
    return [...this.accepted.values()].find((o) => o.brokerOrderId === brokerOrderId) ?? null;
  }

  async cancelOrder(): Promise<void> {}

  async listOpenOrders(): Promise<BrokerOrder[]> {
    return [...this.accepted.values()].filter((o) => o.status === 'NEW' || o.status === 'PENDING');
  }

  async listPositions(): Promise<BrokerPosition[]> {
    return [];
  }

  async isMarketOpen(): Promise<boolean> {
    return true;
  }
}

describe('ambiguous order submission', () => {
  async function submitInto(broker: AcceptsThenTimesOutBroker) {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()], broker });
    await h.app.runner.runCycle();
    return h;
  }

  it('asks the broker what happened instead of assuming rejection', async () => {
    const clock = new FixedClock('2026-03-10T15:00:00.000Z');
    const broker = new AcceptsThenTimesOutBroker(clock);
    const h = await submitInto(broker);

    assert.equal(broker.accepted.size, 1, 'the broker really did accept an order');
    assert.ok(broker.clientLookups > 0, 'the router must ask the broker before deciding the outcome');

    h.close();
  });

  it('records the order the broker actually holds, rather than a phantom rejection', async () => {
    const clock = new FixedClock('2026-03-10T15:00:00.000Z');
    const broker = new AcceptsThenTimesOutBroker(clock);
    const h = await submitInto(broker);

    const accepted = [...broker.accepted.values()][0]!;
    const local = h.app.store.orders.byClientOrderId(accepted.clientOrderId);

    assert.ok(local, 'the order must exist locally');
    assert.notEqual(local!.status, 'REJECTED', 'an accepted order must not be booked as rejected');
    assert.equal(local!.brokerOrderId, accepted.brokerOrderId, 'the broker id must be adopted');
    h.close();
  });

  it('leaves no orphan: the broker order is visible to reconciliation', async () => {
    const clock = new FixedClock('2026-03-10T15:00:00.000Z');
    const broker = new AcceptsThenTimesOutBroker(clock);
    const h = await submitInto(broker);

    const report = await h.app.reconciliation.reconcile();
    const orphan = report.discrepancies.find(
      (d) => d.area === 'ORDERS' && d.broker !== 'no record' && d.northstar === 'no record',
    );
    assert.equal(orphan, undefined, `an accepted order must not read as an orphan: ${JSON.stringify(orphan)}`);
    h.close();
  });

  it('keeps the capital reserved for an order that really exists', async () => {
    const clock = new FixedClock('2026-03-10T15:00:00.000Z');
    const broker = new AcceptsThenTimesOutBroker(clock);
    const h = await submitInto(broker);

    // Releasing the reservation for a live order would let the strategy spend
    // the same dollars twice.
    const ledger = h.app.ledger.get();
    assert.ok(ledger.reservedCents > 0, 'capital committed to a live order must stay reserved');
    h.close();
  });

  it('never submits a second order for the same proposal', async () => {
    const clock = new FixedClock('2026-03-10T15:00:00.000Z');
    const broker = new AcceptsThenTimesOutBroker(clock);
    const h = await submitInto(broker);

    // Another scan on the same evidence must not produce a second order.
    h.clock.advanceMinutes(2);
    await h.app.runner.runCycle();

    assert.equal(broker.accepted.size, 1, 'exactly one order may reach the broker');
    h.close();
  });
});

/** Accepts nothing, and the lookup afterwards fails too. */
class UnreachableAfterTimeoutBroker extends AcceptsThenTimesOutBroker {
  override async getOrderByClientId(): Promise<BrokerOrder | null> {
    this.clientLookups += 1;
    throw new BrokerError('Alpaca request failed: connect ETIMEDOUT', 'NETWORK', true);
  }
}

/** Times out, and genuinely never accepted the order. */
class TimesOutWithoutAcceptingBroker extends AcceptsThenTimesOutBroker {
  override async submitOrder(req: BrokerOrderRequest): Promise<BrokerOrder> {
    void req;
    throw new BrokerError('Alpaca request failed: The operation was aborted', 'NETWORK', true);
  }
}

describe('ambiguous submission — the other two answers', () => {
  it('releases capital when the broker confirms it holds nothing', async () => {
    const clock = new FixedClock('2026-03-10T15:00:00.000Z');
    const broker = new TimesOutWithoutAcceptingBroker(clock);
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()], broker });
    await h.app.runner.runCycle();

    assert.ok(broker.clientLookups > 0, 'the broker was asked');
    assert.equal(broker.accepted.size, 0, 'nothing was ever accepted');

    // A confirmed "no" is an answer, so the dollars must go back.
    assert.equal(h.app.ledger.get().reservedCents, 0, 'capital must be released for an order that does not exist');
    const order = h.app.store.orders.all()[0];
    assert.equal(order?.status, 'REJECTED');
    h.close();
  });

  it('holds the order pending when the broker cannot be asked at all', async () => {
    const clock = new FixedClock('2026-03-10T15:00:00.000Z');
    const broker = new UnreachableAfterTimeoutBroker(clock);
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()], broker });
    await h.app.runner.runCycle();

    const order = h.app.store.orders.all().find((o) => o.intent === 'ENTRY');
    assert.ok(order, 'the attempt is recorded');
    assert.equal(order!.status, 'PENDING', 'unknown is not rejected');
    assert.equal(order!.brokerOrderId, null);

    // The dollars stay committed: spending them twice is the unrecoverable error.
    assert.ok(h.app.ledger.get().reservedCents > 0, 'capital stays reserved while the outcome is unknown');

    // And the order stays in the reconciliation queue rather than being lost.
    const queued = h.app.store.orders.needingReconciliation(h.app.spec.strategyId);
    assert.ok(queued.some((o) => o.orderId === order!.orderId), 'a pending order must keep being chased');
    h.close();
  });

  it('self-heals once the broker is reachable again and has no such order', async () => {
    const clock = new FixedClock('2026-03-10T15:00:00.000Z');
    const broker = new UnreachableAfterTimeoutBroker(clock);
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()], broker });
    await h.app.runner.runCycle();
    assert.ok(h.app.ledger.get().reservedCents > 0);

    // The network comes back; the broker confirms it never had the order.
    Object.defineProperty(broker, 'getOrderByClientId', {
      value: async () => null,
      writable: true,
    });

    await h.app.positionManager.reconcile();

    assert.equal(h.app.ledger.get().reservedCents, 0, 'the reservation is released once the answer arrives');
    const order = h.app.store.orders.all().find((o) => o.intent === 'ENTRY');
    assert.equal(order?.status, 'CANCELLED');
    h.close();
  });
});
