/**
 * Signal audit.
 *
 * Assembles the complete evidential record behind one signal: the posts, who
 * posted them and at what tier, how confidently they were resolved to a
 * security, every scored dimension with the points it contributed, the market
 * data used for confirmation — and, crucially, what became of the signal and
 * why.
 *
 * "Why did this NOT trade?" is answered from the recorded disposition rather
 * than reconstructed from thresholds, so the answer stays correct even after
 * the strategy version's limits have moved on.
 */
import type { Store } from '../persistence/store.js';
import type {
  ApprovalRecord,
  Order,
  Position,
  RiskDecision,
  SignalDisposition,
  SocialEvent,
  TickerResolution,
  TradeProposal,
  XSignal,
} from '../domain/types.js';

export interface AuditSource {
  eventId: string;
  postId: string;
  handle: string;
  displayName: string;
  sourceTier: string;
  sourceClass: string;
  postedAt: string;
  capturedAt: string;
  url: string;
  text: string;
  /** Evidence weight the filter allowed this post to carry. */
  weight: number;
  filterVerdict: string | null;
  filterReasons: string[];
  sentiment: number;
  eventType: string;
  engagement: SocialEvent['engagement'];
  /** Entity resolution for THIS post to the signal's security. */
  resolution: {
    method: string;
    confidence: number;
    matchedText: string;
    competingSecurityIds: string[];
    notes: string[];
  } | null;
}

export interface AuditOutcome {
  disposition: SignalDisposition | 'NO_RECORD';
  detail: string;
  at: string | null;
  proposal: TradeProposal | null;
  riskDecision: RiskDecision | null;
  approval: ApprovalRecord | null;
  orders: Order[];
  position: Position | null;
  /** Plain-English chain, one line per step actually taken. */
  narrative: string[];
}

export interface SignalAuditView {
  signal: XSignal;
  sources: AuditSource[];
  /** Score dimensions with the points each was worth. */
  components: {
    name: string;
    value: number;
    directional: boolean;
    contributionPoints: number;
    explanation: string;
  }[];
  resolution: {
    minConfidence: number;
    tradableThreshold: number;
    passesThreshold: boolean;
    perEvent: TickerResolution[];
  };
  priceConfirmation: XSignal['priceConfirmationDetail'];
  uncertainty: number;
  supportingEvidence: string[];
  contradictoryEvidence: string[];
  outcome: AuditOutcome;
  forwardReturns: { horizon: string; forwardReturnPct: number | null; excessReturnPct: number | null; hit: boolean | null }[];
}

const DIRECTIONAL = new Set(['sentiment', 'priceConfirmation']);

export class SignalAuditService {
  constructor(
    private readonly store: Store,
    private readonly minResolutionConfidence: number,
  ) {}

  audit(signalId: string): SignalAuditView | null {
    const signal = this.store.signals.byId(signalId);
    if (!signal) return null;

    const events = this.store.events.byIds(signal.triggeringEventIds);
    const resolutions = this.store.resolutions.byEvents(signal.triggeringEventIds);
    const forSecurity = resolutions.filter((r) => r.securityId === signal.securityId);

    const evidenceByEvent = new Map(signal.evidence.map((e) => [e.eventId, e]));

    const sources: AuditSource[] = events.map((event) => {
      const filter = this.store.filters.byEvent(event.eventId);
      const evidence = evidenceByEvent.get(event.eventId);
      const resolution = forSecurity.find((r) => r.eventId === event.eventId) ?? null;
      const author = this.store.authors.byId(event.authorId);

      return {
        eventId: event.eventId,
        postId: event.postId,
        handle: event.authorHandle,
        displayName: author?.displayName ?? event.authorDisplayName,
        sourceTier: event.sourceTier,
        sourceClass: event.sourceClass,
        postedAt: event.postedAt,
        capturedAt: event.capturedAt,
        url: event.url,
        text: event.text,
        weight: evidence?.weight ?? filter?.weight ?? 0,
        filterVerdict: filter?.verdict ?? null,
        filterReasons: filter?.reasons ?? [],
        sentiment: evidence?.sentiment ?? 0,
        eventType: evidence?.eventType ?? 'GENERAL_COMMENTARY',
        engagement: event.engagement,
        resolution: resolution
          ? {
              method: resolution.method,
              confidence: resolution.confidence,
              matchedText: resolution.matchedText,
              competingSecurityIds: resolution.competingSecurityIds,
              notes: resolution.notes,
            }
          : null,
      };
    });

    const contributionByComponent = new Map(
      signal.contributions.map((c) => [String(c.component), c]),
    );

    const components = (Object.keys(signal.components) as (keyof XSignal['components'])[]).map((name) => {
      const contribution = contributionByComponent.get(name);
      return {
        name,
        value: signal.components[name],
        directional: DIRECTIONAL.has(name),
        contributionPoints: contribution?.contribution ?? 0,
        explanation: contribution?.explanation ?? '',
      };
    });

    return {
      signal,
      sources,
      components,
      resolution: {
        minConfidence: signal.resolutionConfidence,
        tradableThreshold: this.minResolutionConfidence,
        passesThreshold: signal.resolutionConfidence >= this.minResolutionConfidence,
        perEvent: forSecurity,
      },
      priceConfirmation: signal.priceConfirmationDetail,
      uncertainty: signal.uncertainty,
      supportingEvidence: signal.supportingEvidence,
      contradictoryEvidence: signal.contradictoryEvidence,
      outcome: this.outcomeFor(signal),
      forwardReturns: this.store.outcomes.forSignal(signalId).map((o) => ({
        horizon: o.horizon,
        forwardReturnPct: o.forwardReturnPct,
        excessReturnPct: o.excessReturnPct,
        hit: o.hit,
      })),
    };
  }

  /** What became of this signal, and the chain of records that proves it. */
  private outcomeFor(signal: XSignal): AuditOutcome {
    // The disposition is recorded against the signal id at the PROPOSAL stage.
    // Take the most recent, which reflects how far the signal actually got.
    const entries = this.store.log
      .byStage(signal.strategyId, 'PROPOSAL', 2000)
      .filter((e) => e.subjectId === signal.signalId);
    const latest = entries[0] ?? null;

    const disposition = (latest?.payload?.['disposition'] as SignalDisposition | undefined) ?? 'NO_RECORD';
    const detail = String(latest?.payload?.['detail'] ?? 'No disposition was recorded for this signal.');

    const proposal =
      this.store.proposals.bySignal(signal.signalId)[0] ??
      (latest?.payload?.['proposalId']
        ? this.store.proposals.byId(String(latest.payload['proposalId']))
        : null);

    const riskDecision = proposal ? this.store.risk.byProposal(proposal.proposalId) : null;
    const approval = proposal ? this.store.approvals.latestForProposal(proposal.proposalId) : null;
    const orders = proposal ? this.store.orders.byProposal(proposal.proposalId) : [];

    let position: Position | null = null;
    for (const order of orders) {
      if (order.positionId) {
        position = this.store.positions.byId(order.positionId);
        if (position) break;
      }
    }

    const narrative: string[] = [
      `Signal ${signal.score >= 0 ? '+' : ''}${signal.score} (${signal.band}) on ${signal.ticker} from ` +
      `${signal.sourceCount} post(s), ${signal.independentSourceCount.toFixed(2)} tier-weighted independent sources.`,
      `Disposition: ${disposition} — ${detail}`,
    ];

    if (riskDecision) {
      narrative.push(
        riskDecision.approved
          ? `Risk approved ${(riskDecision.permittedCapitalCents / 100).toFixed(2)} USD (${riskDecision.checks.length} checks).`
          : `Risk rejected it: ${riskDecision.failedChecks.join(', ')}.`,
      );
    }
    if (approval) {
      narrative.push(`Human ${approval.decision} by ${approval.decidedBy} at ${approval.decidedAt}.`);
    }
    for (const order of orders) {
      narrative.push(
        `Order ${order.orderId} (${order.intent}, ${order.mode}) is ${order.status}` +
        `${order.rejectReason ? ` — ${order.rejectReason}` : ''}.`,
      );
    }
    if (position) {
      narrative.push(
        position.status === 'CLOSED'
          ? `Position closed at ${position.exitPrice?.toFixed(2)} for ${((position.realisedPnlCents ?? 0) / 100).toFixed(2)} USD (${position.exitReason}).`
          : `Position open: ${position.quantity} @ ${position.entryPrice.toFixed(2)}, marked ${position.lastMarkPrice.toFixed(2)}.`,
      );
    }

    return {
      disposition,
      detail,
      at: latest?.at ?? null,
      proposal,
      riskDecision,
      approval,
      orders,
      position,
      narrative,
    };
  }
}
