/**
 * OrderRouter — the ONLY code path that reaches a BrokerProvider.
 *
 * Nothing else in Northstar may call `broker.submitOrder`. Everything that
 * wants an order goes through `submitEntry` or `submitExit`, which enforce, in
 * order:
 *
 *   1. a risk decision exists, is approved, and belongs to this proposal
 *   2. the proposal has not expired
 *   3. the material terms still match what was approved (price/size drift
 *      invalidates rather than executes)
 *   4. in LIVE mode, a human approval exists for exactly these terms
 *
 * Rule 4 is the live gate. There is no flag, no override and no alternate
 * method that skips it: `assertLiveApproval` runs before the broker is touched
 * and returns a blocking result that `submitEntry` cannot proceed past.
 *
 * Exits are treated differently on purpose. An exit reduces exposure and never
 * commits new capital, and blocking a stop-loss behind a human who may be
 * asleep is more dangerous than letting it run. Exits therefore execute
 * automatically in both modes unless `requireApprovalForLiveExits` is set.
 */
import type { Clock, Logger } from '../../core/index.js';
import type { Cents } from '../../core/index.js';
import { centsToDollars, deterministicId, formatUsd, positionValueCents, randomId } from '../../core/index.js';
import type {
  ExitReason,
  Order,
  Position,
  RiskDecision,
  TradeProposal,
  TradingMode,
  XSignal,
} from '../../domain/types.js';
import type { Store } from '../../persistence/store.js';
import type { BrokerProvider } from '../../providers/broker/BrokerProvider.js';
import { BrokerError } from '../../providers/broker/BrokerProvider.js';
import type { MarketDataProvider } from '../../providers/marketdata/MarketDataProvider.js';
import type { CapitalLedgerService } from '../ledger.js';
import { fingerprintTerms, termsFor } from '../proposal.js';

export interface OrderRouterOptions {
  store: Store;
  broker: BrokerProvider;
  marketData: MarketDataProvider;
  ledger: CapitalLedgerService;
  clock: Clock;
  logger: Logger;
  /** Percent price drift that invalidates an approved proposal. */
  priceDriftTolerancePct?: number;
  /**
   * Maximum age of the SIGNAL at the moment of submission.
   *
   * Distinct from proposal expiry: a proposal can be minutes old while the
   * evidence behind it is hours old, and in LIVE mode a human may approve long
   * after the story stopped being news. The last thing checked before a broker
   * call is therefore whether the reason for the trade is still current.
   * Omitted leaves the check off (tests, replay).
   */
  signalTtlMinutes?: number | null;
  /** Require human approval for LIVE exits too. Off by default; see above. */
  requireApprovalForLiveExits?: boolean;
}

type LiveGateResult =
  | { allowed: true }
  | { allowed: false; reason: 'NO_APPROVAL' | 'INVALIDATED'; detail: string };

export type SubmitOutcome =
  | { ok: true; order: Order }
  | {
      ok: false;
      reason:
        | 'RISK_REJECTED'
        | 'EXPIRED'
        | 'SIGNAL_EXPIRED'
        | 'INVALIDATED'
        | 'NO_APPROVAL'
        | 'BROKER_ERROR'
        | 'DUPLICATE';
      detail: string;
    };

export class OrderRouter {
  private readonly store: Store;
  private readonly broker: BrokerProvider;
  private readonly marketData: MarketDataProvider;
  private readonly ledger: CapitalLedgerService;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly driftTolerancePct: number;
  private readonly requireApprovalForLiveExits: boolean;
  private readonly signalTtlMinutes: number | null;

  constructor(opts: OrderRouterOptions) {
    this.store = opts.store;
    this.broker = opts.broker;
    this.marketData = opts.marketData;
    this.ledger = opts.ledger;
    this.clock = opts.clock;
    this.log = opts.logger.child('order-router');
    this.driftTolerancePct = opts.priceDriftTolerancePct ?? 1.0;
    this.requireApprovalForLiveExits = opts.requireApprovalForLiveExits ?? false;
    this.signalTtlMinutes = opts.signalTtlMinutes ?? null;
  }

  get mode(): TradingMode {
    return this.broker.mode;
  }

  /**
   * Submit the entry order for an approved proposal.
   *
   * In PAPER mode this runs unattended. In LIVE mode it refuses to proceed
   * without a matching ApprovalRecord.
   */
  async submitEntry(proposal: TradeProposal, riskDecision: RiskDecision, signal: XSignal): Promise<SubmitOutcome> {
    /* -------- 1. risk must have approved THIS proposal ------------------ */
    if (!riskDecision.approved) {
      this.store.proposals.setStatus(proposal.proposalId, 'RISK_REJECTED');
      return { ok: false, reason: 'RISK_REJECTED', detail: riskDecision.summary };
    }
    if (riskDecision.proposalId !== proposal.proposalId) {
      throw new Error(
        `Risk decision ${riskDecision.riskDecisionId} belongs to proposal ${riskDecision.proposalId}, not ${proposal.proposalId}`,
      );
    }

    /* -------- 2. expiry ------------------------------------------------- */
    if (new Date(proposal.expiresAt).getTime() <= this.clock.nowMs()) {
      this.store.proposals.setStatus(proposal.proposalId, 'EXPIRED');
      this.logDecision(proposal, 'ORDER', 'Proposal expired before submission', { expiresAt: proposal.expiresAt });
      return { ok: false, reason: 'EXPIRED', detail: `Proposal expired at ${proposal.expiresAt}` };
    }

    /* -------- 2b. the EVIDENCE must still be current --------------------- */
    if (this.signalTtlMinutes !== null) {
      const ageMinutes = (this.clock.nowMs() - new Date(signal.generatedAt).getTime()) / 60_000;
      if (ageMinutes > this.signalTtlMinutes) {
        this.store.proposals.setStatus(proposal.proposalId, 'EXPIRED');
        const detail =
          `Signal ${signal.signalId} is ${ageMinutes.toFixed(1)}m old, past the ` +
          `${this.signalTtlMinutes}m TTL; the evidence is no longer current`;
        this.logDecision(proposal, 'ORDER', `Signal expired before submission: ${detail}`, {
          signalId: signal.signalId,
          signalGeneratedAt: signal.generatedAt,
          ageMinutes: Number(ageMinutes.toFixed(2)),
          ttlMinutes: this.signalTtlMinutes,
        });
        return { ok: false, reason: 'SIGNAL_EXPIRED', detail };
      }
    }

    /* -------- 3. the terms must still be the terms ---------------------- */
    const drift = await this.checkDrift(proposal);
    if (!drift.ok) {
      this.store.proposals.setStatus(proposal.proposalId, 'INVALIDATED');
      this.logDecision(proposal, 'ORDER', `Proposal invalidated: ${drift.detail}`, { drift: drift.driftPct });
      return { ok: false, reason: 'INVALIDATED', detail: drift.detail };
    }

    const expectedFingerprint = fingerprintTerms(termsFor(proposal, signal.score));
    if (expectedFingerprint !== proposal.approvalFingerprint) {
      this.store.proposals.setStatus(proposal.proposalId, 'INVALIDATED');
      return {
        ok: false,
        reason: 'INVALIDATED',
        detail: 'Proposal terms no longer match their recorded fingerprint',
      };
    }

    /* -------- 4. THE LIVE GATE ------------------------------------------ */
    if (this.broker.mode === 'LIVE') {
      const gate = this.assertLiveApproval(proposal, expectedFingerprint);
      if (!gate.allowed) return { ok: false, reason: gate.reason, detail: gate.detail };
    }

    /* -------- 5. idempotency -------------------------------------------- */
    const clientOrderId = entryClientOrderId(proposal);
    const existing = this.store.orders.byClientOrderId(clientOrderId);
    if (existing) {
      this.log.warn('entry already submitted for this proposal', { proposalId: proposal.proposalId, clientOrderId });
      return { ok: false, reason: 'DUPLICATE', detail: `Order ${existing.orderId} already exists for this proposal` };
    }

    /* -------- 6. commit strategy capital -------------------------------- */
    const capital = riskDecision.permittedCapitalCents;
    if (!this.ledger.reserve(capital, proposal.proposalId, `Entry reservation for ${proposal.ticker}`)) {
      return { ok: false, reason: 'RISK_REJECTED', detail: 'Strategy cash could not be reserved' };
    }

    /* -------- 7. submit -------------------------------------------------- */
    const now = this.clock.nowIso();
    const order: Order = {
      orderId: deterministicId('ord', proposal.proposalId, 'ENTRY'),
      brokerOrderId: null,
      strategyId: proposal.strategyId,
      proposalId: proposal.proposalId,
      positionId: null,
      securityId: proposal.securityId,
      ticker: proposal.ticker,
      side: 'BUY',
      quantity: riskDecision.permittedQuantity,
      notionalCents: proposal.fractional ? capital : null,
      type: 'MARKET',
      timeInForce: 'DAY',
      mode: this.broker.mode,
      status: 'NEW',
      submittedAt: now,
      updatedAt: now,
      filledQuantity: 0,
      filledAvgPrice: null,
      clientOrderId,
      rejectReason: null,
      intent: 'ENTRY',
      correlationId: proposal.correlationId,
    };

    try {
      const brokerOrder = await this.broker.submitOrder({
        clientOrderId,
        ticker: proposal.ticker,
        side: 'BUY',
        // Fractional orders are sized by notional so the strategy spends
        // exactly the dollars it reserved, not a rounded share count.
        ...(proposal.fractional ? { notionalCents: capital } : { quantity: riskDecision.permittedQuantity }),
        type: 'MARKET',
        timeInForce: 'DAY',
      });

      order.brokerOrderId = brokerOrder.brokerOrderId;
      order.status = brokerOrder.status;
      // Fill quantities are deliberately NOT copied here. The PositionManager
      // is the single place that records fills, so a broker that fills
      // instantly and one that fills over several polls take the same path.
      order.updatedAt = this.clock.nowIso();
      this.store.orders.save(order);
      this.store.proposals.setStatus(proposal.proposalId, 'SUBMITTED');

      this.logDecision(proposal, 'ORDER', `Submitted ${formatUsd(capital)} BUY ${proposal.ticker}`, {
        orderId: order.orderId,
        brokerOrderId: order.brokerOrderId,
        mode: this.broker.mode,
        clientOrderId,
      });

      return { ok: true, order };
    } catch (e) {
      // Any failure releases the reservation. Leaving cash committed to an
      // order that never existed is how a ledger drifts.
      this.ledger.releaseReservation(capital, proposal.proposalId, 'Entry submission failed');
      const detail = e instanceof Error ? e.message : String(e);
      order.status = 'REJECTED';
      order.rejectReason = detail;
      order.updatedAt = this.clock.nowIso();
      this.store.orders.save(order);
      this.store.proposals.setStatus(proposal.proposalId, 'FAILED');
      this.log.error('entry submission failed', { proposalId: proposal.proposalId, detail });
      this.logDecision(proposal, 'ORDER', `Entry submission failed: ${detail}`, { kind: e instanceof BrokerError ? e.kind : 'UNKNOWN' });
      return { ok: false, reason: 'BROKER_ERROR', detail };
    }
  }

  /**
   * Submit an exit for an open position.
   *
   * Risk-reducing, so it does not sit behind the approval gate by default.
   */
  async submitExit(position: Position, reason: ExitReason, note: string): Promise<SubmitOutcome> {
    if (position.status === 'CLOSED') {
      return { ok: false, reason: 'DUPLICATE', detail: 'Position is already closed' };
    }
    if (position.exitOrderId) {
      const existing = this.store.orders.byId(position.exitOrderId);
      if (existing && existing.status !== 'REJECTED' && existing.status !== 'CANCELLED') {
        return { ok: false, reason: 'DUPLICATE', detail: `Exit order ${existing.orderId} already in flight` };
      }
    }

    if (this.broker.mode === 'LIVE' && this.requireApprovalForLiveExits) {
      return {
        ok: false,
        reason: 'NO_APPROVAL',
        detail: 'LIVE exits require explicit approval under the current configuration',
      };
    }

    /*
     * A rejected exit must be retryable, so the idempotency key carries an
     * attempt number. Without it the key is identical on every attempt and a
     * stop-loss that the broker bounced once could never be re-sent — the
     * position would be stuck open with its risk rule permanently disarmed.
     *
     * Retries stay controlled: the exit engine fires at most once per cycle,
     * every attempt is persisted, and the in-flight check above prevents a
     * second order while one is still live.
     */
    const priorAttempts = this.store.orders.byPosition(position.positionId).filter((o) => o.intent === 'EXIT').length;
    const clientOrderId = exitClientOrderId(position, reason, priorAttempts);
    const existingOrder = this.store.orders.byClientOrderId(clientOrderId);
    if (existingOrder) {
      return { ok: false, reason: 'DUPLICATE', detail: `Exit order ${existingOrder.orderId} already exists` };
    }
    if (priorAttempts > 0) {
      this.log.warn('retrying a previously failed exit', {
        positionId: position.positionId,
        ticker: position.ticker,
        reason,
        attempt: priorAttempts + 1,
      });
    }

    const now = this.clock.nowIso();
    const order: Order = {
      orderId: deterministicId('ord', position.positionId, 'EXIT', reason, String(priorAttempts)),
      brokerOrderId: null,
      strategyId: position.strategyId,
      proposalId: null,
      positionId: position.positionId,
      securityId: position.securityId,
      ticker: position.ticker,
      side: 'SELL',
      quantity: position.quantity,
      notionalCents: null,
      type: 'MARKET',
      timeInForce: 'DAY',
      mode: this.broker.mode,
      status: 'NEW',
      submittedAt: now,
      updatedAt: now,
      filledQuantity: 0,
      filledAvgPrice: null,
      clientOrderId,
      rejectReason: null,
      intent: 'EXIT',
      correlationId: position.entryProposalId,
    };

    try {
      const brokerOrder = await this.broker.submitOrder({
        clientOrderId,
        ticker: position.ticker,
        side: 'SELL',
        quantity: position.quantity,
        type: 'MARKET',
        timeInForce: 'DAY',
      });

      order.brokerOrderId = brokerOrder.brokerOrderId;
      order.status = brokerOrder.status;
      order.updatedAt = this.clock.nowIso();
      this.store.orders.save(order);

      this.store.positions.save({
        ...position,
        status: 'CLOSING',
        exitOrderId: order.orderId,
        exitReason: reason,
        exitNote: note,
      });

      this.store.log.append({
        correlationId: order.correlationId,
        strategyId: position.strategyId,
        stage: 'EXIT',
        subjectId: position.positionId,
        summary: `Exit submitted for ${position.ticker}: ${reason}`,
        payload: {
          reason, note, orderId: order.orderId, quantity: position.quantity,
          mode: this.broker.mode, attempt: priorAttempts + 1,
        },
      });

      return { ok: true, order };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      order.status = 'REJECTED';
      order.rejectReason = detail;
      order.updatedAt = this.clock.nowIso();
      this.store.orders.save(order);
      this.log.error('exit submission failed', { positionId: position.positionId, detail });
      this.store.log.append({
        correlationId: order.correlationId,
        strategyId: position.strategyId,
        stage: 'EXIT',
        subjectId: position.positionId,
        summary: `Exit submission failed for ${position.ticker}: ${detail}`,
        payload: { reason, detail },
      });
      return { ok: false, reason: 'BROKER_ERROR', detail };
    }
  }

  /** Cancel every in-flight strategy order. Used by the kill switch. */
  async cancelOpenOrders(strategyId: string): Promise<{ cancelled: string[]; failed: string[] }> {
    const cancelled: string[] = [];
    const failed: string[] = [];
    for (const order of this.store.orders.open(strategyId)) {
      if (!order.brokerOrderId) {
        this.store.orders.save({ ...order, status: 'CANCELLED', updatedAt: this.clock.nowIso() });
        cancelled.push(order.orderId);
        continue;
      }
      try {
        await this.broker.cancelOrder(order.brokerOrderId);
        this.store.orders.save({ ...order, status: 'CANCELLED', updatedAt: this.clock.nowIso() });
        if (order.intent === 'ENTRY' && order.proposalId) {
          this.ledger.settleReservation(order.proposalId, 0, 'Order cancelled by the kill switch');
        }
        cancelled.push(order.orderId);
      } catch (e) {
        this.log.warn('order cancellation failed', {
          orderId: order.orderId,
          detail: e instanceof Error ? e.message : String(e),
        });
        failed.push(order.orderId);
      }
    }
    return { cancelled, failed };
  }

  /* ------------------------------------------------------- the live gate */

  /**
   * The single enforcement point for live human approval.
   *
   * Requires an ApprovalRecord that is APPROVED, not superseded by a later
   * rejection, and whose fingerprint matches the terms about to be submitted.
   */
  private assertLiveApproval(proposal: TradeProposal, expectedFingerprint: string): LiveGateResult {
    const approval = this.store.approvals.latestForProposal(proposal.proposalId);

    if (!approval) {
      this.log.warn('LIVE order blocked: no approval on record', { proposalId: proposal.proposalId });
      return {
        allowed: false,
        reason: 'NO_APPROVAL',
        detail: 'LIVE mode requires an explicit human approval for this proposal; none exists.',
      };
    }
    if (approval.decision !== 'APPROVED') {
      return { allowed: false, reason: 'NO_APPROVAL', detail: `Proposal was ${approval.decision} by ${approval.decidedBy}` };
    }
    if (approval.approvalFingerprint !== expectedFingerprint) {
      // The approved trade is not this trade.
      this.store.proposals.setStatus(proposal.proposalId, 'INVALIDATED');
      this.log.warn('LIVE order blocked: approval fingerprint mismatch', {
        proposalId: proposal.proposalId,
      });
      return {
        allowed: false,
        reason: 'INVALIDATED',
        detail:
          'The approved terms no longer match the current proposal (price, size or signal changed). ' +
          'A fresh proposal and approval are required.',
      };
    }
    return { allowed: true };
  }

  /* -------------------------------------------------------------- drift */

  private async checkDrift(proposal: TradeProposal): Promise<{ ok: boolean; detail: string; driftPct: number }> {
    try {
      const quote = await this.marketData.getQuote(proposal.ticker);
      const driftPct = Math.abs(((quote.price - proposal.referencePrice) / proposal.referencePrice) * 100);
      if (quote.stale) {
        return { ok: false, detail: `Market data is stale (${quote.ageMinutes.toFixed(0)} minutes old)`, driftPct };
      }
      if (driftPct > this.driftTolerancePct) {
        return {
          ok: false,
          detail:
            `Price moved ${driftPct.toFixed(2)}% from the proposed ${proposal.referencePrice.toFixed(2)} ` +
            `to ${quote.price.toFixed(2)}, beyond the ${this.driftTolerancePct}% tolerance`,
          driftPct,
        };
      }
      return { ok: true, detail: `Price within ${driftPct.toFixed(2)}% of the proposal`, driftPct };
    } catch (e) {
      return {
        ok: false,
        detail: `Could not verify current price: ${e instanceof Error ? e.message : String(e)}`,
        driftPct: 0,
      };
    }
  }

  private logDecision(proposal: TradeProposal, stage: 'ORDER', summary: string, payload: Record<string, unknown>): void {
    this.store.log.append({
      correlationId: proposal.correlationId,
      strategyId: proposal.strategyId,
      stage,
      subjectId: proposal.proposalId,
      summary,
      payload,
    });
  }
}

/** Deterministic per-proposal idempotency key. */
export function entryClientOrderId(proposal: TradeProposal): string {
  return `ns-entry-${proposal.proposalId}`;
}

export function exitClientOrderId(position: Position, reason: ExitReason, attempt = 0): string {
  return `ns-exit-${position.positionId}-${reason.toLowerCase()}-${attempt}`;
}

/** Cost of a fill in cents, for the ledger. */
export function fillCostCents(quantity: number, price: number): Cents {
  return positionValueCents(quantity, price);
}

export { centsToDollars, randomId };
