/**
 * Northstar domain model.
 *
 * These types are the contract between layers. They contain no I/O and no
 * provider-specific vocabulary: an X post, a Tiingo bar and an Alpaca order are
 * all normalised into these shapes at the provider boundary so that the signal,
 * risk and execution layers never learn who the vendor is.
 */
import type { Cents } from '../core/index.js';

/* ------------------------------------------------------------- securities */

/**
 * Northstar security identity. `securityId` is the internal, stable key; the
 * ticker is a display/vendor symbol and may be reused across companies over
 * time, so nothing downstream keys off it.
 */
export interface Security {
  securityId: string;
  ticker: string;
  companyName: string;
  /** Alternate names, brands, product lines, former names, common misspellings. */
  aliases: string[];
  exchange: string;
  assetClass: 'US_EQUITY';
  /** Whether Alpaca can trade it at all. */
  alpacaTradable: boolean;
  alpacaFractionable: boolean;
  /** Which Northstar lists put this security into the X universe. */
  universeSources: UniverseSource[];
  active: boolean;
}

export type UniverseSource =
  | 'ALPACA_US_EQUITY'
  | 'NORTHSTAR_WATCHLIST'
  | 'NORTHSTAR_RESEARCH'
  | 'NORTHSTAR_PORTFOLIO'
  | 'TRADING_LAB_UNIVERSE';

/* ----------------------------------------------------------------- social */

/**
 * Source tiers. Credibility is assigned by *what the account is*, never by
 * follower count alone (see credibility.ts for the capped popularity term).
 */
export type SourceTier = 'TIER_1' | 'TIER_2' | 'TIER_3' | 'TIER_4';

export type SourceClass =
  // Tier 1
  | 'COMPANY_OFFICIAL'
  | 'COMPANY_EXECUTIVE'
  | 'REGULATOR'
  | 'GOVERNMENT_AGENCY'
  | 'EXCHANGE'
  // Tier 2
  | 'FINANCIAL_JOURNALIST'
  | 'INDUSTRY_EXPERT'
  | 'SPECIALIST_PUBLICATION'
  // Tier 3
  | 'SELL_SIDE_ANALYST'
  | 'SPECIALIST_COMMENTATOR'
  | 'INDUSTRY_PARTICIPANT'
  // Tier 4
  | 'GENERAL_ACCOUNT'
  | 'UNVERIFIED_COMMENTARY';

export interface SocialAuthor {
  authorId: string;
  handle: string;
  displayName: string;
  verified: boolean;
  followerCount: number;
  /** Account creation time, when the provider exposes it. */
  accountCreatedAt?: string;
  sourceClass: SourceClass;
  sourceTier: SourceTier;
  /** Northstar securityId this account officially speaks for, if any. */
  officialForSecurityId?: string;
}

export interface EngagementMetrics {
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  impressions?: number;
  bookmarks?: number;
}

export type SocialPostKind = 'ORIGINAL' | 'REPOST' | 'QUOTE' | 'REPLY';

/**
 * Normalised social event. This is the *only* shape the Trading Lab pipeline
 * sees; XProvider is responsible for producing it from the X API payload.
 *
 * Everything needed to reproduce a historical signal is preserved here.
 */
export interface SocialEvent {
  eventId: string;
  platform: 'X';
  postId: string;
  authorId: string;
  authorHandle: string;
  authorDisplayName: string;
  sourceClass: SourceClass;
  sourceTier: SourceTier;
  /** When the post was published (provider timestamp). */
  postedAt: string;
  /** When Northstar observed it. */
  capturedAt: string;
  text: string;
  url: string;
  lang?: string;
  kind: SocialPostKind;
  /** Post id this reposts/quotes/replies to, when applicable. */
  referencedPostId?: string;
  /** Raw cashtags and company mentions found in the text, pre-resolution. */
  mentionedCashtags: string[];
  mentionedCompanies: string[];
  /** Northstar securityIds after resolution; empty until resolution runs. */
  resolvedSecurityIds: string[];
  engagement: EngagementMetrics;
  /** Author's typical engagement at capture time, for velocity scoring. */
  authorBaselineEngagement?: number;
  /** Provider-assigned ingest batch, for replay. */
  ingestBatchId: string;
}

/* -------------------------------------------------- filtering / resolution */

export type FilterVerdict = 'ACCEPT' | 'DOWNWEIGHT' | 'REJECT';

export type FilterReason =
  | 'SPAM'
  | 'PROMOTIONAL'
  | 'GIVEAWAY'
  | 'MEME'
  | 'ENGAGEMENT_BAIT'
  | 'CASHTAG_STUFFING'
  | 'BOT_LIKE_DUPLICATE'
  | 'EXACT_DUPLICATE'
  | 'NEAR_DUPLICATE'
  | 'PURE_REPOST'
  | 'STALE_REPOST'
  | 'NO_UNIVERSE_MATCH'
  | 'TOO_SHORT'
  | 'NON_ENGLISH'
  | 'LOW_TIER_NO_SUBSTANCE';

export interface FilterResult {
  eventId: string;
  verdict: FilterVerdict;
  reasons: FilterReason[];
  /** Multiplier applied downstream to a DOWNWEIGHT event's evidence weight. */
  weight: number;
  /** Cluster key grouping substantially identical information. */
  dedupKey: string;
  notes: string[];
}

export type ResolutionMethod =
  | 'CASHTAG'
  | 'COMPANY_NAME'
  | 'ALIAS'
  | 'OFFICIAL_ACCOUNT'
  | 'AMBIGUOUS'
  | 'UNRESOLVED';

export interface TickerResolution {
  eventId: string;
  securityId: string;
  ticker: string;
  method: ResolutionMethod;
  /** 0..1. Low-confidence mappings must never generate trades. */
  confidence: number;
  /** Text span that produced the match, for auditability. */
  matchedText: string;
  /** Other securities the text could plausibly have meant. */
  competingSecurityIds: string[];
  notes: string[];
}

/* ---------------------------------------------------------------- signals */

export type SignalBand = 'STRONG_BEARISH' | 'BEARISH' | 'NEUTRAL' | 'BULLISH' | 'STRONG_BULLISH';

/**
 * The eight scored dimensions of the composite. Directional components run
 * -100..+100; conviction components run 0..100.
 */
export interface SignalComponents {
  /** -100..+100 directional. */
  sentiment: number;
  /** 0..100 — could this plausibly move fundamentals or expectations? */
  materiality: number;
  /** 0..100 — how reliable are the sources behind it? */
  credibility: number;
  /** 0..100 — is this genuinely new information? */
  novelty: number;
  /** 0..100 — is credible attention accelerating unusually? */
  engagementVelocity: number;
  /** 0..100 — independent credible sources on the same development. */
  crossSourceConfirmation: number;
  /** -100..+100 directional — market-data corroboration. Context, not driver. */
  priceConfirmation: number;
  /** 0..100 — recency decay. */
  recency: number;
}

export interface ComponentContribution {
  component: keyof SignalComponents | 'priceAdjustment';
  raw: number;
  weight: number;
  /** Points of the final score attributable to this component. */
  contribution: number;
  explanation: string;
}

export interface SignalEvidence {
  eventId: string;
  postId: string;
  authorHandle: string;
  sourceTier: SourceTier;
  postedAt: string;
  excerpt: string;
  url: string;
  /** Post-filter evidence weight actually applied. */
  weight: number;
  /** Directional sentiment of this specific event. */
  sentiment: number;
  eventType: MaterialEventType;
}

export type MaterialEventType =
  | 'EARNINGS_RESULT'
  | 'GUIDANCE_CHANGE'
  | 'MERGER_ACQUISITION'
  | 'REGULATORY_APPROVAL'
  | 'REGULATORY_ACTION'
  | 'LEGAL_ACTION'
  | 'MAJOR_CONTRACT'
  | 'PRODUCT_LAUNCH'
  | 'PARTNERSHIP'
  | 'EXECUTIVE_CHANGE'
  | 'WORKFORCE_ACTION'
  | 'CAPITAL_RETURN'
  | 'CAPITAL_RAISE'
  | 'CREDIT_EVENT'
  | 'INDEX_CHANGE'
  | 'SHORT_REPORT'
  | 'ANALYST_ACTION'
  | 'OPERATIONAL_INCIDENT'
  | 'MACRO_POLICY'
  | 'GENERAL_COMMENTARY';

export interface PriceConfirmationDetail {
  asOf: string;
  lastPrice: number;
  /** Percent return over the momentum lookback. */
  momentumPct: number;
  /** Move in units of recent daily volatility. */
  abnormalMoveZ: number;
  /** Volume vs its own recent average; null when volume is unavailable. */
  abnormalVolumeRatio: number | null;
  /** Return minus benchmark return over the same window. */
  marketRelativePct: number;
  /** Annualised realised volatility over the lookback. */
  realisedVolatility: number;
  stale: boolean;
  /** Age of the newest bar, in minutes. */
  dataAgeMinutes: number;
}

/**
 * A signal is never a bare number. Every field below is persisted so that any
 * historical decision can be re-read and explained months later.
 */
export interface XSignal {
  signalId: string;
  strategyId: string;
  strategyVersion: string;
  securityId: string;
  ticker: string;
  /** -100..+100 */
  score: number;
  band: SignalBand;
  /** 0..1 — how much of the score is load-bearing evidence vs thin inference. */
  uncertainty: number;
  generatedAt: string;
  components: SignalComponents;
  contributions: ComponentContribution[];
  /** Config snapshot used, so a replayed signal reproduces exactly. */
  signalConfigId: string;
  triggeringEventIds: string[];
  evidence: SignalEvidence[];
  supportingEvidence: string[];
  contradictoryEvidence: string[];
  dominantEventType: MaterialEventType;
  priceConfirmationDetail: PriceConfirmationDetail | null;
  /** Human-readable narrative. Generated from the components, not from an LLM. */
  explanation: string;
  /** Independent credible authors behind the signal, post-dedup. */
  sourceCount: number;
  independentSourceCount: number;
  /** Minimum entity-resolution confidence across the triggering events. */
  resolutionConfidence: number;
}

/* -------------------------------------------------------------- proposals */

export type TradeDirection = 'LONG';
export type ProposalStatus =
  | 'PENDING_RISK'
  | 'RISK_REJECTED'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED_BY_USER'
  | 'EXPIRED'
  | 'INVALIDATED'
  | 'SUBMITTED'
  | 'FILLED'
  | 'CANCELLED'
  | 'FAILED';

export interface TradeProposal {
  proposalId: string;
  strategyId: string;
  strategyVersion: string;
  signalId: string;
  securityId: string;
  ticker: string;
  direction: TradeDirection;
  side: 'BUY' | 'SELL';
  /** Dollars of strategy capital to deploy, in cents. */
  proposedCapitalCents: Cents;
  proposedQuantity: number;
  fractional: boolean;
  referencePrice: number;
  referencePriceAsOf: string;
  /** 0..1 */
  confidence: number;
  rationale: string;
  evidenceSummary: string[];
  createdAt: string;
  expiresAt: string;
  status: ProposalStatus;
  mode: TradingMode;
  riskDecisionId: string | null;
  /** Condition that voids the thesis; copied onto the position on fill. */
  invalidationCondition: InvalidationCondition;
  /**
   * Hash of the material terms a user approves. Recomputed at submit time; if
   * it no longer matches, the proposal is invalidated rather than executed.
   */
  approvalFingerprint: string;
  correlationId: string;
}

export interface InvalidationCondition {
  description: string;
  /** Signal score at or below which the thesis is void. */
  signalReversalBelow: number;
  /** Percent loss from entry that voids it. */
  stopLossPct: number;
  /** Hours after which the event thesis is considered spent. */
  thesisExpiryHours: number;
  maxHoldingHours: number;
}

/* ------------------------------------------------------------------- risk */

export type RiskCheckId =
  | 'KILL_SWITCH'
  | 'STRATEGY_STATUS'
  | 'UNIVERSE_MEMBERSHIP'
  | 'ALPACA_TRADABLE'
  | 'DIRECTION_ALLOWED'
  | 'RESOLUTION_CONFIDENCE'
  | 'SIGNAL_THRESHOLD'
  | 'SIGNAL_UNCERTAINTY'
  | 'INDEPENDENT_SOURCES'
  | 'MARKET_DATA_FRESHNESS'
  | 'MARKET_HOURS'
  | 'DUPLICATE_EXPOSURE'
  | 'DUPLICATE_ORDER'
  | 'MAX_CONCURRENT_POSITIONS'
  | 'MAX_POSITION_SIZE'
  | 'AVAILABLE_CASH'
  | 'MIN_ORDER_SIZE'
  | 'DAILY_LOSS_LIMIT'
  | 'MAX_DRAWDOWN'
  | 'NO_LEVERAGE'
  | 'LEDGER_INTEGRITY'
  | 'PROVIDER_HEALTH';

export interface RiskCheckResult {
  check: RiskCheckId;
  passed: boolean;
  detail: string;
  /** Observed value and limit, when numeric. */
  observed?: number;
  limit?: number;
}

export interface RiskDecision {
  riskDecisionId: string;
  proposalId: string;
  strategyId: string;
  approved: boolean;
  checks: RiskCheckResult[];
  failedChecks: RiskCheckId[];
  /** Capital the risk layer will actually permit, which may be less than asked. */
  permittedCapitalCents: Cents;
  permittedQuantity: number;
  decidedAt: string;
  summary: string;
}

export interface RiskLimits {
  startingCapitalCents: Cents;
  maxPositionPctOfEquity: number;
  maxConcurrentPositions: number;
  maxDailyLossPct: number;
  maxDrawdownPct: number;
  minOrderCents: Cents;
  allowLeverage: false;
  allowMargin: false;
  allowOptions: false;
  allowShorting: false;
  /** Minimum absolute composite score required to trade. */
  minSignalScore: number;
  maxSignalUncertainty: number;
  minResolutionConfidence: number;
  minIndependentSources: number;
  maxMarketDataAgeMinutes: number;
  requireMarketOpen: boolean;
}

/* --------------------------------------------------------- orders / fills */

export type TradingMode = 'PAPER' | 'LIVE';
export type OrderStatus =
  | 'NEW'
  | 'PENDING'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED';

export interface Order {
  orderId: string;
  brokerOrderId: string | null;
  strategyId: string;
  proposalId: string | null;
  positionId: string | null;
  securityId: string;
  ticker: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  notionalCents: Cents | null;
  type: 'MARKET';
  timeInForce: 'DAY';
  mode: TradingMode;
  status: OrderStatus;
  submittedAt: string;
  updatedAt: string;
  filledQuantity: number;
  filledAvgPrice: number | null;
  /** Idempotency key; the broker rejects a repeat of the same key. */
  clientOrderId: string;
  rejectReason: string | null;
  intent: 'ENTRY' | 'EXIT';
  correlationId: string;
}

export interface Fill {
  fillId: string;
  orderId: string;
  brokerOrderId: string | null;
  securityId: string;
  ticker: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  /** Commissions/fees in cents. Alpaca US equities are commission-free but the
   *  field exists so cost analytics are honest when that changes. */
  feesCents: Cents;
  filledAt: string;
  partial: boolean;
}

/* -------------------------------------------------------------- positions */

export type PositionStatus = 'OPEN' | 'CLOSING' | 'CLOSED';

export type ExitReason =
  | 'SIGNAL_REVERSAL'
  | 'MAX_HOLDING_PERIOD'
  | 'THESIS_EXPIRY'
  | 'STOP_LOSS'
  | 'TRAILING_STOP'
  | 'TAKE_PROFIT'
  | 'STRATEGY_RISK_SHUTDOWN'
  | 'KILL_SWITCH_LIQUIDATION'
  | 'MANUAL';

export interface Position {
  positionId: string;
  strategyId: string;
  strategyVersion: string;
  securityId: string;
  ticker: string;
  direction: TradeDirection;
  status: PositionStatus;
  quantity: number;
  entryPrice: number;
  entryCostCents: Cents;
  openedAt: string;
  entryOrderId: string;
  entrySignalId: string;
  entryProposalId: string;
  entrySignalScore: number;
  invalidationCondition: InvalidationCondition;
  /** Highest observed price since entry, for the trailing stop. */
  highWaterPrice: number;
  lastMarkPrice: number;
  lastMarkAt: string;
  unrealisedPnlCents: Cents;
  exitOrderId: string | null;
  exitPrice: number | null;
  exitProceedsCents: Cents | null;
  closedAt: string | null;
  exitReason: ExitReason | null;
  exitNote: string | null;
  realisedPnlCents: Cents | null;
  feesCents: Cents;
  mode: TradingMode;
}

/* ----------------------------------------------------------------- ledger */

/**
 * The strategy's own virtual allocation. Deliberately separate from the Alpaca
 * account balance: the account may hold far more money than this strategy is
 * allowed to touch.
 */
export interface CapitalLedger {
  strategyId: string;
  startingCapitalCents: Cents;
  cashCents: Cents;
  /** Cash committed to unfilled entry orders. */
  reservedCents: Cents;
  positionsValueCents: Cents;
  unrealisedPnlCents: Cents;
  realisedPnlCents: Cents;
  feesPaidCents: Cents;
  equityCents: Cents;
  /** Peak equity, for drawdown. */
  highWaterEquityCents: Cents;
  updatedAt: string;
}

export interface LedgerEntry {
  entryId: string;
  strategyId: string;
  at: string;
  kind:
    | 'ALLOCATION'
    | 'RESERVE'
    | 'RELEASE_RESERVE'
    | 'BUY'
    | 'SELL'
    | 'FEE'
    | 'MARK'
    | 'ADJUSTMENT';
  amountCents: Cents;
  cashAfterCents: Cents;
  reference: string;
  note: string;
}

/* --------------------------------------------------------------- strategy */

export type StrategyStatus = 'TESTING' | 'ALIVE' | 'THRIVING' | 'PROBATION' | 'RETIRED';
export type StrategyRunState = 'RUNNING' | 'PAUSED' | 'KILLED';

export interface Strategy {
  strategyId: string;
  displayName: string;
  /** Immutable version. Material logic changes create a new version. */
  version: string;
  status: StrategyStatus;
  runState: StrategyRunState;
  mode: TradingMode;
  createdAt: string;
  updatedAt: string;
  allocatedCapitalCents: Cents;
  benchmarkTicker: string;
  universeSources: UniverseSource[];
  riskLimits: RiskLimits;
  signalConfigId: string;
  description: string;
  /** Why the strategy is paused/killed, when it is. */
  haltReason: string | null;
  haltedAt: string | null;
}

/* -------------------------------------------------------------- approvals */

export type ApprovalDecision = 'APPROVED' | 'REJECTED';

export interface ApprovalRecord {
  approvalId: string;
  proposalId: string;
  decision: ApprovalDecision;
  decidedBy: string;
  decidedAt: string;
  /**
   * Fingerprint of the exact terms shown to the user. The order router
   * recomputes this at submit time and refuses to trade on a mismatch.
   */
  approvalFingerprint: string;
  note: string;
}

/* -------------------------------------------------------------- analytics */

export type ForwardHorizon = '1h' | '1d' | '1w' | '1m';

export interface SignalOutcome {
  outcomeId: string;
  signalId: string;
  strategyId: string;
  securityId: string;
  ticker: string;
  signalScore: number;
  band: SignalBand;
  generatedAt: string;
  entryReferencePrice: number;
  horizon: ForwardHorizon;
  /** Null until enough time has passed / data exists. */
  forwardReturnPct: number | null;
  benchmarkReturnPct: number | null;
  excessReturnPct: number | null;
  measuredAt: string | null;
  /** Whether the realised move agreed with the signal's direction. */
  hit: boolean | null;
}

export interface SurvivalMetrics {
  strategyId: string;
  strategyVersion: string;
  asOf: string;
  strategyReturnPct: number;
  benchmarkReturnPct: number;
  alphaPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  averageWinnerCents: Cents;
  averageLoserCents: Cents;
  sharpe: number | null;
  turnover: number;
  tradeCount: number;
  totalCostsCents: Cents;
  status: StrategyStatus;
  statusRationale: string;
  /** Sample size caveat; suppresses status promotion on thin data. */
  sampleAdequate: boolean;
}

/* --------------------------------------------------- signal disposition */

/**
 * What became of a signal.
 *
 * Recorded for EVERY signal, including the ones that went nowhere. "Why did
 * this not trade?" is as important an audit question as "why did this trade?",
 * and without an explicit record the answer has to be reverse-engineered from
 * thresholds months later.
 */
export type SignalDisposition =
  | 'PROPOSED'
  | 'BELOW_SIGNAL_THRESHOLD'
  | 'NOT_LONG'
  | 'SECURITY_UNAVAILABLE'
  | 'NO_MARKET_PRICE'
  | 'NOT_SIZEABLE'
  | 'STRATEGY_RISK_BREACH'
  | 'AWAITING_LIVE_APPROVAL'
  | 'RISK_REJECTED';

export interface SignalDispositionRecord {
  signalId: string;
  disposition: SignalDisposition;
  detail: string;
  at: string;
  proposalId?: string;
}

/* ---------------------------------------------------------- decision log */

export type DecisionStage =
  | 'INGEST'
  | 'FILTER'
  | 'RESOLVE'
  | 'SIGNAL'
  | 'PROPOSAL'
  | 'RISK'
  | 'APPROVAL'
  | 'ORDER'
  | 'FILL'
  | 'POSITION'
  | 'EXIT'
  | 'OUTCOME'
  | 'HEALTH'
  | 'SYSTEM';

export interface DecisionLogEntry {
  logId: string;
  correlationId: string;
  strategyId: string;
  stage: DecisionStage;
  at: string;
  subjectId: string;
  summary: string;
  payload: Record<string, unknown>;
}

/* ----------------------------------------------------------- market data */

export interface PriceBar {
  ticker: string;
  /** Bar start time. */
  at: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}

export interface Quote {
  ticker: string;
  price: number;
  asOf: string;
  /** Minutes since the quote was struck, computed against the Clock. */
  ageMinutes: number;
  stale: boolean;
}

export interface MarketCalendarStatus {
  isOpen: boolean;
  asOf: string;
  nextOpen: string | null;
  nextClose: string | null;
  reason: string;
}

/* --------------------------------------------------------------- health */

export type HealthFault =
  | 'STALE_MARKET_DATA'
  | 'BROKER_AUTH_FAILURE'
  | 'REPEATED_API_FAILURE'
  | 'SOCIAL_PROVIDER_FAILURE'
  | 'CORRUPT_STRATEGY_STATE'
  | 'LEDGER_MISMATCH'
  | 'MANUAL_KILL';

export interface HealthIncident {
  incidentId: string;
  strategyId: string;
  fault: HealthFault;
  at: string;
  detail: string;
  /** Whether this incident paused the strategy. */
  paused: boolean;
  resolvedAt: string | null;
}
