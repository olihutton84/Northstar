/**
 * Trade proposal layer.
 *
 * A strong signal produces a PROPOSAL, never an order. The proposal is a
 * complete, self-describing intent: what, how much, at what price, why, on what
 * evidence, until when, and what would void the thesis.
 *
 * v1 is LONG ONLY. There is no short path, no options path, and the domain type
 * for direction has a single member so adding one is a deliberate type change.
 */
import type { Clock, Logger } from '../core/index.js';
import type { Cents } from '../core/index.js';
import { clamp, deterministicId, formatUsd, quantityForCents, randomId, sha256 } from '../core/index.js';
import type { ExitRuleConfig } from '../config/strategyRegistry.js';
import type {
  InvalidationCondition,
  Quote,
  Security,
  Strategy,
  TradeProposal,
  XSignal,
} from '../domain/types.js';
import { bandLabel } from './signal/composite.js';

export interface ProposalBuilderOptions {
  clock: Clock;
  logger: Logger;
  exitRules: ExitRuleConfig;
  /** How long a proposal stays valid before it must be regenerated. */
  proposalTtlMinutes?: number;
}

export interface BuildProposalInput {
  signal: XSignal;
  security: Security;
  strategy: Strategy;
  quote: Quote;
  /** Equity used for position sizing, in cents. */
  equityCents: Cents;
  /** Cash the strategy can actually deploy right now, in cents. */
  availableCents: Cents;
  correlationId?: string;
}

/**
 * The exact terms a user approves.
 *
 * Anything in this object changing between display and submission invalidates
 * the approval. Note what is included: price, quantity, capital and the signal
 * score. A price move that changes the share count is a different trade.
 */
export interface ApprovalTerms {
  proposalId: string;
  ticker: string;
  side: string;
  capitalCents: Cents;
  quantity: number;
  referencePrice: number;
  signalId: string;
  signalScore: number;
}

export function fingerprintTerms(terms: ApprovalTerms): string {
  return sha256(
    JSON.stringify({
      proposalId: terms.proposalId,
      ticker: terms.ticker,
      side: terms.side,
      capitalCents: terms.capitalCents,
      quantity: Number(terms.quantity.toFixed(6)),
      referencePrice: Number(terms.referencePrice.toFixed(4)),
      signalId: terms.signalId,
      signalScore: terms.signalScore,
    }),
  ).slice(0, 32);
}

export function termsFor(proposal: TradeProposal, signalScore: number): ApprovalTerms {
  return {
    proposalId: proposal.proposalId,
    ticker: proposal.ticker,
    side: proposal.side,
    capitalCents: proposal.proposedCapitalCents,
    quantity: proposal.proposedQuantity,
    referencePrice: proposal.referencePrice,
    signalId: proposal.signalId,
    signalScore,
  };
}

export class ProposalBuilder {
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly exitRules: ExitRuleConfig;
  private readonly ttlMinutes: number;

  constructor(opts: ProposalBuilderOptions) {
    this.clock = opts.clock;
    this.log = opts.logger.child('proposal');
    this.exitRules = opts.exitRules;
    this.ttlMinutes = opts.proposalTtlMinutes ?? 15;
  }

  /**
   * Size and build a proposal.
   *
   * Sizing is deliberately simple and conservative:
   *   target = maxPositionPct of equity, scaled by signal conviction
   *   capped by the strategy's available cash
   *
   * Conviction scaling means a +90 signal deploys the full slot while a +40
   * signal deploys roughly half of it, so the $50 is not spent on the first
   * marginal idea of the day.
   */
  build(input: BuildProposalInput): TradeProposal | null {
    const { signal, security, strategy, quote } = input;
    const limits = strategy.riskLimits;

    if (signal.score <= 0) {
      // LONG ONLY: a bearish signal on a security we do not hold is not a
      // trade. (Exits of existing positions are handled by the exit engine.)
      return null;
    }

    const maxSlotCents = Math.floor((input.equityCents * limits.maxPositionPctOfEquity) / 100);
    // Conviction ramp: minSignalScore -> 50% of the slot, 100 -> 100%.
    const span = Math.max(1, 100 - limits.minSignalScore);
    const convictionRatio = clamp(0.5 + (0.5 * (signal.score - limits.minSignalScore)) / span, 0.25, 1);
    // Uncertainty haircut: thin evidence gets a smaller position, never a
    // bigger one.
    const certaintyRatio = clamp(1 - signal.uncertainty * 0.5, 0.5, 1);

    const targetCents = Math.floor(maxSlotCents * convictionRatio * certaintyRatio);
    const capitalCents = Math.min(targetCents, input.availableCents, maxSlotCents);

    if (capitalCents < limits.minOrderCents) {
      this.log.info('proposal skipped: below minimum order size', {
        ticker: security.ticker,
        capitalCents,
        minOrderCents: limits.minOrderCents,
      });
      return null;
    }

    if (quote.price <= 0) return null;

    const quantity = security.alpacaFractionable
      ? quantityForCents(capitalCents, quote.price)
      : Math.floor(capitalCents / 100 / quote.price);

    if (quantity <= 0) {
      this.log.info('proposal skipped: capital buys zero shares', {
        ticker: security.ticker,
        capitalCents,
        price: quote.price,
        fractionable: security.alpacaFractionable,
      });
      return null;
    }

    const createdAt = this.clock.nowIso();
    const expiresAt = new Date(this.clock.nowMs() + this.ttlMinutes * 60_000).toISOString();
    const proposalId = deterministicId('prop', strategy.strategyId, signal.signalId, createdAt);
    const correlationId = input.correlationId ?? randomId('corr');

    const invalidationCondition: InvalidationCondition = {
      description:
        `Thesis void if the live ${security.ticker} signal falls to ${this.exitRules.signalReversalBelow} or below, ` +
        `if price drops ${this.exitRules.stopLossPct}% from entry, or after ${this.exitRules.thesisExpiryHours}h.`,
      signalReversalBelow: this.exitRules.signalReversalBelow,
      stopLossPct: this.exitRules.stopLossPct,
      thesisExpiryHours: this.exitRules.thesisExpiryHours,
      maxHoldingHours: this.exitRules.maxHoldingHours,
    };

    // Confidence blends signal strength with evidence quality. It is NOT the
    // signal score: a +95 score on one anonymous post is not a confident trade.
    const confidence = Number(
      clamp(
        (Math.abs(signal.score) / 100) * 0.5 +
          (1 - signal.uncertainty) * 0.3 +
          signal.resolutionConfidence * 0.2,
        0,
        1,
      ).toFixed(4),
    );

    const proposal: TradeProposal = {
      proposalId,
      strategyId: strategy.strategyId,
      strategyVersion: strategy.version,
      signalId: signal.signalId,
      securityId: security.securityId,
      ticker: security.ticker,
      direction: 'LONG',
      side: 'BUY',
      proposedCapitalCents: capitalCents,
      proposedQuantity: quantity,
      fractional: security.alpacaFractionable,
      referencePrice: quote.price,
      referencePriceAsOf: quote.asOf,
      confidence,
      rationale: this.rationale(signal, security, capitalCents, quantity, quote, convictionRatio, certaintyRatio),
      evidenceSummary: [
        ...signal.supportingEvidence.slice(0, 4),
        ...signal.contradictoryEvidence.slice(0, 2).map((c) => `AGAINST: ${c}`),
      ],
      createdAt,
      expiresAt,
      status: 'PENDING_RISK',
      mode: strategy.mode,
      riskDecisionId: null,
      invalidationCondition,
      approvalFingerprint: '',
      correlationId,
    };

    proposal.approvalFingerprint = fingerprintTerms(termsFor(proposal, signal.score));
    return proposal;
  }

  /** Re-sizes a proposal after the risk engine trims the permitted capital. */
  resize(proposal: TradeProposal, permittedCapitalCents: Cents, signalScore: number): TradeProposal {
    const quantity = proposal.fractional
      ? quantityForCents(permittedCapitalCents, proposal.referencePrice)
      : Math.floor(permittedCapitalCents / 100 / proposal.referencePrice);
    const resized: TradeProposal = {
      ...proposal,
      proposedCapitalCents: permittedCapitalCents,
      proposedQuantity: quantity,
    };
    resized.approvalFingerprint = fingerprintTerms(termsFor(resized, signalScore));
    return resized;
  }

  private rationale(
    signal: XSignal,
    security: Security,
    capitalCents: Cents,
    quantity: number,
    quote: Quote,
    convictionRatio: number,
    certaintyRatio: number,
  ): string {
    return [
      `${bandLabel(signal.band)} (${signal.score >= 0 ? '+' : ''}${signal.score}) on ${security.ticker} ` +
        `(${security.companyName}) from ${signal.sourceCount} post(s) across ` +
        `${signal.independentSourceCount.toFixed(2)} tier-weighted independent sources.`,
      signal.explanation,
      `Sizing: ${formatUsd(capitalCents)} (~${quantity.toFixed(6)} shares at ${quote.price.toFixed(2)}), ` +
        `being ${(convictionRatio * 100).toFixed(0)}% of the position slot for conviction and ` +
        `${(certaintyRatio * 100).toFixed(0)}% for evidence quality (uncertainty ${(signal.uncertainty * 100).toFixed(0)}%).`,
    ].join(' ');
  }
}
