/**
 * Reconciliation.
 *
 * Compares Northstar's own books against the broker's, and reports what
 * disagrees. It is strictly READ-ONLY: it opens no orders, writes no ledger
 * entries, mutates no positions and repairs nothing.
 *
 * That restraint is deliberate. When the two sides disagree, one of them is
 * wrong and an automated "fix" has a 50% chance of destroying the evidence
 * needed to work out which. The correct response to a discrepancy is a human
 * reading this report.
 *
 * A note on account sharing: the Alpaca account may hold positions belonging to
 * other strategies or placed by hand. So a broker position LARGER than
 * Northstar's is not a discrepancy — only a shortfall is, because that means
 * Northstar believes it owns something the broker cannot confirm.
 */
import type { Clock, Logger } from '../core/index.js';
import { formatUsd, positionValueCents, round } from '../core/index.js';
import type { Store } from '../persistence/store.js';
import type { BrokerProvider } from '../providers/broker/BrokerProvider.js';
import type { CapitalLedgerService } from '../pipeline/ledger.js';

export type DiscrepancySeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface Discrepancy {
  severity: DiscrepancySeverity;
  area: 'LEDGER' | 'ORDERS' | 'FILLS' | 'POSITIONS' | 'ACCOUNT';
  subject: string;
  detail: string;
  northstar: string;
  broker: string;
}

export interface ReconciliationReport {
  strategyId: string;
  at: string;
  brokerId: string;
  brokerMode: string;
  reachedBroker: boolean;
  ok: boolean;
  discrepancies: Discrepancy[];
  checked: {
    ledgerEntries: number;
    openOrders: number;
    openPositions: number;
    brokerOpenOrders: number;
    brokerPositions: number;
  };
  ledger: {
    cashCents: number;
    reservedCents: number;
    positionsValueCents: number;
    equityCents: number;
    entryLogCashCents: number;
    integrityOk: boolean;
  };
  summary: string;
}

export class ReconciliationService {
  private readonly log: Logger;

  constructor(
    private readonly store: Store,
    private readonly broker: BrokerProvider,
    private readonly ledger: CapitalLedgerService,
    private readonly clock: Clock,
    logger: Logger,
    private readonly strategyId: string,
  ) {
    this.log = logger.child('reconcile');
  }

  async reconcile(): Promise<ReconciliationReport> {
    const discrepancies: Discrepancy[] = [];
    const add = (d: Discrepancy): void => {
      discrepancies.push(d);
    };

    const ledger = this.ledger.get();
    const integrity = this.ledger.verifyIntegrity();
    const openOrders = this.store.orders.open(this.strategyId);
    const openPositions = this.store.positions.open(this.strategyId);

    /* ------------------------------------------------ 1. internal ledger */

    if (!integrity.ok) {
      add({
        severity: 'CRITICAL',
        area: 'LEDGER',
        subject: 'cash vs entry log',
        detail: integrity.detail,
        northstar: formatUsd(integrity.actualCashCents),
        broker: `entry log implies ${formatUsd(integrity.expectedCashCents)}`,
      });
    }

    if (ledger.reservedCents > ledger.cashCents) {
      add({
        severity: 'CRITICAL',
        area: 'LEDGER',
        subject: 'reserved capital',
        detail: 'Reserved capital exceeds cash, so the strategy has committed money it does not hold.',
        northstar: `reserved ${formatUsd(ledger.reservedCents)}`,
        broker: `cash ${formatUsd(ledger.cashCents)}`,
      });
    }

    const markedValue = openPositions.reduce(
      (a, p) => a + positionValueCents(p.quantity, p.lastMarkPrice),
      0,
    );
    if (Math.abs(markedValue - ledger.positionsValueCents) > 1) {
      add({
        severity: 'WARNING',
        area: 'LEDGER',
        subject: 'positions value',
        detail: 'Stored positions value disagrees with the sum of open positions at their last marks.',
        northstar: formatUsd(ledger.positionsValueCents),
        broker: `${formatUsd(markedValue)} from marks`,
      });
    }

    if (Math.abs(ledger.equityCents - (ledger.cashCents + ledger.positionsValueCents)) > 1) {
      add({
        severity: 'CRITICAL',
        area: 'LEDGER',
        subject: 'equity identity',
        detail: 'Equity does not equal cash plus position value.',
        northstar: formatUsd(ledger.equityCents),
        broker: formatUsd(ledger.cashCents + ledger.positionsValueCents),
      });
    }

    /* ---------------------------------------------------- 2. the broker */

    let reachedBroker = true;
    let brokerOpenOrderCount = 0;
    let brokerPositionCount = 0;

    try {
      const account = await this.broker.getAccount();
      if (account.tradingBlocked) {
        add({
          severity: 'CRITICAL',
          area: 'ACCOUNT',
          subject: 'trading blocked',
          detail: 'The broker account is blocked from trading.',
          northstar: 'expects to be able to trade',
          broker: 'trading_blocked = true',
        });
      }
      if (account.mode !== this.broker.mode) {
        add({
          severity: 'CRITICAL',
          area: 'ACCOUNT',
          subject: 'mode mismatch',
          detail: 'The broker reports a different environment from the one Northstar believes it is using.',
          northstar: this.broker.mode,
          broker: account.mode,
        });
      }
      // The account may legitimately hold far more than this strategy's $50,
      // but it must not hold LESS than the strategy thinks it has deployed.
      if (account.equity * 100 + 1 < ledger.equityCents) {
        add({
          severity: 'CRITICAL',
          area: 'ACCOUNT',
          subject: 'account smaller than strategy equity',
          detail: 'The whole broker account is worth less than this one strategy claims as equity.',
          northstar: formatUsd(ledger.equityCents),
          broker: formatUsd(Math.round(account.equity * 100)),
        });
      }

      /* --- orders --------------------------------------------------- */
      const brokerOrders = await this.broker.listOpenOrders();
      brokerOpenOrderCount = brokerOrders.length;
      const brokerByClientId = new Map(brokerOrders.map((o) => [o.clientOrderId, o]));

      for (const order of openOrders) {
        const theirs = brokerByClientId.get(order.clientOrderId);
        if (!theirs) {
          // Could be filled/cancelled since; look it up directly before crying.
          const direct = order.brokerOrderId ? await this.broker.getOrder(order.brokerOrderId) : null;
          if (!direct) {
            add({
              severity: 'WARNING',
              area: 'ORDERS',
              subject: `${order.ticker} ${order.orderId}`,
              detail: 'Northstar holds this order open but the broker has no record of it.',
              northstar: `${order.status} (${order.side} ${order.quantity})`,
              broker: 'no record',
            });
          } else if (direct.status !== order.status) {
            add({
              severity: 'INFO',
              area: 'ORDERS',
              subject: `${order.ticker} ${order.orderId}`,
              detail: 'Order status is behind the broker; the next reconcile cycle will catch it up.',
              northstar: order.status,
              broker: direct.status,
            });
          }
          continue;
        }
        if (Math.abs(theirs.filledQuantity - order.filledQuantity) > 1e-6) {
          add({
            severity: 'WARNING',
            area: 'FILLS',
            subject: `${order.ticker} ${order.orderId}`,
            detail: 'Filled quantity disagrees with the broker.',
            northstar: String(order.filledQuantity),
            broker: String(theirs.filledQuantity),
          });
        }
      }

      // Orders at the broker that Northstar has no record of at all. On a
      // shared account these may belong to someone else, hence INFO.
      const ourClientIds = new Set(this.store.orders.all().map((o) => o.clientOrderId));
      for (const theirs of brokerOrders) {
        if (ourClientIds.has(theirs.clientOrderId)) continue;
        add({
          severity: theirs.clientOrderId.startsWith('ns-') ? 'CRITICAL' : 'INFO',
          area: 'ORDERS',
          subject: `${theirs.ticker} ${theirs.brokerOrderId}`,
          detail: theirs.clientOrderId.startsWith('ns-')
            ? 'A Northstar-tagged order exists at the broker with no local record. Something submitted outside this database.'
            : 'Broker has an open order Northstar did not place (another strategy, or manual).',
          northstar: 'no record',
          broker: `${theirs.status} ${theirs.side} ${theirs.ticker}`,
        });
      }

      /* --- positions ------------------------------------------------ */
      const brokerPositions = await this.broker.listPositions();
      brokerPositionCount = brokerPositions.length;
      const brokerByTicker = new Map(brokerPositions.map((p) => [p.ticker.toUpperCase(), p]));

      for (const position of openPositions) {
        const theirs = brokerByTicker.get(position.ticker.toUpperCase());
        if (!theirs) {
          add({
            severity: 'CRITICAL',
            area: 'POSITIONS',
            subject: position.ticker,
            detail: 'Northstar holds this position but the broker reports nothing.',
            northstar: `${position.quantity} @ ${position.entryPrice.toFixed(2)}`,
            broker: 'no position',
          });
          continue;
        }
        if (theirs.quantity + 1e-6 < position.quantity) {
          add({
            severity: 'CRITICAL',
            area: 'POSITIONS',
            subject: position.ticker,
            detail: 'The broker holds fewer shares than Northstar believes this strategy owns.',
            northstar: String(round(position.quantity, 6)),
            broker: String(round(theirs.quantity, 6)),
          });
        }
      }
    } catch (e) {
      reachedBroker = false;
      const detail = e instanceof Error ? e.message : String(e);
      add({
        severity: 'WARNING',
        area: 'ACCOUNT',
        subject: 'broker unreachable',
        detail: `Could not reach the broker to reconcile: ${detail}`,
        northstar: 'local books read successfully',
        broker: 'unreachable',
      });
      this.log.warn('reconciliation could not reach the broker', { detail });
    }

    const critical = discrepancies.filter((d) => d.severity === 'CRITICAL').length;
    const warnings = discrepancies.filter((d) => d.severity === 'WARNING').length;
    const ok = critical === 0 && warnings === 0;

    return {
      strategyId: this.strategyId,
      at: this.clock.nowIso(),
      brokerId: this.broker.brokerId,
      brokerMode: this.broker.mode,
      reachedBroker,
      ok,
      discrepancies,
      checked: {
        ledgerEntries: this.store.ledger.entries(this.strategyId, 100_000).length,
        openOrders: openOrders.length,
        openPositions: openPositions.length,
        brokerOpenOrders: brokerOpenOrderCount,
        brokerPositions: brokerPositionCount,
      },
      ledger: {
        cashCents: ledger.cashCents,
        reservedCents: ledger.reservedCents,
        positionsValueCents: ledger.positionsValueCents,
        equityCents: ledger.equityCents,
        entryLogCashCents: integrity.expectedCashCents,
        integrityOk: integrity.ok,
      },
      summary: ok
        ? `Reconciled cleanly against ${this.broker.brokerId} (${this.broker.mode}). Nothing was modified.`
        : `${critical} critical and ${warnings} warning discrepancy/ies. Nothing was modified — resolve by hand.`,
    };
  }
}
