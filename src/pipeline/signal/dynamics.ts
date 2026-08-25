/**
 * Novelty, engagement velocity, cross-source confirmation and recency.
 *
 * These four dimensions describe how information is *moving*, as opposed to
 * what it says (sentiment), how much it matters (materiality) or who said it
 * (credibility).
 *
 * All four return 0..100.
 */
import { clamp } from '../../core/index.js';
import type { EngagementMetrics, SourceTier } from '../../domain/types.js';
import type { SignalEngineConfig } from '../../config/signalConfig.js';

/* --------------------------------------------------------------- novelty */

export interface NoveltyInput {
  /** When this event was posted. */
  postedAtMs: number;
  /**
   * When the *cluster* was first observed. Equal to postedAtMs for the first
   * post of a story; earlier for every retelling.
   */
  clusterFirstSeenMs: number;
  /** How many events already exist in this cluster, excluding this one. */
  priorClusterSize: number;
  /** True when a prior signal already fired on this cluster. */
  alreadySignalled: boolean;
  halfLifeHours: number;
}

export interface NoveltyResult {
  score: number;
  ageInStoryHours: number;
  explanation: string;
}

/**
 * Novelty decays with how long the *story* has been circulating, not with how
 * old the post is. The 300th retelling of a two-hour-old story is not novel
 * even if it was posted a second ago.
 *
 * A cluster that has already produced a signal is heavily discounted: acting on
 * it again is the same trade twice.
 */
export function scoreNovelty(input: NoveltyInput): NoveltyResult {
  const ageHours = Math.max(0, (input.postedAtMs - input.clusterFirstSeenMs) / 3_600_000);
  const decay = 2 ** (-ageHours / Math.max(0.25, input.halfLifeHours));

  // Crowding penalty: each prior post in the cluster shaves novelty, saturating
  // so that a huge cluster does not go negative.
  const crowding = 1 / (1 + input.priorClusterSize * 0.35);

  let score = 100 * decay * crowding;
  if (input.alreadySignalled) score *= 0.25;

  const explanation = input.priorClusterSize === 0
    ? 'First observation of this story'
    : `Story first seen ${ageHours.toFixed(1)}h ago, ${input.priorClusterSize} prior post(s) in the cluster` +
      (input.alreadySignalled ? '; a signal already fired on this story' : '');

  return { score: Math.round(clamp(score, 0, 100)), ageInStoryHours: Number(ageHours.toFixed(2)), explanation };
}

/* --------------------------------------------------- engagement velocity */

export interface EngagementInput {
  engagement: EngagementMetrics;
  /** The author's typical total engagement, captured at ingest time. */
  authorBaseline: number;
  /** Minutes since the post was published. */
  ageMinutes: number;
  saturationMultiple: number;
  tier: SourceTier;
}

export interface EngagementResult {
  score: number;
  total: number;
  ratioToBaseline: number;
  perHour: number;
  explanation: string;
}

/**
 * "Is credible attention accelerating unusually?"
 *
 * Measured relative to the author's own baseline, so a 500-like post from an
 * account that normally gets 20 scores high while a 500-like post from an
 * account that normally gets 50,000 scores low. Absolute popularity is
 * deliberately not rewarded.
 *
 * Tier 4 engagement is halved: a mob is the easiest thing on X to manufacture.
 */
export function scoreEngagementVelocity(input: EngagementInput): EngagementResult {
  const e = input.engagement;
  const total = e.likes + e.reposts * 2 + e.quotes * 2 + e.replies;
  const hours = Math.max(1 / 12, input.ageMinutes / 60); // floor at 5 minutes
  const perHour = total / hours;

  const baseline = Math.max(1, input.authorBaseline);
  const ratio = total / baseline;

  // Log-scaled against the saturation multiple so the curve is steep early
  // (2x baseline is interesting) and flat late (50x vs 100x barely differs).
  const normalised = ratio <= 1 ? 0 : Math.log(ratio) / Math.log(Math.max(2, input.saturationMultiple));
  let score = clamp(normalised, 0, 1) * 100;

  if (input.tier === 'TIER_4') score *= 0.5;
  if (input.tier === 'TIER_3') score *= 0.8;

  const explanation =
    `${total} weighted interactions (${perHour.toFixed(0)}/h), ${ratio.toFixed(1)}x the author's baseline of ${baseline.toFixed(0)}` +
    (input.tier === 'TIER_4' ? '; halved for an unverified source' : '');

  return {
    score: Math.round(clamp(score, 0, 100)),
    total,
    ratioToBaseline: Number(ratio.toFixed(2)),
    perHour: Number(perHour.toFixed(1)),
    explanation,
  };
}

/* --------------------------------------------- cross-source confirmation */

export interface CrossSourceInput {
  /** One entry per *distinct author* in the cluster. */
  sources: { authorId: string; tier: SourceTier; weight: number }[];
  config: SignalEngineConfig;
}

export interface CrossSourceResult {
  score: number;
  distinctAuthors: number;
  /** Tier-weighted count of genuinely independent credible sources. */
  independentSourceCount: number;
  explanation: string;
}

/**
 * "Are independent credible sources discussing the same development?"
 *
 * Counts distinct AUTHORS, tier-weighted, not posts. Tier 4 accounts are worth
 * 0.1 each, so a hundred anonymous accounts amount to ten weighted sources —
 * still less than two journalists. This is the structural answer to "a story
 * repeated by 100 accounts is not 100 pieces of evidence".
 */
export function scoreCrossSourceConfirmation(input: CrossSourceInput): CrossSourceResult {
  const byAuthor = new Map<string, { tier: SourceTier; weight: number }>();
  for (const s of input.sources) {
    if (s.weight <= 0) continue;
    const existing = byAuthor.get(s.authorId);
    // Keep the author's strongest contribution; posting five times is one source.
    if (!existing || s.weight > existing.weight) byAuthor.set(s.authorId, { tier: s.tier, weight: s.weight });
  }

  let independent = 0;
  for (const { tier, weight } of byAuthor.values()) {
    independent += input.config.tierIndependenceWeight[tier] * weight;
  }
  independent = Number(independent.toFixed(3));

  // A single source gives no confirmation at all — confirmation is by
  // definition about a second, independent voice.
  const saturation = Math.max(1, input.config.crossSourceSaturationCount);
  const score = independent <= 1 ? 0 : clamp((independent - 1) / (saturation - 1), 0, 1) * 100;

  const tierCounts = new Map<SourceTier, number>();
  for (const { tier } of byAuthor.values()) tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
  const breakdown = [...tierCounts.entries()]
    .sort()
    .map(([tier, n]) => `${n}x ${tier.replace('_', ' ')}`)
    .join(', ');

  return {
    score: Math.round(clamp(score, 0, 100)),
    distinctAuthors: byAuthor.size,
    independentSourceCount: independent,
    explanation:
      byAuthor.size <= 1
        ? 'Single source — no independent confirmation'
        : `${byAuthor.size} distinct authors (${breakdown}) = ${independent.toFixed(2)} tier-weighted independent sources`,
  };
}

/* --------------------------------------------------------------- recency */

export interface RecencyResult {
  score: number;
  ageHours: number;
  explanation: string;
}

/** Exponential decay on the age of the newest triggering event. */
export function scoreRecency(newestPostedAtMs: number, nowMs: number, halfLifeHours: number): RecencyResult {
  const ageHours = Math.max(0, (nowMs - newestPostedAtMs) / 3_600_000);
  const score = 100 * 2 ** (-ageHours / Math.max(0.25, halfLifeHours));
  return {
    score: Math.round(clamp(score, 0, 100)),
    ageHours: Number(ageHours.toFixed(2)),
    explanation: `Newest supporting post is ${ageHours < 1 ? `${Math.round(ageHours * 60)} minutes` : `${ageHours.toFixed(1)} hours`} old (half-life ${halfLifeHours}h)`,
  };
}
