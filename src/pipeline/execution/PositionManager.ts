/**
 * Fill monitoring and position lifecycle.
 *
 * Polls in-flight orders, records fills exactly once, opens and closes
 * positions, and keeps the capital ledger in step with reality.
 *
 * Partial fills are first-class: a half-filled entry opens a half-sized
 * position and returns the unspent reservation to the ledger, rather than
 * pretending the order will complete.
 */
import type { Clock, Logger } from '../../core/index.js';
import { deterministicId, positionValueCents } from '../../core/index.js';
import type { Fill, Order, Position, TradeProposal } from '../../domain/types.js';
import type { Store } from '../../persistence/store.js';
import type { BrokerProvider } from '../../providers/broker/BrokerProvider.js';
import type { CapitalLedgerService } from '../ledger.js';

export interface PositionManagerOptions {
  store: Store;
  broker: BrokerProvider;
  ledger: CapitalLedgerService;
  clock: Clock;
  logger: Logger;
  strategyId: string;
  strategyVersion: string;
  /** Fees per fill, in cents. Alpaca US equities are commission-free. */
  feePerFillCents?: number;
}

export interface ReconcileResult {
  ordersChecked: number;
  fillsRecorded: number;
  positionsOpened: string[];
  positionsClosed: string[];
  ordersCancelled: string[];
  errors: string[];
}

export class PositionManager {
  private readonly store: Store;
  private readonly broker: BrokerProvider;
  private readonly ledger: CapitalLedgerService;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly strategyId: string;
  private readonly strategyVersion: string;
  private readonly feePerFillCents: number;

  constructor(opts: PositionManagerOptions) {
    this.store = opts.store;
    this.broker = opts.broker;
    this.ledger = opts.ledger;
    this.clock = opts.clock;
    this.log = opts.logger.child('positions');
    this.strategyId = opts.strategyId;
    this.strategyVersion = opts.strategyVersion;
    this.feePerFillCents = opts.feePerFillCents ?? 0;
  }

  /** Poll every in-flight order and apply whatever the broker reports. */
  async reconcile(): Promise<ReconcileResult> {
    const result: ReconcileResult = {
      ordersChecked: 0,
      fillsRecorded: 0,
      positionsOpened: [],
      positionsClosed: [],
      ordersCancelled: [],
      errors: [],
    };

    for (const order of this.store.orders.needingReconciliation(this.strategyId)) {
      result.ordersChecked += 1;
      try {
        const brokerOrder = order.brokerOrderId
          ? await this.broker.getOrder(order.brokerOrderId)
          : await this.broker.getOrderByClientId(order.clientOrderId);

        if (!brokerOrder) {
          // The broker has no record. Treat as cancelled and release capital,
          // rather than leaving cash committed to a phantom order forever.
          this.store.orders.save({ ...order, status: 'CANCELLED', updatedAt: this.clock.nowIso() });
          this.settleReservation(order, true);
          result.ordersCancelled.push(order.orderId);
          continue;
        }

        const newlyFilled = Number((brokerOrder.filledQuantity - order.filledQuantity).toFixed(6));
        const updated: Order = {
          ...order,
          brokerOrderId: brokerOrder.brokerOrderId,
          status: brokerOrder.status,
          filledQuantity: brokerOrder.filledQuantity,
          filledAvgPrice: brokerOrder.filledAvgPrice,
          rejectReason: brokerOrder.rejectReason,
          updatedAt: this.clock.nowIso(),
        };
        this.store.orders.save(updated);

        if (newlyFilled > 1e-9 && brokerOrder.filledAvgPrice) {
          const fill = this.recordFill(updated, newlyFilled, brokerOrder.filledAvgPrice, brokerOrder.status !== 'FILLED');
          if (fill) result.fillsRecorded += 1;
        }

        if (brokerOrder.status === 'FILLED' || brokerOrder.status === 'PARTIALLY_FILLED') {
          const applied = this.applyFills(updated);
          if (applied.opened) result.positionsOpened.push(applied.opened);
          if (applied.closed) result.positionsClosed.push(applied.closed);
        }

        if (brokerOrder.status === 'REJECTED' || brokerOrder.status === 'CANCELLED' || brokerOrder.status === 'EXPIRED') {
          this.settleReservation(updated, true);
          if (updated.proposalId) {
            this.store.proposals.setStatus(
              updated.proposalId,
              brokerOrder.status === 'REJECTED' ? 'FAILED' : 'CANCELLED',
            );
          }
          // A rejected exit leaves the position open so the exit engine retries.
          if (updated.intent === 'EXIT' && updated.positionId) {
            const position = this.store.positions.byId(updated.positionId);
            if (position && position.status === 'CLOSING') {
              this.store.positions.save({ ...position, status: 'OPEN', exitOrderId: null });
            }
          }
          result.ordersCancelled.push(updated.orderId);
          this.store.log.append({
            correlationId: updated.correlationId,
            strategyId: this.strategyId,
            stage: 'ORDER',
            subjectId: updated.orderId,
            summary: `Order ${brokerOrder.status.toLowerCase()}: ${updated.ticker}`,
            payload: { status: brokerOrder.status, reason: brokerOrder.rejectReason, intent: updated.intent },
          });
        }

        // A partially-filled DAY order that is no longer live: bank what filled
        // and release the rest.
        if (brokerOrder.status === 'PARTIALLY_FILLED') {
          this.log.info('order partially filled', {
            orderId: updated.orderId,
            filled: updated.filledQuantity,
            requested: updated.quantity,
          });
        }
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        result.errors.push(`${order.orderId}: ${detail}`);
        this.log.warn('order reconciliation failed', { orderId: order.orderId, detail });
      }
    }

    return result;
  }

  /** Record a fill idempotently. Returns null when it was already recorded. */
  private recordFill(order: Order, quantity: number, price: number, partial: boolean): Fill | null {
    const fillId = deterministicId('fill', order.orderId, quantity.toFixed(6), price.toFixed(6));
    if (this.store.fills.exists(fillId)) return null;

    const fill: Fill = {
      fillId,
      orderId: order.orderId,
      brokerOrderId: order.brokerOrderId,
      securityId: order.securityId,
      ticker: order.ticker,
      side: order.side,
      quantity,
      price,
      feesCents: this.feePerFillCents,
      filledAt: this.clock.nowIso(),
      partial,
    };
    this.store.fills.save(fill);

    this.store.log.append({
      correlationId: order.correlationId,
      strategyId: this.strategyId,
      stage: 'FILL',
      subjectId: fill.fillId,
      summary: `${order.side} ${quantity} ${order.ticker} @ ${price.toFixed(4)}${partial ? ' (partial)' : ''}`,
      payload: { orderId: order.orderId, quantity, price, partial },
    });
    return fill;
  }

  /** Fold an order's fills into a position and the ledger. */
  private applyFills(order: Order): { opened: string | null; closed: string | null } {
    const fills = this.store.fills.byOrder(order.orderId);
    if (fills.length === 0) return { opened: null, closed: null };

    const totalQuantity = Number(fills.reduce((a, f) => a + f.quantity, 0).toFixed(6));
    if (totalQuantity <= 0) return { opened: null, closed: null };

    const notional = fills.reduce((a, f) => a + f.quantity * f.price, 0);
    const avgPrice = notional / totalQuantity;
    const fees = fills.reduce((a, f) => a + f.feesCents, 0);

    if (order.intent === 'ENTRY') {
      const existing = this.store.positions.byId(entryPositionId(order));
      if (existing) {
        // Later fills on the same entry order top up the same position.
        if (Math.abs(existing.quantity - totalQuantity) < 1e-9) return { opened: null, closed: null };
        const addedCost = positionValueCents(totalQuantity, avgPrice) - existing.entryCostCents;
        this.ledger.recordBuy(addedCost, 0, order.orderId, `Additional fill on ${order.ticker}`);
        this.store.positions.save({
          ...existing,
          quantity: totalQuantity,
          entryPrice: avgPrice,
          entryCostCents: positionValueCents(totalQuantity, avgPrice),
        });
        this.settleReservation({ ...order, filledQuantity: totalQuantity, filledAvgPrice: avgPrice }, false);
        return { opened: null, closed: null };
      }

      const proposal = order.proposalId ? this.store.proposals.byId(order.proposalId) : null;
      if (!proposal) {
        this.log.error('entry fill without a proposal', { orderId: order.orderId });
        return { opened: null, closed: null };
      }
      const position = this.openPosition(order, proposal, totalQuantity, avgPrice, fees);
      // The entry has been paid for out of cash, so its reservation is fully
      // discharged — including the part that was actually spent.
      this.settleReservation(order, order.status === 'FILLED');
      return { opened: position.positionId, closed: null };
    }

    // EXIT
    if (!order.positionId) return { opened: null, closed: null };
    const position = this.store.positions.byId(order.positionId);
    if (!position || position.status === 'CLOSED') return { opened: null, closed: null };
    if (totalQuantity + 1e-9 < position.quantity) {
      // Partial exit: shrink the position, keep it open for the remainder.
      const soldCost = Math.round(position.entryCostCents * (totalQuantity / position.quantity));
      const proceeds = positionValueCents(totalQuantity, avgPrice);
      this.ledger.recordSell(proceeds, proceeds - soldCost, fees, order.orderId, `Partial exit of ${order.ticker}`);
      this.store.positions.save({
        ...position,
        quantity: Number((position.quantity - totalQuantity).toFixed(6)),
        entryCostCents: position.entryCostCents - soldCost,
        status: 'OPEN',
        exitOrderId: null,
        feesCents: position.feesCents + fees,
      });
      return { opened: null, closed: null };
    }

    const closed = this.closePosition(position, order, totalQuantity, avgPrice, fees);
    return { opened: null, closed: closed.positionId };
  }

  private openPosition(order: Order, proposal: TradeProposal, quantity: number, price: number, fees: number): Position {
    const costCents = positionValueCents(quantity, price);
    const at = this.clock.nowIso();
    const signal = this.store.signals.byId(proposal.signalId);

    const position: Position = {
      positionId: entryPositionId(order),
      strategyId: this.strategyId,
      strategyVersion: this.strategyVersion,
      securityId: order.securityId,
      ticker: order.ticker,
      direction: 'LONG',
      status: 'OPEN',
      quantity,
      entryPrice: price,
      entryCostCents: costCents,
      openedAt: at,
      entryOrderId: order.orderId,
      entrySignalId: proposal.signalId,
      entryProposalId: proposal.proposalId,
      entrySignalScore: signal?.score ?? 0,
      invalidationCondition: proposal.invalidationCondition,
      highWaterPrice: price,
      lastMarkPrice: price,
      lastMarkAt: at,
      unrealisedPnlCents: 0,
      exitOrderId: null,
      exitPrice: null,
      exitProceedsCents: null,
      closedAt: null,
      exitReason: null,
      exitNote: null,
      realisedPnlCents: null,
      feesCents: fees,
      mode: order.mode,
    };

    this.store.positions.save(position);
    this.store.orders.save({ ...order, positionId: position.positionId });
    this.ledger.recordBuy(costCents, fees, order.orderId, `Opened ${quantity} ${order.ticker} @ ${price.toFixed(4)}`);
    this.store.proposals.setStatus(proposal.proposalId, 'FILLED');

    this.store.log.append({
      correlationId: order.correlationId,
      strategyId: this.strategyId,
      stage: 'POSITION',
      subjectId: position.positionId,
      summary: `Opened ${quantity} ${order.ticker} @ ${price.toFixed(4)}`,
      payload: {
        positionId: position.positionId,
        signalId: proposal.signalId,
        proposalId: proposal.proposalId,
        costCents,
        mode: order.mode,
      },
    });

    return position;
  }

  private closePosition(position: Position, order: Order, quantity: number, price: number, fees: number): Position {
    const proceeds = positionValueCents(quantity, price);
    const realised = proceeds - position.entryCostCents - fees - position.feesCents;
    const at = this.clock.nowIso();

    const closed: Position = {
      ...position,
      status: 'CLOSED',
      exitOrderId: order.orderId,
      exitPrice: price,
      exitProceedsCents: proceeds,
      closedAt: at,
      exitReason: position.exitReason ?? 'MANUAL',
      exitNote: position.exitNote ?? 'Closed',
      realisedPnlCents: realised,
      feesCents: position.feesCents + fees,
      unrealisedPnlCents: 0,
    };
    this.store.positions.save(closed);
    this.ledger.recordSell(proceeds, realised, fees, order.orderId, `Closed ${position.ticker}: ${closed.exitReason}`);

    this.store.log.append({
      correlationId: order.correlationId,
      strategyId: this.strategyId,
      stage: 'OUTCOME',
      subjectId: position.positionId,
      summary:
        `Closed ${position.ticker} at ${price.toFixed(4)} (${closed.exitReason}), ` +
        `realised ${(realised / 100).toFixed(2)} USD`,
      payload: {
        positionId: position.positionId,
        entryPrice: position.entryPrice,
        exitPrice: price,
        realisedPnlCents: realised,
        exitReason: closed.exitReason,
        holdingHours: (new Date(at).getTime() - new Date(position.openedAt).getTime()) / 3_600_000,
      },
    });

    return closed;
  }

  /**
   * Bring an entry order's reservation back in line with reality.
   *
   * While the order is live, the unfilled remainder stays committed. Once it is
   * terminal, the whole reservation is retired: the filled part has already
   * left the ledger as cash via recordBuy, so leaving it reserved as well would
   * double-count it and push `reserved` above `cash`.
   */
  private settleReservation(order: Order, terminal: boolean): void {
    if (order.intent !== 'ENTRY' || !order.proposalId || !order.notionalCents) return;
    if (terminal) {
      this.ledger.settleReservation(order.proposalId, 0, `Entry reservation retired for ${order.ticker}`);
      return;
    }
    const spent = order.filledQuantity > 0 && order.filledAvgPrice
      ? positionValueCents(order.filledQuantity, order.filledAvgPrice)
      : 0;
    const stillCommitted = Math.max(0, order.notionalCents - spent);
    this.ledger.settleReservation(order.proposalId, stillCommitted, `Partial fill on ${order.ticker}`);
  }

  /**
   * Compare Northstar's view of positions with the broker's.
   *
   * A mismatch is a ledger-integrity fault: something filled or closed outside
   * Northstar's knowledge, and the strategy should pause rather than trade on a
   * false picture.
   */
  async reconcileWithBroker(): Promise<{ matched: boolean; detail: string; discrepancies: string[] }> {
    const discrepancies: string[] = [];
    try {
      const brokerPositions = await this.broker.listPositions();
      const brokerByTicker = new Map(brokerPositions.map((p) => [p.ticker.toUpperCase(), p]));
      const ours = this.store.positions.open(this.strategyId);

      for (const position of ours) {
        const theirs = brokerByTicker.get(position.ticker.toUpperCase());
        if (!theirs) {
          discrepancies.push(`${position.ticker}: Northstar holds ${position.quantity}, broker holds nothing`);
          continue;
        }
        // The broker account may hold more than this strategy's slice (other
        // strategies share the account), so only a shortfall is a problem.
        if (theirs.quantity + 1e-6 < position.quantity) {
          discrepancies.push(
            `${position.ticker}: Northstar holds ${position.quantity}, broker holds only ${theirs.quantity}`,
          );
        }
      }

      return {
        matched: discrepancies.length === 0,
        detail: discrepancies.length === 0 ? 'Positions reconcile with the broker' : discrepancies.join('; '),
        discrepancies,
      };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return { matched: false, detail: `Broker position reconciliation failed: ${detail}`, discrepancies: [detail] };
    }
  }
}

export function entryPositionId(order: Order): string {
  return deterministicId('pos', order.orderId);
}
