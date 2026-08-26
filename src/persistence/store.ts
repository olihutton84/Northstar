/**
 * Repositories.
 *
 * One `Store` owns every table. Domain objects go in and come out; SQL and JSON
 * column encoding stay here, so no other layer knows the storage shape.
 */
import type { Clock } from '../core/index.js';
import { deterministicId, randomId } from '../core/index.js';
import type {
  ApprovalRecord,
  CapitalLedger,
  DecisionLogEntry,
  DecisionStage,
  ExecutionEpoch,
  ManualObservation,
  Fill,
  FilterResult,
  HealthIncident,
  LedgerEntry,
  Order,
  OrderStatus,
  Position,
  PositionStatus,
  PriceBar,
  ProposalStatus,
  RiskDecision,
  Security,
  SignalOutcome,
  SocialAuthor,
  SocialEvent,
  Strategy,
  SurvivalMetrics,
  TickerResolution,
  TradeProposal,
  XSignal,
} from '../domain/types.js';
import type { Database, Row } from './db.js';
import { boolToInt, intToBool, jsonParse, nullableBool, numOrNull, strOrNull, toJson } from './db.js';
import type { StoredManualWindow } from '../config/manualIngest.js';

/* ------------------------------------------------------------ securities */

export class SecurityRepo {
  constructor(private readonly db: Database) {}

  upsert(s: Security): void {
    this.db.run(
      `INSERT INTO securities (security_id, ticker, company_name, aliases_json, exchange, asset_class,
        alpaca_tradable, alpaca_fractionable, universe_sources_json, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(security_id) DO UPDATE SET
         ticker = excluded.ticker, company_name = excluded.company_name,
         aliases_json = excluded.aliases_json, exchange = excluded.exchange,
         alpaca_tradable = excluded.alpaca_tradable,
         alpaca_fractionable = excluded.alpaca_fractionable,
         universe_sources_json = excluded.universe_sources_json, active = excluded.active`,
      s.securityId, s.ticker, s.companyName, toJson(s.aliases), s.exchange, s.assetClass,
      boolToInt(s.alpacaTradable), boolToInt(s.alpacaFractionable), toJson(s.universeSources), boolToInt(s.active),
    );
  }

  private static map(r: Row): Security {
    return {
      securityId: String(r['security_id']),
      ticker: String(r['ticker']),
      companyName: String(r['company_name']),
      aliases: jsonParse<string[]>(r['aliases_json'], []),
      exchange: String(r['exchange']),
      assetClass: 'US_EQUITY',
      alpacaTradable: intToBool(r['alpaca_tradable']),
      alpacaFractionable: intToBool(r['alpaca_fractionable']),
      universeSources: jsonParse(r['universe_sources_json'], []),
      active: intToBool(r['active']),
    };
  }

  all(): Security[] {
    return this.db.all('SELECT * FROM securities ORDER BY ticker').map(SecurityRepo.map);
  }

  active(): Security[] {
    return this.db.all('SELECT * FROM securities WHERE active = 1 ORDER BY ticker').map(SecurityRepo.map);
  }

  byId(securityId: string): Security | null {
    const r = this.db.get('SELECT * FROM securities WHERE security_id = ?', securityId);
    return r ? SecurityRepo.map(r) : null;
  }

  byTicker(ticker: string): Security | null {
    const r = this.db.get('SELECT * FROM securities WHERE ticker = ? AND active = 1', ticker.toUpperCase());
    return r ? SecurityRepo.map(r) : null;
  }

  count(): number {
    const r = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM securities');
    return Number(r?.n ?? 0);
  }
}

/* --------------------------------------------------------------- authors */

export class AuthorRepo {
  constructor(private readonly db: Database, private readonly clock: Clock) {}

  upsert(a: SocialAuthor, baselineEngagement = 0): void {
    this.db.run(
      `INSERT INTO social_authors (author_id, handle, display_name, verified, follower_count,
         account_created_at, source_class, source_tier, official_for_security_id, baseline_engagement, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(author_id) DO UPDATE SET
         handle = excluded.handle, display_name = excluded.display_name,
         verified = excluded.verified, follower_count = excluded.follower_count,
         account_created_at = excluded.account_created_at,
         source_class = excluded.source_class, source_tier = excluded.source_tier,
         official_for_security_id = excluded.official_for_security_id,
         baseline_engagement = excluded.baseline_engagement, updated_at = excluded.updated_at`,
      a.authorId, a.handle, a.displayName, boolToInt(a.verified), a.followerCount,
      a.accountCreatedAt ?? null, a.sourceClass, a.sourceTier, a.officialForSecurityId ?? null,
      baselineEngagement, this.clock.nowIso(),
    );
  }

  private static map(r: Row): SocialAuthor & { baselineEngagement: number } {
    return {
      authorId: String(r['author_id']),
      handle: String(r['handle']),
      displayName: String(r['display_name']),
      verified: intToBool(r['verified']),
      followerCount: Number(r['follower_count']),
      accountCreatedAt: strOrNull(r['account_created_at']) ?? undefined,
      sourceClass: String(r['source_class']) as SocialAuthor['sourceClass'],
      sourceTier: String(r['source_tier']) as SocialAuthor['sourceTier'],
      officialForSecurityId: strOrNull(r['official_for_security_id']) ?? undefined,
      baselineEngagement: Number(r['baseline_engagement'] ?? 0),
    };
  }

  byId(authorId: string): (SocialAuthor & { baselineEngagement: number }) | null {
    const r = this.db.get('SELECT * FROM social_authors WHERE author_id = ?', authorId);
    return r ? AuthorRepo.map(r) : null;
  }

  byHandle(handle: string): (SocialAuthor & { baselineEngagement: number }) | null {
    const r = this.db.get('SELECT * FROM social_authors WHERE lower(handle) = ?', handle.toLowerCase().replace(/^@/, ''));
    return r ? AuthorRepo.map(r) : null;
  }

  all(): (SocialAuthor & { baselineEngagement: number })[] {
    return this.db.all('SELECT * FROM social_authors ORDER BY source_tier, handle').map(AuthorRepo.map);
  }

  updateBaseline(authorId: string, baseline: number): void {
    this.db.run('UPDATE social_authors SET baseline_engagement = ?, updated_at = ? WHERE author_id = ?',
      baseline, this.clock.nowIso(), authorId);
  }
}

/* --------------------------------------------------------- social events */

export class SocialEventRepo {
  constructor(private readonly db: Database) {}

  /** Returns false when the post was already stored (duplicate ingest). */
  insertIfNew(e: SocialEvent): boolean {
    const existing = this.db.get('SELECT event_id FROM social_events WHERE post_id = ?', e.postId);
    if (existing) return false;
    this.db.run(
      `INSERT INTO social_events (event_id, platform, post_id, author_id, author_handle, author_display_name,
         source_class, source_tier, posted_at, captured_at, text, url, lang, kind, referenced_post_id,
         mentioned_cashtags_json, mentioned_companies_json, resolved_security_ids_json, engagement_json,
         author_baseline_engagement, ingest_batch_id, source, provenance)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.eventId, e.platform, e.postId, e.authorId, e.authorHandle, e.authorDisplayName,
      e.sourceClass, e.sourceTier, e.postedAt, e.capturedAt, e.text, e.url, e.lang ?? null, e.kind,
      e.referencedPostId ?? null, toJson(e.mentionedCashtags), toJson(e.mentionedCompanies),
      toJson(e.resolvedSecurityIds), toJson(e.engagement), e.authorBaselineEngagement ?? null, e.ingestBatchId,
      e.source, e.provenance,
    );
    return true;
  }

  setResolvedSecurities(eventId: string, securityIds: string[]): void {
    this.db.run('UPDATE social_events SET resolved_security_ids_json = ? WHERE event_id = ?', toJson(securityIds), eventId);
  }

  static map(r: Row): SocialEvent {
    return {
      eventId: String(r['event_id']),
      platform: 'X',
      postId: String(r['post_id']),
      authorId: String(r['author_id']),
      authorHandle: String(r['author_handle']),
      authorDisplayName: String(r['author_display_name']),
      sourceClass: String(r['source_class']) as SocialEvent['sourceClass'],
      sourceTier: String(r['source_tier']) as SocialEvent['sourceTier'],
      postedAt: String(r['posted_at']),
      capturedAt: String(r['captured_at']),
      text: String(r['text']),
      url: String(r['url']),
      lang: strOrNull(r['lang']) ?? undefined,
      kind: String(r['kind']) as SocialEvent['kind'],
      referencedPostId: strOrNull(r['referenced_post_id']) ?? undefined,
      mentionedCashtags: jsonParse<string[]>(r['mentioned_cashtags_json'], []),
      mentionedCompanies: jsonParse<string[]>(r['mentioned_companies_json'], []),
      resolvedSecurityIds: jsonParse<string[]>(r['resolved_security_ids_json'], []),
      engagement: jsonParse(r['engagement_json'], { likes: 0, reposts: 0, replies: 0, quotes: 0 }),
      authorBaselineEngagement: numOrNull(r['author_baseline_engagement']) ?? undefined,
      ingestBatchId: String(r['ingest_batch_id']),
      source: String(r['source'] ?? 'X_API') as SocialEvent['source'],
      provenance: String(r['provenance'] ?? 'VENDOR_API') as SocialEvent['provenance'],
    };
  }

  byId(eventId: string): SocialEvent | null {
    const r = this.db.get('SELECT * FROM social_events WHERE event_id = ?', eventId);
    return r ? SocialEventRepo.map(r) : null;
  }

  byIds(eventIds: string[]): SocialEvent[] {
    if (eventIds.length === 0) return [];
    const placeholders = eventIds.map(() => '?').join(',');
    return this.db.all(`SELECT * FROM social_events WHERE event_id IN (${placeholders})`, ...eventIds)
      .map(SocialEventRepo.map);
  }

  byBatch(batchId: string): SocialEvent[] {
    return this.db.all('SELECT * FROM social_events WHERE ingest_batch_id = ? ORDER BY posted_at', batchId)
      .map(SocialEventRepo.map);
  }

  since(iso: string, limit = 500): SocialEvent[] {
    return this.db.all('SELECT * FROM social_events WHERE posted_at >= ? ORDER BY posted_at DESC LIMIT ?', iso, limit)
      .map(SocialEventRepo.map);
  }

  recent(limit = 100): SocialEvent[] {
    return this.db.all('SELECT * FROM social_events ORDER BY captured_at DESC LIMIT ?', limit)
      .map(SocialEventRepo.map);
  }

  existsPost(postId: string): boolean {
    return !!this.db.get('SELECT 1 AS x FROM social_events WHERE post_id = ?', postId);
  }

  countSince(iso: string): number {
    const r = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM social_events WHERE captured_at >= ?', iso);
    return Number(r?.n ?? 0);
  }
}

/* -------------------------------------------------------------- filtering */

export class FilterRepo {
  constructor(private readonly db: Database, private readonly clock: Clock) {}

  save(f: FilterResult): void {
    this.db.run(
      `INSERT INTO filter_results (event_id, verdict, reasons_json, weight, dedup_key, notes_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET verdict = excluded.verdict, reasons_json = excluded.reasons_json,
         weight = excluded.weight, dedup_key = excluded.dedup_key, notes_json = excluded.notes_json`,
      f.eventId, f.verdict, toJson(f.reasons), f.weight, f.dedupKey, toJson(f.notes), this.clock.nowIso(),
    );
  }

  private static map(r: Row): FilterResult {
    return {
      eventId: String(r['event_id']),
      verdict: String(r['verdict']) as FilterResult['verdict'],
      reasons: jsonParse(r['reasons_json'], []),
      weight: Number(r['weight']),
      dedupKey: String(r['dedup_key']),
      notes: jsonParse<string[]>(r['notes_json'], []),
    };
  }

  byEvent(eventId: string): FilterResult | null {
    const r = this.db.get('SELECT * FROM filter_results WHERE event_id = ?', eventId);
    return r ? FilterRepo.map(r) : null;
  }

  /** Event ids already seen for a dedup cluster, oldest first. */
  clusterEventIds(dedupKey: string): string[] {
    return this.db
      .all<{ event_id: string }>(
        `SELECT f.event_id FROM filter_results f
         JOIN social_events e ON e.event_id = f.event_id
         WHERE f.dedup_key = ? ORDER BY e.posted_at ASC`,
        dedupKey,
      )
      .map((r) => r.event_id);
  }

  countByVerdictSince(iso: string): Record<string, number> {
    const rows = this.db.all<{ verdict: string; n: number }>(
      'SELECT verdict, COUNT(*) AS n FROM filter_results WHERE created_at >= ? GROUP BY verdict', iso,
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.verdict] = Number(r.n);
    return out;
  }
}

/* ------------------------------------------------------------- resolution */

export class ResolutionRepo {
  constructor(private readonly db: Database, private readonly clock: Clock) {}

  save(r: TickerResolution): void {
    this.db.run(
      `INSERT INTO ticker_resolutions (resolution_id, event_id, security_id, ticker, method, confidence,
         matched_text, competing_security_ids_json, notes_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, security_id) DO UPDATE SET
         method = excluded.method, confidence = excluded.confidence, matched_text = excluded.matched_text,
         competing_security_ids_json = excluded.competing_security_ids_json, notes_json = excluded.notes_json`,
      deterministicId('res', r.eventId, r.securityId), r.eventId, r.securityId, r.ticker, r.method,
      r.confidence, r.matchedText, toJson(r.competingSecurityIds), toJson(r.notes), this.clock.nowIso(),
    );
  }

  private static map(r: Row): TickerResolution {
    return {
      eventId: String(r['event_id']),
      securityId: String(r['security_id']),
      ticker: String(r['ticker']),
      method: String(r['method']) as TickerResolution['method'],
      confidence: Number(r['confidence']),
      matchedText: String(r['matched_text']),
      competingSecurityIds: jsonParse<string[]>(r['competing_security_ids_json'], []),
      notes: jsonParse<string[]>(r['notes_json'], []),
    };
  }

  byEvent(eventId: string): TickerResolution[] {
    return this.db.all('SELECT * FROM ticker_resolutions WHERE event_id = ?', eventId).map(ResolutionRepo.map);
  }

  byEvents(eventIds: string[]): TickerResolution[] {
    if (eventIds.length === 0) return [];
    const ph = eventIds.map(() => '?').join(',');
    return this.db.all(`SELECT * FROM ticker_resolutions WHERE event_id IN (${ph})`, ...eventIds)
      .map(ResolutionRepo.map);
  }
}

/* -------------------------------------------------------------- strategy */

export class StrategyRepo {
  constructor(private readonly db: Database) {}

  upsert(s: Strategy): void {
    this.db.run(
      `INSERT INTO strategies (strategy_id, display_name, version, status, run_state, mode, created_at, updated_at,
         allocated_capital_cents, benchmark_ticker, universe_sources_json, risk_limits_json, signal_config_id,
         description, halt_reason, halted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(strategy_id) DO UPDATE SET
         display_name = excluded.display_name, version = excluded.version, status = excluded.status,
         run_state = excluded.run_state, mode = excluded.mode, updated_at = excluded.updated_at,
         allocated_capital_cents = excluded.allocated_capital_cents, benchmark_ticker = excluded.benchmark_ticker,
         universe_sources_json = excluded.universe_sources_json, risk_limits_json = excluded.risk_limits_json,
         signal_config_id = excluded.signal_config_id, description = excluded.description,
         halt_reason = excluded.halt_reason, halted_at = excluded.halted_at`,
      s.strategyId, s.displayName, s.version, s.status, s.runState, s.mode, s.createdAt, s.updatedAt,
      s.allocatedCapitalCents, s.benchmarkTicker, toJson(s.universeSources), toJson(s.riskLimits),
      s.signalConfigId, s.description, s.haltReason, s.haltedAt,
    );
  }

  private static map(r: Row): Strategy {
    return {
      strategyId: String(r['strategy_id']),
      displayName: String(r['display_name']),
      version: String(r['version']),
      status: String(r['status']) as Strategy['status'],
      runState: String(r['run_state']) as Strategy['runState'],
      mode: String(r['mode']) as Strategy['mode'],
      createdAt: String(r['created_at']),
      updatedAt: String(r['updated_at']),
      allocatedCapitalCents: Number(r['allocated_capital_cents']),
      benchmarkTicker: String(r['benchmark_ticker']),
      universeSources: jsonParse(r['universe_sources_json'], []),
      riskLimits: jsonParse(r['risk_limits_json'], {} as Strategy['riskLimits']),
      signalConfigId: String(r['signal_config_id']),
      description: String(r['description']),
      haltReason: strOrNull(r['halt_reason']),
      haltedAt: strOrNull(r['halted_at']),
    };
  }

  byId(strategyId: string): Strategy | null {
    const r = this.db.get('SELECT * FROM strategies WHERE strategy_id = ?', strategyId);
    return r ? StrategyRepo.map(r) : null;
  }

  all(): Strategy[] {
    return this.db.all('SELECT * FROM strategies').map(StrategyRepo.map);
  }

  saveVersionSpec(strategyId: string, version: string, publishedAt: string, spec: unknown): void {
    this.db.run(
      `INSERT INTO strategy_versions (strategy_id, version, published_at, spec_json) VALUES (?, ?, ?, ?)
       ON CONFLICT(strategy_id, version) DO NOTHING`,
      strategyId, version, publishedAt, toJson(spec),
    );
  }

  versionSpecs(strategyId: string): { version: string; publishedAt: string; spec: unknown }[] {
    return this.db
      .all('SELECT * FROM strategy_versions WHERE strategy_id = ? ORDER BY published_at', strategyId)
      .map((r) => ({
        version: String(r['version']),
        publishedAt: String(r['published_at']),
        spec: jsonParse<unknown>(r['spec_json'], null),
      }));
  }
}

/* --------------------------------------------------------------- signals */

export class SignalRepo {
  constructor(private readonly db: Database) {}

  save(s: XSignal): void {
    this.db.run(
      `INSERT INTO signals (signal_id, strategy_id, strategy_version, security_id, ticker, score, band, uncertainty,
         generated_at, components_json, contributions_json, signal_config_id, triggering_event_ids_json, evidence_json,
         supporting_evidence_json, contradictory_evidence_json, dominant_event_type, price_confirmation_json,
         explanation, source_count, independent_source_count, resolution_confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(signal_id) DO NOTHING`,
      s.signalId, s.strategyId, s.strategyVersion, s.securityId, s.ticker, s.score, s.band, s.uncertainty,
      s.generatedAt, toJson(s.components), toJson(s.contributions), s.signalConfigId,
      toJson(s.triggeringEventIds), toJson(s.evidence), toJson(s.supportingEvidence),
      toJson(s.contradictoryEvidence), s.dominantEventType, toJson(s.priceConfirmationDetail),
      s.explanation, s.sourceCount, s.independentSourceCount, s.resolutionConfidence,
    );
  }

  static map(r: Row): XSignal {
    return {
      signalId: String(r['signal_id']),
      strategyId: String(r['strategy_id']),
      strategyVersion: String(r['strategy_version']),
      securityId: String(r['security_id']),
      ticker: String(r['ticker']),
      score: Number(r['score']),
      band: String(r['band']) as XSignal['band'],
      uncertainty: Number(r['uncertainty']),
      generatedAt: String(r['generated_at']),
      components: jsonParse(r['components_json'], {} as XSignal['components']),
      contributions: jsonParse(r['contributions_json'], []),
      signalConfigId: String(r['signal_config_id']),
      triggeringEventIds: jsonParse<string[]>(r['triggering_event_ids_json'], []),
      evidence: jsonParse(r['evidence_json'], []),
      supportingEvidence: jsonParse<string[]>(r['supporting_evidence_json'], []),
      contradictoryEvidence: jsonParse<string[]>(r['contradictory_evidence_json'], []),
      dominantEventType: String(r['dominant_event_type']) as XSignal['dominantEventType'],
      priceConfirmationDetail: jsonParse(r['price_confirmation_json'], null),
      explanation: String(r['explanation']),
      sourceCount: Number(r['source_count']),
      independentSourceCount: Number(r['independent_source_count']),
      resolutionConfidence: Number(r['resolution_confidence']),
    };
  }

  byId(signalId: string): XSignal | null {
    const r = this.db.get('SELECT * FROM signals WHERE signal_id = ?', signalId);
    return r ? SignalRepo.map(r) : null;
  }

  recent(limit = 50): XSignal[] {
    return this.db.all('SELECT * FROM signals ORDER BY generated_at DESC LIMIT ?', limit).map(SignalRepo.map);
  }

  since(iso: string): XSignal[] {
    return this.db.all('SELECT * FROM signals WHERE generated_at >= ? ORDER BY generated_at DESC', iso)
      .map(SignalRepo.map);
  }

  latestForSecurity(strategyId: string, securityId: string): XSignal | null {
    const r = this.db.get(
      'SELECT * FROM signals WHERE strategy_id = ? AND security_id = ? ORDER BY generated_at DESC LIMIT 1',
      strategyId, securityId,
    );
    return r ? SignalRepo.map(r) : null;
  }

  countSince(iso: string): number {
    const r = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM signals WHERE generated_at >= ?', iso);
    return Number(r?.n ?? 0);
  }

  all(): XSignal[] {
    return this.db.all('SELECT * FROM signals ORDER BY generated_at').map(SignalRepo.map);
  }
}

/* ------------------------------------------------------------- proposals */

export class ProposalRepo {
  constructor(private readonly db: Database, private readonly clock: Clock) {}

  save(p: TradeProposal): void {
    this.db.run(
      `INSERT INTO trade_proposals (proposal_id, strategy_id, strategy_version, signal_id, security_id, ticker,
         direction, side, proposed_capital_cents, proposed_quantity, fractional, reference_price,
         reference_price_as_of, confidence, rationale, evidence_summary_json, created_at, expires_at, status, mode,
         risk_decision_id, invalidation_condition_json, approval_fingerprint, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(proposal_id) DO UPDATE SET
         status = excluded.status, risk_decision_id = excluded.risk_decision_id,
         proposed_capital_cents = excluded.proposed_capital_cents,
         proposed_quantity = excluded.proposed_quantity,
         approval_fingerprint = excluded.approval_fingerprint`,
      p.proposalId, p.strategyId, p.strategyVersion, p.signalId, p.securityId, p.ticker, p.direction, p.side,
      p.proposedCapitalCents, p.proposedQuantity, boolToInt(p.fractional), p.referencePrice,
      p.referencePriceAsOf, p.confidence, p.rationale, toJson(p.evidenceSummary), p.createdAt, p.expiresAt,
      p.status, p.mode, p.riskDecisionId, toJson(p.invalidationCondition), p.approvalFingerprint, p.correlationId,
    );
  }

  static map(r: Row): TradeProposal {
    return {
      proposalId: String(r['proposal_id']),
      strategyId: String(r['strategy_id']),
      strategyVersion: String(r['strategy_version']),
      signalId: String(r['signal_id']),
      securityId: String(r['security_id']),
      ticker: String(r['ticker']),
      direction: 'LONG',
      side: String(r['side']) as 'BUY' | 'SELL',
      proposedCapitalCents: Number(r['proposed_capital_cents']),
      proposedQuantity: Number(r['proposed_quantity']),
      fractional: intToBool(r['fractional']),
      referencePrice: Number(r['reference_price']),
      referencePriceAsOf: String(r['reference_price_as_of']),
      confidence: Number(r['confidence']),
      rationale: String(r['rationale']),
      evidenceSummary: jsonParse<string[]>(r['evidence_summary_json'], []),
      createdAt: String(r['created_at']),
      expiresAt: String(r['expires_at']),
      status: String(r['status']) as ProposalStatus,
      mode: String(r['mode']) as TradeProposal['mode'],
      riskDecisionId: strOrNull(r['risk_decision_id']),
      invalidationCondition: jsonParse(r['invalidation_condition_json'], {} as TradeProposal['invalidationCondition']),
      approvalFingerprint: String(r['approval_fingerprint']),
      correlationId: String(r['correlation_id']),
    };
  }

  byId(proposalId: string): TradeProposal | null {
    const r = this.db.get('SELECT * FROM trade_proposals WHERE proposal_id = ?', proposalId);
    return r ? ProposalRepo.map(r) : null;
  }

  setStatus(proposalId: string, status: ProposalStatus): void {
    this.db.run('UPDATE trade_proposals SET status = ? WHERE proposal_id = ?', status, proposalId);
  }

  setRiskDecision(proposalId: string, riskDecisionId: string): void {
    this.db.run('UPDATE trade_proposals SET risk_decision_id = ? WHERE proposal_id = ?', riskDecisionId, proposalId);
  }

  bySignal(signalId: string): TradeProposal[] {
    return this.db
      .all('SELECT * FROM trade_proposals WHERE signal_id = ? ORDER BY created_at DESC', signalId)
      .map(ProposalRepo.map);
  }

  byStatus(...statuses: ProposalStatus[]): TradeProposal[] {
    const ph = statuses.map(() => '?').join(',');
    return this.db.all(`SELECT * FROM trade_proposals WHERE status IN (${ph}) ORDER BY created_at DESC`, ...statuses)
      .map(ProposalRepo.map);
  }

  recent(limit = 50): TradeProposal[] {
    return this.db.all('SELECT * FROM trade_proposals ORDER BY created_at DESC LIMIT ?', limit).map(ProposalRepo.map);
  }

  /** Proposals awaiting approval whose expiry has passed. */
  expired(): TradeProposal[] {
    return this.db
      .all(
        `SELECT * FROM trade_proposals WHERE status IN ('AWAITING_APPROVAL','PENDING_RISK','APPROVED') AND expires_at < ?`,
        this.clock.nowIso(),
      )
      .map(ProposalRepo.map);
  }

  openForSecurity(strategyId: string, securityId: string): TradeProposal[] {
    return this.db
      .all(
        `SELECT * FROM trade_proposals WHERE strategy_id = ? AND security_id = ?
         AND status IN ('PENDING_RISK','AWAITING_APPROVAL','APPROVED','SUBMITTED')`,
        strategyId, securityId,
      )
      .map(ProposalRepo.map);
  }

  countSince(iso: string): number {
    const r = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM trade_proposals WHERE created_at >= ?', iso);
    return Number(r?.n ?? 0);
  }
}

/* ------------------------------------------------------------------ risk */

export class RiskRepo {
  constructor(private readonly db: Database) {}

  save(d: RiskDecision): void {
    this.db.run(
      `INSERT INTO risk_decisions (risk_decision_id, proposal_id, strategy_id, approved, checks_json,
         failed_checks_json, permitted_capital_cents, permitted_quantity, decided_at, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(risk_decision_id) DO NOTHING`,
      d.riskDecisionId, d.proposalId, d.strategyId, boolToInt(d.approved), toJson(d.checks),
      toJson(d.failedChecks), d.permittedCapitalCents, d.permittedQuantity, d.decidedAt, d.summary,
    );
  }

  private static map(r: Row): RiskDecision {
    return {
      riskDecisionId: String(r['risk_decision_id']),
      proposalId: String(r['proposal_id']),
      strategyId: String(r['strategy_id']),
      approved: intToBool(r['approved']),
      checks: jsonParse(r['checks_json'], []),
      failedChecks: jsonParse(r['failed_checks_json'], []),
      permittedCapitalCents: Number(r['permitted_capital_cents']),
      permittedQuantity: Number(r['permitted_quantity']),
      decidedAt: String(r['decided_at']),
      summary: String(r['summary']),
    };
  }

  byId(id: string): RiskDecision | null {
    const r = this.db.get('SELECT * FROM risk_decisions WHERE risk_decision_id = ?', id);
    return r ? RiskRepo.map(r) : null;
  }

  byProposal(proposalId: string): RiskDecision | null {
    const r = this.db.get('SELECT * FROM risk_decisions WHERE proposal_id = ? ORDER BY decided_at DESC LIMIT 1', proposalId);
    return r ? RiskRepo.map(r) : null;
  }

  recent(limit = 50): RiskDecision[] {
    return this.db.all('SELECT * FROM risk_decisions ORDER BY decided_at DESC LIMIT ?', limit).map(RiskRepo.map);
  }

  rejectionsSince(iso: string): RiskDecision[] {
    return this.db.all('SELECT * FROM risk_decisions WHERE approved = 0 AND decided_at >= ?', iso).map(RiskRepo.map);
  }
}

/* ------------------------------------------------------------- approvals */

export class ApprovalRepo {
  constructor(private readonly db: Database) {}

  save(a: ApprovalRecord): void {
    this.db.run(
      `INSERT INTO approvals (approval_id, proposal_id, decision, decided_by, decided_at, approval_fingerprint, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      a.approvalId, a.proposalId, a.decision, a.decidedBy, a.decidedAt, a.approvalFingerprint, a.note,
    );
  }

  private static map(r: Row): ApprovalRecord {
    return {
      approvalId: String(r['approval_id']),
      proposalId: String(r['proposal_id']),
      decision: String(r['decision']) as ApprovalRecord['decision'],
      decidedBy: String(r['decided_by']),
      decidedAt: String(r['decided_at']),
      approvalFingerprint: String(r['approval_fingerprint']),
      note: String(r['note'] ?? ''),
    };
  }

  latestForProposal(proposalId: string): ApprovalRecord | null {
    const r = this.db.get('SELECT * FROM approvals WHERE proposal_id = ? ORDER BY decided_at DESC LIMIT 1', proposalId);
    return r ? ApprovalRepo.map(r) : null;
  }

  all(): ApprovalRecord[] {
    return this.db.all('SELECT * FROM approvals ORDER BY decided_at DESC').map(ApprovalRepo.map);
  }
}

/* ---------------------------------------------------------------- orders */

export class OrderRepo {
  constructor(private readonly db: Database) {}

  save(o: Order): void {
    this.db.run(
      `INSERT INTO orders (order_id, broker_order_id, strategy_id, epoch_id, proposal_id, position_id, security_id,
         ticker, side, quantity, notional_cents, type, time_in_force, mode, status, submitted_at, updated_at,
         filled_quantity, filled_avg_price, client_order_id, reject_reason, intent, correlation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET
         broker_order_id = excluded.broker_order_id, position_id = excluded.position_id,
         status = excluded.status, updated_at = excluded.updated_at,
         filled_quantity = excluded.filled_quantity, filled_avg_price = excluded.filled_avg_price,
         reject_reason = excluded.reject_reason`,
      o.orderId, o.brokerOrderId, o.strategyId, o.epochId, o.proposalId, o.positionId, o.securityId, o.ticker,
      o.side, o.quantity, o.notionalCents, o.type, o.timeInForce, o.mode, o.status, o.submittedAt, o.updatedAt,
      o.filledQuantity, o.filledAvgPrice, o.clientOrderId, o.rejectReason, o.intent, o.correlationId,
    );
  }

  static map(r: Row): Order {
    return {
      orderId: String(r['order_id']),
      brokerOrderId: strOrNull(r['broker_order_id']),
      strategyId: String(r['strategy_id']),
      epochId: String(r['epoch_id'] ?? ''),
      proposalId: strOrNull(r['proposal_id']),
      positionId: strOrNull(r['position_id']),
      securityId: String(r['security_id']),
      ticker: String(r['ticker']),
      side: String(r['side']) as 'BUY' | 'SELL',
      quantity: Number(r['quantity']),
      notionalCents: numOrNull(r['notional_cents']),
      type: 'MARKET',
      timeInForce: 'DAY',
      mode: String(r['mode']) as Order['mode'],
      status: String(r['status']) as OrderStatus,
      submittedAt: String(r['submitted_at']),
      updatedAt: String(r['updated_at']),
      filledQuantity: Number(r['filled_quantity']),
      filledAvgPrice: numOrNull(r['filled_avg_price']),
      clientOrderId: String(r['client_order_id']),
      rejectReason: strOrNull(r['reject_reason']),
      intent: String(r['intent']) as Order['intent'],
      correlationId: String(r['correlation_id']),
    };
  }

  byId(orderId: string): Order | null {
    const r = this.db.get('SELECT * FROM orders WHERE order_id = ?', orderId);
    return r ? OrderRepo.map(r) : null;
  }

  byClientOrderId(clientOrderId: string): Order | null {
    const r = this.db.get('SELECT * FROM orders WHERE client_order_id = ?', clientOrderId);
    return r ? OrderRepo.map(r) : null;
  }

  byProposal(proposalId: string): Order[] {
    return this.db.all('SELECT * FROM orders WHERE proposal_id = ?', proposalId).map(OrderRepo.map);
  }

  byPosition(positionId: string): Order[] {
    return this.db
      .all('SELECT * FROM orders WHERE position_id = ? ORDER BY submitted_at', positionId)
      .map(OrderRepo.map);
  }

  open(strategyId: string): Order[] {
    return this.db
      .all(`SELECT * FROM orders WHERE strategy_id = ? AND status IN ('NEW','PENDING','PARTIALLY_FILLED')`, strategyId)
      .map(OrderRepo.map);
  }

  /**
   * Orders the PositionManager still has accounting to do for.
   *
   * Not the same as `open()`: a broker that fills instantly returns FILLED from
   * the submit call itself, and that order has never been turned into a
   * position or a ledger movement yet.
   */
  needingReconciliation(strategyId: string): Order[] {
    return this.db
      .all(
        `SELECT * FROM orders WHERE strategy_id = ? AND (
           status IN ('NEW','PENDING','PARTIALLY_FILLED')
           OR (status = 'FILLED' AND intent = 'ENTRY' AND position_id IS NULL)
           OR (status = 'FILLED' AND intent = 'EXIT' AND position_id IN (
                 SELECT position_id FROM positions WHERE status IN ('OPEN','CLOSING')))
         ) ORDER BY submitted_at`,
        strategyId,
      )
      .map(OrderRepo.map);
  }

  recent(limit = 50): Order[] {
    return this.db.all('SELECT * FROM orders ORDER BY submitted_at DESC LIMIT ?', limit).map(OrderRepo.map);
  }

  /**
   * When this strategy last tried to ENTER a ticker, whatever came of it.
   *
   * Rejected and cancelled attempts count. The cooldown exists to bound how
   * fast the bot acts on one developing story, and an attempt that failed at
   * the broker still represents a decision to act on that story.
   */
  lastEntryAt(strategyId: string, ticker: string): string | null {
    const r = this.db.get(
      `SELECT MAX(submitted_at) AS last FROM orders
        WHERE strategy_id = ? AND ticker = ? AND intent = 'ENTRY'`,
      strategyId, ticker.toUpperCase(),
    );
    const value = r?.['last'];
    return value === null || value === undefined ? null : String(value);
  }

  all(): Order[] {
    return this.db.all('SELECT * FROM orders ORDER BY submitted_at').map(OrderRepo.map);
  }
}

/* ----------------------------------------------------------------- fills */

export class FillRepo {
  constructor(private readonly db: Database) {}

  save(f: Fill): void {
    this.db.run(
      `INSERT INTO fills (fill_id, order_id, broker_order_id, security_id, ticker, side, quantity, price,
         fees_cents, filled_at, partial)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fill_id) DO NOTHING`,
      f.fillId, f.orderId, f.brokerOrderId, f.securityId, f.ticker, f.side, f.quantity, f.price,
      f.feesCents, f.filledAt, boolToInt(f.partial),
    );
  }

  private static map(r: Row): Fill {
    return {
      fillId: String(r['fill_id']),
      orderId: String(r['order_id']),
      brokerOrderId: strOrNull(r['broker_order_id']),
      securityId: String(r['security_id']),
      ticker: String(r['ticker']),
      side: String(r['side']) as 'BUY' | 'SELL',
      quantity: Number(r['quantity']),
      price: Number(r['price']),
      feesCents: Number(r['fees_cents']),
      filledAt: String(r['filled_at']),
      partial: intToBool(r['partial']),
    };
  }

  byOrder(orderId: string): Fill[] {
    return this.db.all('SELECT * FROM fills WHERE order_id = ? ORDER BY filled_at', orderId).map(FillRepo.map);
  }

  all(): Fill[] {
    return this.db.all('SELECT * FROM fills ORDER BY filled_at').map(FillRepo.map);
  }

  exists(fillId: string): boolean {
    return !!this.db.get('SELECT 1 AS x FROM fills WHERE fill_id = ?', fillId);
  }
}

/* ------------------------------------------------------------- positions */

export class PositionRepo {
  constructor(private readonly db: Database) {}

  save(p: Position): void {
    this.db.run(
      `INSERT INTO positions (position_id, strategy_id, strategy_version, epoch_id, security_id, ticker, direction, status,
         quantity, entry_price, entry_cost_cents, opened_at, entry_order_id, entry_signal_id, entry_proposal_id,
         entry_signal_score, invalidation_condition_json, high_water_price, last_mark_price, last_mark_at,
         unrealised_pnl_cents, exit_order_id, exit_price, exit_proceeds_cents, closed_at, exit_reason, exit_note,
         realised_pnl_cents, fees_cents, mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(position_id) DO UPDATE SET
         status = excluded.status, quantity = excluded.quantity, high_water_price = excluded.high_water_price,
         last_mark_price = excluded.last_mark_price, last_mark_at = excluded.last_mark_at,
         unrealised_pnl_cents = excluded.unrealised_pnl_cents, exit_order_id = excluded.exit_order_id,
         exit_price = excluded.exit_price, exit_proceeds_cents = excluded.exit_proceeds_cents,
         closed_at = excluded.closed_at, exit_reason = excluded.exit_reason, exit_note = excluded.exit_note,
         realised_pnl_cents = excluded.realised_pnl_cents, fees_cents = excluded.fees_cents`,
      p.positionId, p.strategyId, p.strategyVersion, p.epochId, p.securityId, p.ticker, p.direction, p.status,
      p.quantity, p.entryPrice, p.entryCostCents, p.openedAt, p.entryOrderId, p.entrySignalId, p.entryProposalId,
      p.entrySignalScore, toJson(p.invalidationCondition), p.highWaterPrice, p.lastMarkPrice, p.lastMarkAt,
      p.unrealisedPnlCents, p.exitOrderId, p.exitPrice, p.exitProceedsCents, p.closedAt, p.exitReason,
      p.exitNote, p.realisedPnlCents, p.feesCents, p.mode,
    );
  }

  static map(r: Row): Position {
    return {
      positionId: String(r['position_id']),
      strategyId: String(r['strategy_id']),
      strategyVersion: String(r['strategy_version']),
      epochId: String(r['epoch_id'] ?? ''),
      securityId: String(r['security_id']),
      ticker: String(r['ticker']),
      direction: 'LONG',
      status: String(r['status']) as PositionStatus,
      quantity: Number(r['quantity']),
      entryPrice: Number(r['entry_price']),
      entryCostCents: Number(r['entry_cost_cents']),
      openedAt: String(r['opened_at']),
      entryOrderId: String(r['entry_order_id']),
      entrySignalId: String(r['entry_signal_id']),
      entryProposalId: String(r['entry_proposal_id']),
      entrySignalScore: Number(r['entry_signal_score']),
      invalidationCondition: jsonParse(r['invalidation_condition_json'], {} as Position['invalidationCondition']),
      highWaterPrice: Number(r['high_water_price']),
      lastMarkPrice: Number(r['last_mark_price']),
      lastMarkAt: String(r['last_mark_at']),
      unrealisedPnlCents: Number(r['unrealised_pnl_cents']),
      exitOrderId: strOrNull(r['exit_order_id']),
      exitPrice: numOrNull(r['exit_price']),
      exitProceedsCents: numOrNull(r['exit_proceeds_cents']),
      closedAt: strOrNull(r['closed_at']),
      exitReason: strOrNull(r['exit_reason']) as Position['exitReason'],
      exitNote: strOrNull(r['exit_note']),
      realisedPnlCents: numOrNull(r['realised_pnl_cents']),
      feesCents: Number(r['fees_cents']),
      mode: String(r['mode']) as Position['mode'],
    };
  }

  byId(positionId: string): Position | null {
    const r = this.db.get('SELECT * FROM positions WHERE position_id = ?', positionId);
    return r ? PositionRepo.map(r) : null;
  }

  open(strategyId: string): Position[] {
    return this.db
      .all(`SELECT * FROM positions WHERE strategy_id = ? AND status IN ('OPEN','CLOSING') ORDER BY opened_at`, strategyId)
      .map(PositionRepo.map);
  }

  openForSecurity(strategyId: string, securityId: string): Position[] {
    return this.db
      .all(
        `SELECT * FROM positions WHERE strategy_id = ? AND security_id = ? AND status IN ('OPEN','CLOSING')`,
        strategyId, securityId,
      )
      .map(PositionRepo.map);
  }

  closed(strategyId: string): Position[] {
    return this.db
      .all(`SELECT * FROM positions WHERE strategy_id = ? AND status = 'CLOSED' ORDER BY closed_at`, strategyId)
      .map(PositionRepo.map);
  }

  all(strategyId: string): Position[] {
    return this.db.all('SELECT * FROM positions WHERE strategy_id = ? ORDER BY opened_at DESC', strategyId)
      .map(PositionRepo.map);
  }
}

/* --------------------------------------------------- manual X observations */

/**
 * Operator-supplied X posts.
 *
 * Deduplicated on `post_id`, which is the canonical X status id rather than the
 * URL as typed: the same post reachable as x.com, twitter.com or with a
 * tracking parameter is ONE observation. Without that, the same post pasted
 * twice would look like two independent sources corroborating each other, which
 * is precisely the thing the signal engine rewards.
 */
export class ManualObservationRepo {
  constructor(private readonly db: Database) {}

  /** Insert, or report that this post is already held. */
  add(o: ManualObservation): { inserted: boolean; existing: ManualObservation | null } {
    const existing = this.byPostId(o.postId);
    if (existing) return { inserted: false, existing };

    this.db.run(
      `INSERT INTO manual_observations (observation_id, post_id, canonical_url, submitted_url, handle,
         display_name, text, posted_at, captured_at, submitted_by, source, provenance, engagement_json,
         follower_count, verified, note, status, ingested_at, event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(post_id) DO NOTHING`,
      o.observationId, o.postId, o.canonicalUrl, o.submittedUrl, o.handle,
      o.displayName, o.text, o.postedAt, o.capturedAt, o.submittedBy, o.source, o.provenance,
      toJson(o.engagement), o.followerCount, boolToInt(o.verified), o.note, o.status,
      o.ingestedAt, o.eventId,
    );
    return { inserted: this.byPostId(o.postId) !== null, existing: null };
  }

  byPostId(postId: string): ManualObservation | null {
    const r = this.db.get('SELECT * FROM manual_observations WHERE post_id = ?', postId);
    return r ? ManualObservationRepo.map(r) : null;
  }

  byId(observationId: string): ManualObservation | null {
    const r = this.db.get('SELECT * FROM manual_observations WHERE observation_id = ?', observationId);
    return r ? ManualObservationRepo.map(r) : null;
  }

  /** Observations not yet turned into events, oldest post first. */
  pending(limit = 200): ManualObservation[] {
    return this.db
      .all("SELECT * FROM manual_observations WHERE status = 'PENDING' ORDER BY posted_at LIMIT ?", limit)
      .map(ManualObservationRepo.map);
  }

  recent(limit = 100): ManualObservation[] {
    return this.db
      .all('SELECT * FROM manual_observations ORDER BY captured_at DESC LIMIT ?', limit)
      .map(ManualObservationRepo.map);
  }

  markIngested(observationId: string, eventId: string, at: string): void {
    this.db.run(
      "UPDATE manual_observations SET status = 'INGESTED', event_id = ?, ingested_at = ? WHERE observation_id = ?",
      eventId, at, observationId,
    );
  }

  counts(): { total: number; pending: number; ingested: number } {
    const row = this.db.get<{ total: number; pending: number; ingested: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'PENDING'  THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN status = 'INGESTED' THEN 1 ELSE 0 END) AS ingested
       FROM manual_observations`);
    return {
      total: Number(row?.total ?? 0),
      pending: Number(row?.pending ?? 0),
      ingested: Number(row?.ingested ?? 0),
    };
  }

  private static map(r: Row): ManualObservation {
    return {
      observationId: String(r['observation_id']),
      postId: String(r['post_id']),
      canonicalUrl: String(r['canonical_url']),
      submittedUrl: String(r['submitted_url']),
      handle: String(r['handle']),
      displayName: String(r['display_name']),
      text: String(r['text']),
      postedAt: String(r['posted_at']),
      capturedAt: String(r['captured_at']),
      submittedBy: String(r['submitted_by']),
      source: 'X_MANUAL',
      provenance: 'MANUAL_OPERATOR_SUPPLIED',
      engagement: jsonParse<ManualObservation['engagement']>(
        r['engagement_json'], { likes: 0, reposts: 0, replies: 0, quotes: 0 }),
      followerCount: numOrNull(r['follower_count']),
      verified: intToBool(r['verified']),
      note: String(r['note'] ?? ''),
      status: String(r['status']) as ManualObservation['status'],
      ingestedAt: strOrNull(r['ingested_at']),
      eventId: strOrNull(r['event_id']),
    };
  }
}

/**
 * The manual-ingest experiment window.
 *
 * The expiry is deliberately absent from storage: it is computed from
 * `started_at` and a ceiling in code, so no edit here can lengthen the
 * experiment.
 */
export class ManualWindowRepo {
  constructor(private readonly db: Database) {}

  start(strategyId: string, startedAt: string, startedBy: string, note: string): void {
    this.db.run(
      `INSERT INTO manual_ingest_windows (window_id, strategy_id, started_at, started_by, note)
       VALUES (?, ?, ?, ?, ?)`,
      deterministicId('mwin', strategyId, startedAt), strategyId, startedAt, startedBy, note,
    );
  }

  /** The most recent window, running or not. */
  latest(strategyId: string): StoredManualWindow | null {
    const r = this.db.get(
      'SELECT * FROM manual_ingest_windows WHERE strategy_id = ? ORDER BY started_at DESC', strategyId);
    if (!r) return null;
    return {
      startedAt: String(r['started_at']),
      endedAt: strOrNull(r['ended_at']),
      endedReason: strOrNull(r['ended_reason']),
      startedBy: String(r['started_by']),
      note: String(r['note'] ?? ''),
    };
  }

  stop(strategyId: string, at: string, reason: string): void {
    this.db.run(
      `UPDATE manual_ingest_windows SET ended_at = ?, ended_reason = ?
       WHERE strategy_id = ? AND ended_at IS NULL`,
      at, reason, strategyId,
    );
  }
}

/* ------------------------------------------------------- execution epochs */

/**
 * Execution epochs.
 *
 * An epoch records the capital a run was given and the exact configuration it
 * ran under, so a trade taken months ago can be reconstructed against the
 * allocation, strategy version and universe that actually produced it. Epochs
 * are append-only: superseding one closes it, never edits it.
 */
export class EpochRepo {
  constructor(private readonly db: Database) {}

  upsert(e: ExecutionEpoch): void {
    this.db.run(
      `INSERT INTO execution_epochs (epoch_id, strategy_id, label, capital_cents, status, started_at, ended_at,
         strategy_version, strategy_fingerprint, universe_version, universe_origin, universe_fingerprint,
         config_snapshot_json, rationale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(epoch_id) DO UPDATE SET
         status = excluded.status, ended_at = excluded.ended_at,
         universe_version = excluded.universe_version, universe_origin = excluded.universe_origin,
         universe_fingerprint = excluded.universe_fingerprint,
         config_snapshot_json = excluded.config_snapshot_json`,
      e.epochId, e.strategyId, e.label, e.capitalCents, e.status, e.startedAt, e.endedAt,
      e.strategyVersion, e.strategyFingerprint, e.universeVersion, e.universeOrigin, e.universeFingerprint,
      toJson(e.configSnapshot), e.rationale,
    );
  }

  byId(epochId: string): ExecutionEpoch | null {
    const r = this.db.get('SELECT * FROM execution_epochs WHERE epoch_id = ?', epochId);
    return r ? EpochRepo.map(r) : null;
  }

  active(strategyId: string): ExecutionEpoch | null {
    const r = this.db.get(
      "SELECT * FROM execution_epochs WHERE strategy_id = ? AND status = 'ACTIVE' ORDER BY started_at DESC",
      strategyId);
    return r ? EpochRepo.map(r) : null;
  }

  all(strategyId: string): ExecutionEpoch[] {
    return this.db
      .all('SELECT * FROM execution_epochs WHERE strategy_id = ? ORDER BY started_at', strategyId)
      .map(EpochRepo.map);
  }

  /** Close every epoch except the one now active. Never deletes. */
  closeOthers(strategyId: string, activeEpochId: string, at: string): void {
    this.db.run(
      `UPDATE execution_epochs SET status = 'CLOSED', ended_at = COALESCE(ended_at, ?)
       WHERE strategy_id = ? AND epoch_id != ? AND status = 'ACTIVE'`,
      at, strategyId, activeEpochId,
    );
  }

  private static map(r: Row): ExecutionEpoch {
    return {
      epochId: String(r['epoch_id']),
      strategyId: String(r['strategy_id']),
      label: String(r['label']),
      capitalCents: Number(r['capital_cents']),
      status: String(r['status']) as ExecutionEpoch['status'],
      startedAt: String(r['started_at']),
      endedAt: strOrNull(r['ended_at']),
      strategyVersion: String(r['strategy_version']),
      strategyFingerprint: String(r['strategy_fingerprint']),
      universeVersion: String(r['universe_version'] ?? ''),
      universeOrigin: String(r['universe_origin'] ?? ''),
      universeFingerprint: String(r['universe_fingerprint'] ?? ''),
      configSnapshot: jsonParse<Record<string, unknown>>(r['config_snapshot_json'], {}),
      rationale: String(r['rationale'] ?? ''),
    };
  }
}

/* ---------------------------------------------------------------- ledger */

export class LedgerRepo {
  constructor(private readonly db: Database) {}

  init(strategyId: string, epochId: string, startingCapitalCents: number, at: string): CapitalLedger {
    const existing = this.get(strategyId, epochId);
    if (existing) return existing;
    const ledger: CapitalLedger = {
      strategyId,
      epochId,
      startingCapitalCents,
      cashCents: startingCapitalCents,
      reservedCents: 0,
      positionsValueCents: 0,
      unrealisedPnlCents: 0,
      realisedPnlCents: 0,
      feesPaidCents: 0,
      equityCents: startingCapitalCents,
      highWaterEquityCents: startingCapitalCents,
      updatedAt: at,
    };
    this.save(ledger);
    this.appendEntry({
      entryId: deterministicId('led', strategyId, epochId, 'ALLOCATION', at),
      strategyId,
      epochId,
      at,
      kind: 'ALLOCATION',
      amountCents: startingCapitalCents,
      cashAfterCents: startingCapitalCents,
      reference: strategyId,
      note: 'Initial virtual allocation',
    });
    return ledger;
  }

  save(l: CapitalLedger): void {
    this.db.run(
      `INSERT INTO capital_ledger (strategy_id, epoch_id, starting_capital_cents, cash_cents, reserved_cents,
         positions_value_cents, unrealised_pnl_cents, realised_pnl_cents, fees_paid_cents, equity_cents,
         high_water_equity_cents, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(strategy_id, epoch_id) DO UPDATE SET
         cash_cents = excluded.cash_cents, reserved_cents = excluded.reserved_cents,
         positions_value_cents = excluded.positions_value_cents,
         unrealised_pnl_cents = excluded.unrealised_pnl_cents, realised_pnl_cents = excluded.realised_pnl_cents,
         fees_paid_cents = excluded.fees_paid_cents, equity_cents = excluded.equity_cents,
         high_water_equity_cents = excluded.high_water_equity_cents, updated_at = excluded.updated_at`,
      l.strategyId, l.epochId, l.startingCapitalCents, l.cashCents, l.reservedCents, l.positionsValueCents,
      l.unrealisedPnlCents, l.realisedPnlCents, l.feesPaidCents, l.equityCents, l.highWaterEquityCents, l.updatedAt,
    );
  }

  get(strategyId: string, epochId: string): CapitalLedger | null {
    const r = this.db.get(
      'SELECT * FROM capital_ledger WHERE strategy_id = ? AND epoch_id = ?', strategyId, epochId);
    if (!r) return null;
    return {
      strategyId: String(r['strategy_id']),
      epochId: String(r['epoch_id']),
      startingCapitalCents: Number(r['starting_capital_cents']),
      cashCents: Number(r['cash_cents']),
      reservedCents: Number(r['reserved_cents']),
      positionsValueCents: Number(r['positions_value_cents']),
      unrealisedPnlCents: Number(r['unrealised_pnl_cents']),
      realisedPnlCents: Number(r['realised_pnl_cents']),
      feesPaidCents: Number(r['fees_paid_cents']),
      equityCents: Number(r['equity_cents']),
      highWaterEquityCents: Number(r['high_water_equity_cents']),
      updatedAt: String(r['updated_at']),
    };
  }

  appendEntry(e: LedgerEntry): void {
    this.db.run(
      `INSERT INTO ledger_entries (entry_id, strategy_id, epoch_id, at, kind, amount_cents, cash_after_cents,
         reference, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(entry_id) DO NOTHING`,
      e.entryId, e.strategyId, e.epochId, e.at, e.kind, e.amountCents, e.cashAfterCents, e.reference, e.note,
    );
  }

  entries(strategyId: string, epochId: string, limit = 200): LedgerEntry[] {
    return this.db
      .all(
        'SELECT * FROM ledger_entries WHERE strategy_id = ? AND epoch_id = ? ORDER BY at DESC LIMIT ?',
        strategyId, epochId, limit)
      .map((r) => ({
        entryId: String(r['entry_id']),
        strategyId: String(r['strategy_id']),
        epochId: String(r['epoch_id']),
        at: String(r['at']),
        kind: String(r['kind']) as LedgerEntry['kind'],
        amountCents: Number(r['amount_cents']),
        cashAfterCents: Number(r['cash_after_cents']),
        reference: String(r['reference']),
        note: String(r['note'] ?? ''),
      }));
  }

  snapshotEquity(strategyId: string, at: string, equityCents: number, cashCents: number,
    positionsValueCents: number, benchmarkPrice: number | null): void {
    this.db.run(
      `INSERT INTO equity_snapshots (snapshot_id, strategy_id, at, equity_cents, cash_cents,
         positions_value_cents, benchmark_price)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(strategy_id, at) DO UPDATE SET equity_cents = excluded.equity_cents,
         cash_cents = excluded.cash_cents, positions_value_cents = excluded.positions_value_cents,
         benchmark_price = excluded.benchmark_price`,
      deterministicId('eq', strategyId, at), strategyId, at, equityCents, cashCents, positionsValueCents, benchmarkPrice,
    );
  }

  equityCurve(strategyId: string): {
    at: string; equityCents: number; cashCents: number; positionsValueCents: number; benchmarkPrice: number | null;
  }[] {
    return this.db.all('SELECT * FROM equity_snapshots WHERE strategy_id = ? ORDER BY at', strategyId).map((r) => ({
      at: String(r['at']),
      equityCents: Number(r['equity_cents']),
      cashCents: Number(r['cash_cents']),
      positionsValueCents: Number(r['positions_value_cents']),
      benchmarkPrice: numOrNull(r['benchmark_price']),
    }));
  }
}

/* -------------------------------------------------------------- analytics */

export class OutcomeRepo {
  constructor(private readonly db: Database) {}

  upsert(o: SignalOutcome): void {
    this.db.run(
      `INSERT INTO signal_outcomes (outcome_id, signal_id, strategy_id, security_id, ticker, signal_score, band,
         generated_at, entry_reference_price, horizon, forward_return_pct, benchmark_return_pct, excess_return_pct,
         measured_at, hit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(signal_id, horizon) DO UPDATE SET
         forward_return_pct = excluded.forward_return_pct,
         benchmark_return_pct = excluded.benchmark_return_pct,
         excess_return_pct = excluded.excess_return_pct,
         measured_at = excluded.measured_at, hit = excluded.hit`,
      o.outcomeId, o.signalId, o.strategyId, o.securityId, o.ticker, o.signalScore, o.band, o.generatedAt,
      o.entryReferencePrice, o.horizon, o.forwardReturnPct, o.benchmarkReturnPct, o.excessReturnPct,
      o.measuredAt, o.hit === null ? null : boolToInt(o.hit),
    );
  }

  private static map(r: Row): SignalOutcome {
    return {
      outcomeId: String(r['outcome_id']),
      signalId: String(r['signal_id']),
      strategyId: String(r['strategy_id']),
      securityId: String(r['security_id']),
      ticker: String(r['ticker']),
      signalScore: Number(r['signal_score']),
      band: String(r['band']) as SignalOutcome['band'],
      generatedAt: String(r['generated_at']),
      entryReferencePrice: Number(r['entry_reference_price']),
      horizon: String(r['horizon']) as SignalOutcome['horizon'],
      forwardReturnPct: numOrNull(r['forward_return_pct']),
      benchmarkReturnPct: numOrNull(r['benchmark_return_pct']),
      excessReturnPct: numOrNull(r['excess_return_pct']),
      measuredAt: strOrNull(r['measured_at']),
      hit: nullableBool(r['hit']),
    };
  }

  all(strategyId: string): SignalOutcome[] {
    return this.db.all('SELECT * FROM signal_outcomes WHERE strategy_id = ? ORDER BY generated_at', strategyId)
      .map(OutcomeRepo.map);
  }

  pending(strategyId: string): SignalOutcome[] {
    return this.db.all('SELECT * FROM signal_outcomes WHERE strategy_id = ? AND measured_at IS NULL', strategyId)
      .map(OutcomeRepo.map);
  }

  measured(strategyId: string): SignalOutcome[] {
    return this.db.all('SELECT * FROM signal_outcomes WHERE strategy_id = ? AND measured_at IS NOT NULL', strategyId)
      .map(OutcomeRepo.map);
  }

  forSignal(signalId: string): SignalOutcome[] {
    return this.db.all('SELECT * FROM signal_outcomes WHERE signal_id = ?', signalId).map(OutcomeRepo.map);
  }
}

export class SurvivalRepo {
  constructor(private readonly db: Database) {}

  save(m: SurvivalMetrics): void {
    this.db.run(
      `INSERT INTO survival_metrics (metrics_id, strategy_id, strategy_version, as_of, payload_json)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(metrics_id) DO UPDATE SET payload_json = excluded.payload_json`,
      deterministicId('surv', m.strategyId, m.strategyVersion, m.asOf), m.strategyId, m.strategyVersion, m.asOf, toJson(m),
    );
  }

  latest(strategyId: string): SurvivalMetrics | null {
    const r = this.db.get('SELECT * FROM survival_metrics WHERE strategy_id = ? ORDER BY as_of DESC LIMIT 1', strategyId);
    return r ? jsonParse<SurvivalMetrics | null>(r['payload_json'], null) : null;
  }

  history(strategyId: string, limit = 100): SurvivalMetrics[] {
    return this.db
      .all('SELECT * FROM survival_metrics WHERE strategy_id = ? ORDER BY as_of DESC LIMIT ?', strategyId, limit)
      .map((r) => jsonParse<SurvivalMetrics>(r['payload_json'], {} as SurvivalMetrics));
  }
}

/* ---------------------------------------------------------- decision log */

export class DecisionLogRepo {
  constructor(private readonly db: Database, private readonly clock: Clock) {}

  append(entry: Omit<DecisionLogEntry, 'logId' | 'at'> & { at?: string }): DecisionLogEntry {
    const full: DecisionLogEntry = {
      logId: randomId('log'),
      at: entry.at ?? this.clock.nowIso(),
      correlationId: entry.correlationId,
      strategyId: entry.strategyId,
      stage: entry.stage,
      subjectId: entry.subjectId,
      summary: entry.summary,
      payload: entry.payload,
    };
    this.db.run(
      `INSERT INTO decision_log (log_id, correlation_id, strategy_id, stage, at, subject_id, summary, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      full.logId, full.correlationId, full.strategyId, full.stage, full.at, full.subjectId, full.summary,
      toJson(full.payload),
    );
    return full;
  }

  private static map(r: Row): DecisionLogEntry {
    return {
      logId: String(r['log_id']),
      correlationId: String(r['correlation_id']),
      strategyId: String(r['strategy_id']),
      stage: String(r['stage']) as DecisionStage,
      at: String(r['at']),
      subjectId: String(r['subject_id']),
      summary: String(r['summary']),
      payload: jsonParse(r['payload_json'], {}),
    };
  }

  byCorrelation(correlationId: string): DecisionLogEntry[] {
    return this.db.all('SELECT * FROM decision_log WHERE correlation_id = ? ORDER BY at', correlationId)
      .map(DecisionLogRepo.map);
  }

  recent(limit = 200): DecisionLogEntry[] {
    return this.db.all('SELECT * FROM decision_log ORDER BY at DESC LIMIT ?', limit).map(DecisionLogRepo.map);
  }

  byStage(strategyId: string, stage: DecisionStage, limit = 100): DecisionLogEntry[] {
    return this.db
      .all('SELECT * FROM decision_log WHERE strategy_id = ? AND stage = ? ORDER BY at DESC LIMIT ?', strategyId, stage, limit)
      .map(DecisionLogRepo.map);
  }
}

/* -------------------------------------------------------------- incidents */

export class IncidentRepo {
  constructor(private readonly db: Database) {}

  save(i: HealthIncident): void {
    this.db.run(
      `INSERT INTO health_incidents (incident_id, strategy_id, fault, at, detail, paused, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(incident_id) DO UPDATE SET resolved_at = excluded.resolved_at`,
      i.incidentId, i.strategyId, i.fault, i.at, i.detail, boolToInt(i.paused), i.resolvedAt,
    );
  }

  private static map(r: Row): HealthIncident {
    return {
      incidentId: String(r['incident_id']),
      strategyId: String(r['strategy_id']),
      fault: String(r['fault']) as HealthIncident['fault'],
      at: String(r['at']),
      detail: String(r['detail']),
      paused: intToBool(r['paused']),
      resolvedAt: strOrNull(r['resolved_at']),
    };
  }

  open(strategyId: string): HealthIncident[] {
    return this.db
      .all('SELECT * FROM health_incidents WHERE strategy_id = ? AND resolved_at IS NULL ORDER BY at DESC', strategyId)
      .map(IncidentRepo.map);
  }

  recent(strategyId: string, limit = 50): HealthIncident[] {
    return this.db
      .all('SELECT * FROM health_incidents WHERE strategy_id = ? ORDER BY at DESC LIMIT ?', strategyId, limit)
      .map(IncidentRepo.map);
  }

  resolveAll(strategyId: string, at: string): void {
    this.db.run('UPDATE health_incidents SET resolved_at = ? WHERE strategy_id = ? AND resolved_at IS NULL', at, strategyId);
  }
}

/* ------------------------------------------------------------ price bars */

export class PriceBarRepo {
  constructor(private readonly db: Database) {}

  saveMany(bars: PriceBar[]): void {
    for (const b of bars) {
      this.db.run(
        `INSERT INTO price_bars (ticker, at, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ticker, at) DO UPDATE SET open = excluded.open, high = excluded.high,
           low = excluded.low, close = excluded.close, volume = excluded.volume`,
        b.ticker, b.at, b.open, b.high, b.low, b.close, b.volume,
      );
    }
  }

  private static map(r: Row): PriceBar {
    return {
      ticker: String(r['ticker']),
      at: String(r['at']),
      open: Number(r['open']),
      high: Number(r['high']),
      low: Number(r['low']),
      close: Number(r['close']),
      volume: numOrNull(r['volume']),
    };
  }

  range(ticker: string, fromIso: string, toIso: string): PriceBar[] {
    return this.db
      .all('SELECT * FROM price_bars WHERE ticker = ? AND at >= ? AND at <= ? ORDER BY at', ticker, fromIso, toIso)
      .map(PriceBarRepo.map);
  }

  latest(ticker: string): PriceBar | null {
    const r = this.db.get('SELECT * FROM price_bars WHERE ticker = ? ORDER BY at DESC LIMIT 1', ticker);
    return r ? PriceBarRepo.map(r) : null;
  }

  recent(ticker: string, limit: number): PriceBar[] {
    return this.db.all('SELECT * FROM price_bars WHERE ticker = ? ORDER BY at DESC LIMIT ?', ticker, limit)
      .map(PriceBarRepo.map)
      .reverse();
  }

  /** Bar closest to (and not after) an instant; used for forward returns. */
  asOf(ticker: string, iso: string): PriceBar | null {
    const r = this.db.get('SELECT * FROM price_bars WHERE ticker = ? AND at <= ? ORDER BY at DESC LIMIT 1', ticker, iso);
    return r ? PriceBarRepo.map(r) : null;
  }
}


/* --------------------------------------------------------- api telemetry */

export interface ApiUsageRow {
  provider: string;
  day: string;
  requests: number;
  successes: number;
  unauthorized: number;
  forbidden: number;
  rateLimited: number;
  timeouts: number;
  serverErrors: number;
  otherErrors: number;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastErrorKind: string | null;
  lastErrorDetail: string | null;
  rateLimitRemaining: number | null;
  rateLimitLimit: number | null;
  rateLimitResetAt: string | null;
}

const EMPTY_USAGE = (provider: string, day: string): ApiUsageRow => ({
  provider, day,
  requests: 0, successes: 0, unauthorized: 0, forbidden: 0,
  rateLimited: 0, timeouts: 0, serverErrors: 0, otherErrors: 0,
  lastSuccessAt: null, lastErrorAt: null, lastErrorKind: null, lastErrorDetail: null,
  rateLimitRemaining: null, rateLimitLimit: null, rateLimitResetAt: null,
});

export class ApiUsageRepo {
  constructor(private readonly db: Database) {}

  private static map(r: Row): ApiUsageRow {
    return {
      provider: String(r['provider']),
      day: String(r['day']),
      requests: Number(r['requests']),
      successes: Number(r['successes']),
      unauthorized: Number(r['unauthorized']),
      forbidden: Number(r['forbidden']),
      rateLimited: Number(r['rate_limited']),
      timeouts: Number(r['timeouts']),
      serverErrors: Number(r['server_errors']),
      otherErrors: Number(r['other_errors']),
      lastSuccessAt: strOrNull(r['last_success_at']),
      lastErrorAt: strOrNull(r['last_error_at']),
      lastErrorKind: strOrNull(r['last_error_kind']),
      lastErrorDetail: strOrNull(r['last_error_detail']),
      rateLimitRemaining: numOrNull(r['rate_limit_remaining']),
      rateLimitLimit: numOrNull(r['rate_limit_limit']),
      rateLimitResetAt: strOrNull(r['rate_limit_reset_at']),
    };
  }

  get(provider: string, day: string): ApiUsageRow {
    const r = this.db.get('SELECT * FROM api_usage WHERE provider = ? AND day = ?', provider, day);
    return r ? ApiUsageRepo.map(r) : EMPTY_USAGE(provider, day);
  }

  allForDay(day: string): ApiUsageRow[] {
    return this.db.all('SELECT * FROM api_usage WHERE day = ? ORDER BY provider', day).map(ApiUsageRepo.map);
  }

  /**
   * Record one request outcome.
   *
   * Counters are incremented in SQL rather than read-modify-written, so two
   * concurrent in-flight requests cannot lose an increment between them.
   */
  record(entry: {
    provider: string;
    day: string;
    outcome: 'SUCCESS' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'RATE_LIMITED' | 'TIMEOUT' | 'SERVER_ERROR' | 'OTHER_ERROR';
    at: string;
    detail?: string | null;
    rateLimitRemaining?: number | null;
    rateLimitLimit?: number | null;
    rateLimitResetAt?: string | null;
  }): void {
    const column = {
      SUCCESS: 'successes',
      UNAUTHORIZED: 'unauthorized',
      FORBIDDEN: 'forbidden',
      RATE_LIMITED: 'rate_limited',
      TIMEOUT: 'timeouts',
      SERVER_ERROR: 'server_errors',
      OTHER_ERROR: 'other_errors',
    }[entry.outcome];

    const success = entry.outcome === 'SUCCESS';
    this.db.run(
      `INSERT INTO api_usage (provider, day, requests, ${column}, last_success_at, last_error_at,
         last_error_kind, last_error_detail, rate_limit_remaining, rate_limit_limit, rate_limit_reset_at)
       VALUES (?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, day) DO UPDATE SET
         requests = requests + 1,
         ${column} = ${column} + 1,
         last_success_at = COALESCE(excluded.last_success_at, last_success_at),
         last_error_at = COALESCE(excluded.last_error_at, last_error_at),
         last_error_kind = COALESCE(excluded.last_error_kind, last_error_kind),
         last_error_detail = COALESCE(excluded.last_error_detail, last_error_detail),
         rate_limit_remaining = COALESCE(excluded.rate_limit_remaining, rate_limit_remaining),
         rate_limit_limit = COALESCE(excluded.rate_limit_limit, rate_limit_limit),
         rate_limit_reset_at = COALESCE(excluded.rate_limit_reset_at, rate_limit_reset_at)`,
      entry.provider,
      entry.day,
      success ? entry.at : null,
      success ? null : entry.at,
      success ? null : entry.outcome,
      // Detail is a vendor message, never a credential: the meter only ever
      // receives error text, and the logger redacts separately.
      success ? null : (entry.detail ?? null),
      entry.rateLimitRemaining ?? null,
      entry.rateLimitLimit ?? null,
      entry.rateLimitResetAt ?? null,
    );
  }
}

/* ------------------------------------------------------ provider cursors */

export class CursorRepo {
  constructor(private readonly db: Database, private readonly clock: Clock) {}

  get(key: string): { value: string; observedAt: string } | null {
    const r = this.db.get('SELECT * FROM provider_cursors WHERE cursor_key = ?', key);
    return r ? { value: String(r['value']), observedAt: String(r['observed_at']) } : null;
  }

  set(key: string, value: string, observedAt: string): void {
    this.db.run(
      `INSERT INTO provider_cursors (cursor_key, value, observed_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(cursor_key) DO UPDATE SET value = excluded.value,
         observed_at = excluded.observed_at, updated_at = excluded.updated_at`,
      key, value, observedAt, this.clock.nowIso(),
    );
  }

  /** Cursors under a key prefix, shaped for `SocialQuery.sinceIds`. */
  all(prefix?: string): Record<string, string> {
    const rows = prefix
      ? this.db.all('SELECT * FROM provider_cursors WHERE cursor_key LIKE ? ORDER BY cursor_key', `${prefix}%`)
      : this.db.all('SELECT * FROM provider_cursors ORDER BY cursor_key');
    const out: Record<string, string> = {};
    for (const r of rows) out[String(r['cursor_key'])] = String(r['value']);
    return out;
  }

  list(): { key: string; value: string; observedAt: string }[] {
    return this.db.all('SELECT * FROM provider_cursors ORDER BY cursor_key').map((r) => ({
      key: String(r['cursor_key']),
      value: String(r['value']),
      observedAt: String(r['observed_at']),
    }));
  }

  /**
   * Move a cursor FORWARD only.
   *
   * A vendor page can arrive out of order, and a cursor that moved backwards
   * would re-download everything between the two positions on the next poll —
   * or, worse, a cursor that jumped forward on a partial page would skip posts.
   * Monotonic advance makes both impossible.
   */
  advance(key: string, value: string): boolean {
    const current = this.get(key);
    if (current && !isNewerCursor(value, current.value)) return false;
    this.set(key, value, this.clock.nowIso());
    return true;
  }
}

/**
 * Compare two cursor values.
 *
 * X post ids are numeric snowflakes — monotonically increasing — so where both
 * sides parse as integers they are compared numerically. String comparison
 * would be wrong the moment two ids differ in length, and a cursor that
 * compared wrongly would silently re-download or silently skip.
 *
 * Ids outside that space (fixture and replay providers use readable labels)
 * carry no ordering, so the provider's own notion of "newest" is authoritative
 * and the write is accepted. That is safe because those providers decide
 * freshness themselves rather than delegating it to the vendor.
 */
export function isNewerCursor(candidate: string, current: string): boolean {
  const ordered = /^\d+$/.test(candidate) && /^\d+$/.test(current);
  if (!ordered) return true;
  return BigInt(candidate) > BigInt(current);
}

/* ------------------------------------------------------------------ store */


export class Store {
  readonly securities: SecurityRepo;
  readonly authors: AuthorRepo;
  readonly events: SocialEventRepo;
  readonly filters: FilterRepo;
  readonly resolutions: ResolutionRepo;
  readonly strategies: StrategyRepo;
  readonly signals: SignalRepo;
  readonly proposals: ProposalRepo;
  readonly risk: RiskRepo;
  readonly approvals: ApprovalRepo;
  readonly orders: OrderRepo;
  readonly fills: FillRepo;
  readonly positions: PositionRepo;
  readonly ledger: LedgerRepo;
  readonly outcomes: OutcomeRepo;
  readonly survival: SurvivalRepo;
  readonly log: DecisionLogRepo;
  readonly incidents: IncidentRepo;
  readonly bars: PriceBarRepo;
  readonly apiUsage: ApiUsageRepo;
  readonly cursors: CursorRepo;
  readonly epochs: EpochRepo;
  readonly manual: ManualObservationRepo;
  readonly manualWindows: ManualWindowRepo;

  constructor(readonly db: Database, readonly clock: Clock) {
    this.securities = new SecurityRepo(db);
    this.authors = new AuthorRepo(db, clock);
    this.events = new SocialEventRepo(db);
    this.filters = new FilterRepo(db, clock);
    this.resolutions = new ResolutionRepo(db, clock);
    this.strategies = new StrategyRepo(db);
    this.signals = new SignalRepo(db);
    this.proposals = new ProposalRepo(db, clock);
    this.risk = new RiskRepo(db);
    this.approvals = new ApprovalRepo(db);
    this.orders = new OrderRepo(db);
    this.fills = new FillRepo(db);
    this.positions = new PositionRepo(db);
    this.ledger = new LedgerRepo(db);
    this.outcomes = new OutcomeRepo(db);
    this.survival = new SurvivalRepo(db);
    this.log = new DecisionLogRepo(db, clock);
    this.incidents = new IncidentRepo(db);
    this.bars = new PriceBarRepo(db);
    this.apiUsage = new ApiUsageRepo(db);
    this.cursors = new CursorRepo(db, clock);
    this.epochs = new EpochRepo(db);
    this.manual = new ManualObservationRepo(db);
    this.manualWindows = new ManualWindowRepo(db);
  }

  close(): void {
    this.db.close();
  }
}
