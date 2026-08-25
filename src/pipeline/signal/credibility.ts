/**
 * Credibility.
 *
 * How reliable is the source of this information?
 *
 * Tier does the work. Follower count contributes at most `MAX_POPULARITY_BONUS`
 * points and can never move an account between tiers — the spec's rule that
 * follower count alone is not credibility is enforced structurally here, not by
 * convention.
 *
 * Output: 0..100.
 */
import { clamp } from '../../core/index.js';
import type { SourceClass, SourceTier } from '../../domain/types.js';

/** Base credibility by tier. */
export const TIER_BASE: Record<SourceTier, number> = {
  TIER_1: 88,
  TIER_2: 72,
  TIER_3: 52,
  TIER_4: 22,
};

/**
 * Small within-tier adjustments. A company's own account speaking about itself
 * outranks a generic corporate account; a regulator outranks both on
 * enforcement matters.
 */
const CLASS_ADJUSTMENT: Record<SourceClass, number> = {
  COMPANY_OFFICIAL: 6,
  COMPANY_EXECUTIVE: 4,
  REGULATOR: 8,
  GOVERNMENT_AGENCY: 6,
  EXCHANGE: 5,
  FINANCIAL_JOURNALIST: 3,
  INDUSTRY_EXPERT: 2,
  SPECIALIST_PUBLICATION: 5,
  SELL_SIDE_ANALYST: 3,
  SPECIALIST_COMMENTATOR: 0,
  INDUSTRY_PARTICIPANT: 1,
  GENERAL_ACCOUNT: 0,
  UNVERIFIED_COMMENTARY: -4,
};

/** Hard cap on how much reach can ever be worth. */
export const MAX_POPULARITY_BONUS = 5;

export interface CredibilityInput {
  sourceTier: SourceTier;
  sourceClass: SourceClass;
  verified: boolean;
  followerCount: number;
  accountCreatedAt?: string;
  /** True when the account officially represents the resolved security. */
  isOfficialForSecurity: boolean;
  nowMs: number;
}

export interface CredibilityResult {
  score: number;
  base: number;
  popularityBonus: number;
  adjustments: { reason: string; delta: number }[];
  explanation: string;
}

export function scoreCredibility(input: CredibilityInput): CredibilityResult {
  const base = TIER_BASE[input.sourceTier];
  const adjustments: { reason: string; delta: number }[] = [];

  const classDelta = CLASS_ADJUSTMENT[input.sourceClass];
  if (classDelta !== 0) {
    adjustments.push({ reason: `Source class ${input.sourceClass}`, delta: classDelta });
  }

  if (input.isOfficialForSecurity) {
    adjustments.push({ reason: 'Account officially represents this company', delta: 5 });
  }

  // Verification is weak evidence and worth almost nothing on its own.
  if (input.verified && input.sourceTier === 'TIER_4') {
    adjustments.push({ reason: 'Verified (weak signal at Tier 4)', delta: 2 });
  }

  // Account age: a two-week-old account making market claims is suspect.
  if (input.accountCreatedAt) {
    const ageDays = (input.nowMs - new Date(input.accountCreatedAt).getTime()) / 86_400_000;
    if (ageDays < 30) adjustments.push({ reason: `Account only ${Math.round(ageDays)} days old`, delta: -15 });
    else if (ageDays < 180) adjustments.push({ reason: 'Account under 6 months old', delta: -6 });
  }

  /*
   * Popularity term. Logarithmic and hard-capped at MAX_POPULARITY_BONUS
   * points, which is smaller than the gap between any two tiers. A 10M-follower
   * anonymous account therefore still scores below a 5k-follower regulator.
   */
  const followers = Math.max(0, input.followerCount);
  const popularityBonus =
    followers < 1000 ? 0 : clamp((Math.log10(followers) - 3) / 4, 0, 1) * MAX_POPULARITY_BONUS;

  const total = base + adjustments.reduce((a, x) => a + x.delta, 0) + popularityBonus;
  const score = Math.round(clamp(total, 0, 100));

  const explanation =
    `${input.sourceTier.replace('_', ' ')} (${input.sourceClass.replace(/_/g, ' ').toLowerCase()}) ` +
    `base ${base}` +
    (adjustments.length > 0 ? `, ${adjustments.map((a) => `${a.delta > 0 ? '+' : ''}${a.delta} ${a.reason.toLowerCase()}`).join(', ')}` : '') +
    `, +${popularityBonus.toFixed(1)} reach (capped at ${MAX_POPULARITY_BONUS})`;

  return {
    score,
    base,
    popularityBonus: Number(popularityBonus.toFixed(2)),
    adjustments,
    explanation,
  };
}

/**
 * Cluster credibility.
 *
 * Takes the best source rather than the average: one regulator saying something
 * is not made less credible by a hundred anonymous accounts repeating it. The
 * crowd's contribution is handled by cross-source confirmation instead.
 * A small bonus applies when more than one *credible* (Tier 1–2) source is
 * present.
 */
export function aggregateCredibility(
  entries: { credibility: number; tier: SourceTier; weight: number }[],
): number {
  const usable = entries.filter((e) => e.weight > 0);
  if (usable.length === 0) return 0;

  const best = Math.max(...usable.map((e) => e.credibility));
  const credibleSources = usable.filter((e) => e.tier === 'TIER_1' || e.tier === 'TIER_2').length;
  const bonus = credibleSources >= 2 ? Math.min(6, (credibleSources - 1) * 3) : 0;

  return Math.round(clamp(best + bonus, 0, 100));
}
