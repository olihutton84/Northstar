/**
 * The composite signal.
 *
 * Structure (see config/signalConfig.ts for the full rationale):
 *
 *   direction  = sentiment                       (only sentiment sets the sign)
 *   conviction = weighted mean of the six non-directional dimensions / 100
 *   base       = sentiment * conviction
 *   priceAdj   = gated, capped contribution from market data
 *   score      = clamp(base + priceAdj, -100, +100)
 *
 * Every number produced here is accompanied by a ComponentContribution saying
 * how many points it was worth and why, and by a narrative explanation. The
 * engine never returns an unexplained number.
 */
import { clamp } from '../../core/index.js';
import type { SignalEngineConfig } from '../../config/signalConfig.js';
import type { ComponentContribution, SignalBand, SignalComponents } from '../../domain/types.js';

export interface CompositeInput {
  components: SignalComponents;
  config: SignalEngineConfig;
}

export interface CompositeResult {
  score: number;
  band: SignalBand;
  base: number;
  conviction: number;
  priceAdjustment: number;
  /** True when the price gate BLOCKED the market-data adjustment. */
  priceGateBlocked: boolean;
  contributions: ComponentContribution[];
}

export function bandFor(score: number, config: SignalEngineConfig): SignalBand {
  const b = config.bands;
  if (score <= b.strongBearish) return 'STRONG_BEARISH';
  if (score <= b.bearish) return 'BEARISH';
  if (score >= b.strongBullish) return 'STRONG_BULLISH';
  if (score >= b.bullish) return 'BULLISH';
  return 'NEUTRAL';
}

export function bandLabel(band: SignalBand): string {
  return {
    STRONG_BEARISH: 'Strong Bearish',
    BEARISH: 'Bearish',
    NEUTRAL: 'Neutral',
    BULLISH: 'Bullish',
    STRONG_BULLISH: 'Strong Bullish',
  }[band];
}

export function computeComposite(input: CompositeInput): CompositeResult {
  const { components: c, config } = input;
  const w = config.convictionWeights;

  const weightTotal =
    w.materiality + w.credibility + w.novelty + w.engagementVelocity + w.crossSourceConfirmation + w.recency;
  const safeTotal = weightTotal === 0 ? 1 : weightTotal;

  const convictionTerms: { key: keyof SignalComponents; raw: number; weight: number }[] = [
    { key: 'materiality', raw: clamp(c.materiality, 0, 100), weight: w.materiality },
    { key: 'credibility', raw: clamp(c.credibility, 0, 100), weight: w.credibility },
    { key: 'novelty', raw: clamp(c.novelty, 0, 100), weight: w.novelty },
    { key: 'engagementVelocity', raw: clamp(c.engagementVelocity, 0, 100), weight: w.engagementVelocity },
    { key: 'crossSourceConfirmation', raw: clamp(c.crossSourceConfirmation, 0, 100), weight: w.crossSourceConfirmation },
    { key: 'recency', raw: clamp(c.recency, 0, 100), weight: w.recency },
  ];

  const convictionScore = convictionTerms.reduce((a, t) => a + t.raw * t.weight, 0) / safeTotal;
  const conviction = clamp(convictionScore / 100, 0, 1);

  const sentiment = clamp(c.sentiment, -100, 100);
  const base = sentiment * conviction;

  // --- price confirmation: gated and capped -----------------------------
  const gatePassed = Math.abs(base) >= config.priceGateMinAbsBase;
  const priceRaw = clamp(c.priceConfirmation, -100, 100);
  // The adjustment is applied in the direction of the thesis: price data that
  // agrees with a bullish base adds points, price data that disagrees removes
  // them. On a bearish base the mapping is mirrored.
  const agreement = base === 0 ? 0 : Math.sign(base) * priceRaw;
  const priceAdjustment = gatePassed
    ? Math.sign(base) * clamp(agreement / 100, -1, 1) * config.maxPriceContribution
    : 0;

  const score = Math.round(clamp(base + priceAdjustment, -100, 100));

  /* ----------------------------------------------------- contributions */
  const contributions: ComponentContribution[] = [];

  contributions.push({
    component: 'sentiment',
    raw: sentiment,
    weight: 1,
    // Sentiment "owns" the base; conviction is what scaled it.
    contribution: Number(base.toFixed(2)),
    explanation:
      `Sentiment ${sentiment >= 0 ? '+' : ''}${sentiment} sets the direction and magnitude, ` +
      `scaled by conviction ${(conviction * 100).toFixed(0)}% to ${base.toFixed(1)} points.`,
  });

  for (const t of convictionTerms) {
    // Marginal contribution: how many points of the base this dimension is
    // responsible for, via its share of conviction.
    const share = (t.raw * t.weight) / safeTotal / 100;
    const points = sentiment * share;
    contributions.push({
      component: t.key,
      raw: Math.round(t.raw),
      weight: Number((t.weight / safeTotal).toFixed(4)),
      contribution: Number(points.toFixed(2)),
      explanation:
        `${labelFor(t.key)} scored ${Math.round(t.raw)}/100 at weight ${(t.weight / safeTotal * 100).toFixed(0)}% ` +
        `of conviction, worth ${points >= 0 ? '+' : ''}${points.toFixed(1)} points.`,
    });
  }

  contributions.push({
    component: 'priceConfirmation',
    raw: priceRaw,
    weight: config.maxPriceContribution / 100,
    contribution: Number(priceAdjustment.toFixed(2)),
    explanation: gatePassed
      ? `Market data ${agreement >= 0 ? 'corroborates' : 'contradicts'} the thesis ` +
        `(${priceRaw >= 0 ? '+' : ''}${priceRaw}), worth ${priceAdjustment >= 0 ? '+' : ''}${priceAdjustment.toFixed(1)} ` +
        `points (capped at ±${config.maxPriceContribution}).`
      : `Price confirmation withheld: the X-derived base of ${base.toFixed(1)} is below the ` +
        `${config.priceGateMinAbsBase}-point gate, so market data alone cannot create a signal.`,
  });

  contributions.push({
    component: 'priceAdjustment',
    raw: Number(priceAdjustment.toFixed(2)),
    weight: 1,
    contribution: Number(priceAdjustment.toFixed(2)),
    explanation:
      `Final score ${score}: X-derived base ${base.toFixed(1)} ` +
      `${priceAdjustment >= 0 ? '+' : '-'} ${Math.abs(priceAdjustment).toFixed(1)} from market data` +
      `${gatePassed ? '' : ' (withheld — the base did not clear the price gate)'}.`,
  });

  return {
    score,
    band: bandFor(score, config),
    base: Number(base.toFixed(2)),
    conviction: Number(conviction.toFixed(4)),
    priceAdjustment: Number(priceAdjustment.toFixed(2)),
    priceGateBlocked: !gatePassed,
    contributions,
  };
}

function labelFor(key: keyof SignalComponents): string {
  return {
    sentiment: 'Sentiment',
    materiality: 'Materiality',
    credibility: 'Credibility',
    novelty: 'Novelty',
    engagementVelocity: 'Engagement velocity',
    crossSourceConfirmation: 'Cross-source confirmation',
    priceConfirmation: 'Price confirmation',
    recency: 'Recency',
  }[key];
}

/* -------------------------------------------------------- uncertainty */

export interface UncertaintyInput {
  independentSourceCount: number;
  resolutionConfidence: number;
  sentimentDisagreement: number;
  priceDataAvailable: boolean;
  materiality: number;
  config: SignalEngineConfig;
}

export interface UncertaintyResult {
  /** 0 (well-evidenced) .. 1 (thin inference). */
  value: number;
  drivers: { driver: string; contribution: number; note: string }[];
}

/**
 * Uncertainty is *not* one minus confidence. It measures how thin the evidence
 * is, independently of how extreme the score is — a -80 signal from one
 * anonymous account is both strong and highly uncertain, and the risk engine
 * needs to see both numbers.
 */
export function computeUncertainty(input: UncertaintyInput): UncertaintyResult {
  const w = input.config.uncertainty.weights;
  const total = w.sourceThinness + w.resolutionAmbiguity + w.sentimentDisagreement + w.priceDataUnavailable + w.lowMateriality;
  const safe = total === 0 ? 1 : total;

  const comfortable = Math.max(1, input.config.uncertainty.comfortableSourceCount);
  const sourceThinness = clamp(1 - input.independentSourceCount / comfortable, 0, 1);
  const resolutionAmbiguity = clamp(1 - input.resolutionConfidence, 0, 1);
  const disagreement = clamp(input.sentimentDisagreement, 0, 1);
  const priceMissing = input.priceDataAvailable ? 0 : 1;
  const lowMateriality = clamp(1 - input.materiality / 100, 0, 1);

  const drivers = [
    {
      driver: 'sourceThinness',
      contribution: (sourceThinness * w.sourceThinness) / safe,
      note: `${input.independentSourceCount.toFixed(2)} independent source(s) vs ${comfortable} considered comfortable`,
    },
    {
      driver: 'resolutionAmbiguity',
      contribution: (resolutionAmbiguity * w.resolutionAmbiguity) / safe,
      note: `Entity resolution confidence ${(input.resolutionConfidence * 100).toFixed(0)}%`,
    },
    {
      driver: 'sentimentDisagreement',
      contribution: (disagreement * w.sentimentDisagreement) / safe,
      note: disagreement > 0 ? `Sources disagree on direction (${(disagreement * 100).toFixed(0)}% split)` : 'Sources agree on direction',
    },
    {
      driver: 'priceDataUnavailable',
      contribution: (priceMissing * w.priceDataUnavailable) / safe,
      note: input.priceDataAvailable ? 'Market data available for confirmation' : 'No market data available to corroborate',
    },
    {
      driver: 'lowMateriality',
      contribution: (lowMateriality * w.lowMateriality) / safe,
      note: `Materiality ${Math.round(input.materiality)}/100`,
    },
  ].map((d) => ({ ...d, contribution: Number(d.contribution.toFixed(4)) }));

  const value = clamp(drivers.reduce((a, d) => a + d.contribution, 0), 0, 1);
  return { value: Number(value.toFixed(4)), drivers };
}
