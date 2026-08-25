/**
 * Human approval for LIVE orders.
 *
 * The approval flow is:
 *
 *   present(proposalId)  -> everything the user needs to decide, including the
 *                           exact fingerprint of what they are approving
 *   approve(...)         -> records the decision, then asks the OrderRouter to
 *                           submit; the router independently re-checks the gate
 *   reject(...)          -> records the decision and closes the proposal
 *
 * The service never submits an order itself. It records a decision and calls
 * the router, which verifies the approval again from persisted state. Two
 * independent checks of the same fact is the point.
 */
import type { Clock, Logger } from '../core/index.js';
import { formatSignedUsd, formatUsd, randomId } from '../core/index.js';
import type { ApprovalRecord, Position, TradeProposal, XSignal } from '../domain/types.js';
import type { Store } from '../persistence/store.js';
import { fingerprintTerms, termsFor } from '../pipeline/proposal.js';
import type { CapitalLedgerService } from '../pipeline/ledger.js';
import type { OrderRouter, SubmitOutcome } from '../pipeline/execution/OrderRouter.js';

export interface ApprovalPresentation {
  proposalId: string;
  ticker: string;
  companyName: string;
  direction: string;
  side: string;
  dollarAmount: string;
  dollarAmountCents: number;
  approximateShares: number;
  referencePrice: number;
  currentPrice: number | null;
  priceDriftPct: number | null;
  signal: {
    signalId: string;
    score: number;
    band: string;
    uncertainty: number;
    explanation: string;
  };
  reasoning: string;
  sources: {
    handle: string;
    tier: string;
    postedAt: string;
    excerpt: string;
    url: string;
    sentiment: number;
  }[];
  contradictoryEvidence: string[];
  strategyPnl: {
    startingCapital: string;
    cash: string;
    positionsValue: string;
    unrealised: string;
    realised: string;
    equity: string;
    totalReturnPct: number;
  };
  resultingExposure: {
    openPositions: number;
    maxPositions: number;
    currentExposurePct: number;
    exposureAfterPct: number;
    positionSizePctOfEquity: number;
    maxPositionPct: number;
  };
  riskImpact: {
    approved: boolean;
    summary: string;
    checks: { check: string; passed: boolean; detail: string }[];
    drawdownPct: number;
    maxDrawdownPct: number;
    dailyLossPct: number;
    maxDailyLossPct: number;
  };
  invalidationCondition: string;
  expiresAt: string;
  /** The exact terms this approval binds to. */
  approvalFingerprint: string;
  /** False when the proposal can no longer be approved (expired, superseded). */
  actionable: boolean;
  blockReason: string | null;
}

export class ApprovalService {
  private readonly log: Logger;

  constructor(
    private readonly store: Store,
    private readonly ledger: CapitalLedgerService,
    private readonly router: OrderRouter,
    private readonly clock: Clock,
    logger: Logger,
    private readonly companyNameFor: (securityId: string) => string,
  ) {
    this.log = logger.child('approvals');
  }

  /** Everything a user must see before approving. */
  present(proposalId: string, currentPrice: number | null): ApprovalPresentation | null {
    const proposal = this.store.proposals.byId(proposalId);
    if (!proposal) return null;
    const signal = this.store.signals.byId(proposal.signalId);
    if (!signal) return null;

    const strategy = this.store.strategies.byId(proposal.strategyId);
    const risk = proposal.riskDecisionId ? this.store.risk.byId(proposal.riskDecisionId) : null;
    const ledger = this.ledger.get();
    const openPositions = this.store.positions.open(proposal.strategyId);

    const limits = strategy?.riskLimits;
    const positionsValue = openPositions.reduce((a: number, p: Position) => a + p.quantity * p.lastMarkPrice * 100, 0);
    const exposureNow = ledger.equityCents > 0 ? (positionsValue / ledger.equityCents) * 100 : 0;
    const exposureAfter =
      ledger.equityCents > 0 ? ((positionsValue + proposal.proposedCapitalCents) / ledger.equityCents) * 100 : 0;

    const driftPct =
      currentPrice !== null && proposal.referencePrice > 0
        ? ((currentPrice - proposal.referencePrice) / proposal.referencePrice) * 100
        : null;

    const expired = new Date(proposal.expiresAt).getTime() <= this.clock.nowMs();
    const fingerprint = fingerprintTerms(termsFor(proposal, signal.score));
    const fingerprintMatches = fingerprint === proposal.approvalFingerprint;

    let blockReason: string | null = null;
    if (expired) blockReason = 'This proposal has expired and must be regenerated.';
    else if (!fingerprintMatches) blockReason = 'The proposal terms have changed since it was created.';
    else if (proposal.status !== 'AWAITING_APPROVAL' && proposal.status !== 'PENDING_RISK') {
      blockReason = `Proposal is ${proposal.status.replace(/_/g, ' ').toLowerCase()} and cannot be approved.`;
    } else if (risk && !risk.approved) blockReason = `Risk rejected this proposal: ${risk.summary}`;

    return {
      proposalId: proposal.proposalId,
      ticker: proposal.ticker,
      companyName: this.companyNameFor(proposal.securityId),
      direction: proposal.direction,
      side: proposal.side,
      dollarAmount: formatUsd(proposal.proposedCapitalCents),
      dollarAmountCents: proposal.proposedCapitalCents,
      approximateShares: proposal.proposedQuantity,
      referencePrice: proposal.referencePrice,
      currentPrice,
      priceDriftPct: driftPct === null ? null : Number(driftPct.toFixed(3)),
      signal: {
        signalId: signal.signalId,
        score: signal.score,
        band: signal.band,
        uncertainty: signal.uncertainty,
        explanation: signal.explanation,
      },
      reasoning: proposal.rationale,
      sources: signal.evidence.map((e) => ({
        handle: e.authorHandle,
        tier: e.sourceTier.replace('_', ' '),
        postedAt: e.postedAt,
        excerpt: e.excerpt,
        url: e.url,
        sentiment: e.sentiment,
      })),
      contradictoryEvidence: signal.contradictoryEvidence,
      strategyPnl: {
        startingCapital: formatUsd(ledger.startingCapitalCents),
        cash: formatUsd(ledger.cashCents),
        positionsValue: formatUsd(ledger.positionsValueCents),
        unrealised: formatSignedUsd(ledger.unrealisedPnlCents),
        realised: formatSignedUsd(ledger.realisedPnlCents),
        equity: formatUsd(ledger.equityCents),
        totalReturnPct: Number(this.ledger.totalReturnPct().toFixed(3)),
      },
      resultingExposure: {
        openPositions: openPositions.length,
        maxPositions: limits?.maxConcurrentPositions ?? 0,
        currentExposurePct: Number(exposureNow.toFixed(2)),
        exposureAfterPct: Number(exposureAfter.toFixed(2)),
        positionSizePctOfEquity:
          ledger.equityCents > 0 ? Number(((proposal.proposedCapitalCents / ledger.equityCents) * 100).toFixed(2)) : 0,
        maxPositionPct: limits?.maxPositionPctOfEquity ?? 0,
      },
      riskImpact: {
        approved: risk?.approved ?? false,
        summary: risk?.summary ?? 'No risk decision recorded yet',
        checks: (risk?.checks ?? []).map((c) => ({ check: c.check, passed: c.passed, detail: c.detail })),
        drawdownPct: Number(this.ledger.drawdownPct().toFixed(2)),
        maxDrawdownPct: limits?.maxDrawdownPct ?? 0,
        dailyLossPct: Number(this.ledger.dailyLossPct().toFixed(2)),
        maxDailyLossPct: limits?.maxDailyLossPct ?? 0,
      },
      invalidationCondition: proposal.invalidationCondition.description,
      expiresAt: proposal.expiresAt,
      approvalFingerprint: fingerprint,
      actionable: blockReason === null,
      blockReason,
    };
  }

  /**
   * Approve a proposal and attempt submission.
   *
   * `expectedFingerprint` is the fingerprint the UI displayed. If it no longer
   * matches, the approval is refused: the user would be approving a different
   * trade from the one they were shown.
   */
  async approve(
    proposalId: string,
    decidedBy: string,
    expectedFingerprint: string,
    note = '',
  ): Promise<{ ok: boolean; detail: string; outcome?: SubmitOutcome }> {
    const proposal = this.store.proposals.byId(proposalId);
    if (!proposal) return { ok: false, detail: 'Proposal not found' };

    const signal = this.store.signals.byId(proposal.signalId);
    if (!signal) return { ok: false, detail: 'Signal for this proposal is missing' };

    const currentFingerprint = fingerprintTerms(termsFor(proposal, signal.score));
    if (expectedFingerprint !== currentFingerprint) {
      this.store.proposals.setStatus(proposalId, 'INVALIDATED');
      this.log.warn('approval refused: terms changed since display', { proposalId });
      return {
        ok: false,
        detail:
          'The proposal changed since it was displayed (price, size or signal moved). ' +
          'It has been invalidated; a fresh proposal will be generated.',
      };
    }

    if (new Date(proposal.expiresAt).getTime() <= this.clock.nowMs()) {
      this.store.proposals.setStatus(proposalId, 'EXPIRED');
      return { ok: false, detail: 'Proposal expired before approval' };
    }

    const risk = proposal.riskDecisionId ? this.store.risk.byId(proposal.riskDecisionId) : null;
    if (!risk || !risk.approved) {
      return { ok: false, detail: `Risk has not approved this proposal: ${risk?.summary ?? 'no decision on record'}` };
    }

    const approval: ApprovalRecord = {
      approvalId: randomId('appr'),
      proposalId,
      decision: 'APPROVED',
      decidedBy,
      decidedAt: this.clock.nowIso(),
      approvalFingerprint: currentFingerprint,
      note,
    };
    this.store.approvals.save(approval);
    this.store.proposals.setStatus(proposalId, 'APPROVED');

    this.store.log.append({
      correlationId: proposal.correlationId,
      strategyId: proposal.strategyId,
      stage: 'APPROVAL',
      subjectId: proposalId,
      summary: `APPROVED by ${decidedBy}: ${proposal.ticker} ${formatUsd(proposal.proposedCapitalCents)}`,
      payload: { approvalId: approval.approvalId, fingerprint: currentFingerprint, note },
    });

    // The router re-verifies the approval, the fingerprint, the expiry and the
    // price drift from persisted state before anything reaches the broker.
    const outcome = await this.router.submitEntry(proposal, risk, signal);
    return {
      ok: outcome.ok,
      detail: outcome.ok ? `Order submitted for ${proposal.ticker}` : `${outcome.reason}: ${outcome.detail}`,
      outcome,
    };
  }

  reject(proposalId: string, decidedBy: string, note = ''): { ok: boolean; detail: string } {
    const proposal = this.store.proposals.byId(proposalId);
    if (!proposal) return { ok: false, detail: 'Proposal not found' };

    const signal = this.store.signals.byId(proposal.signalId);
    const approval: ApprovalRecord = {
      approvalId: randomId('appr'),
      proposalId,
      decision: 'REJECTED',
      decidedBy,
      decidedAt: this.clock.nowIso(),
      approvalFingerprint: signal ? fingerprintTerms(termsFor(proposal, signal.score)) : proposal.approvalFingerprint,
      note,
    };
    this.store.approvals.save(approval);
    this.store.proposals.setStatus(proposalId, 'REJECTED_BY_USER');

    this.store.log.append({
      correlationId: proposal.correlationId,
      strategyId: proposal.strategyId,
      stage: 'APPROVAL',
      subjectId: proposalId,
      summary: `REJECTED by ${decidedBy}: ${proposal.ticker}`,
      payload: { approvalId: approval.approvalId, note },
    });

    return { ok: true, detail: `Rejected ${proposal.ticker}` };
  }

  /** Proposals a user still needs to decide on. */
  pending(): TradeProposal[] {
    return this.store.proposals
      .byStatus('AWAITING_APPROVAL')
      .filter((p) => new Date(p.expiresAt).getTime() > this.clock.nowMs());
  }

  signalFor(proposal: TradeProposal): XSignal | null {
    return this.store.signals.byId(proposal.signalId);
  }
}
