/**
 * X Signal composite configuration.
 *
 * Weights are NOT arbitrary constants scattered through the engine. They live
 * in a versioned, immutable config object so that Trading Lab can sweep them as
 * an experiment and so that any historical signal can be recomputed exactly by
 * looking up the `signalConfigId` recorded on it.
 *
 * ---------------------------------------------------------------------------
 * How the composite is built, and why
 * ---------------------------------------------------------------------------
 * The composite deliberately does NOT sum eight weighted numbers into a score.
 * A plain weighted sum lets a loud, popular, recent, meaningless post score
 * highly on six dimensions and produce a trade. Instead:
 *
 *   1. DIRECTION comes only from `sentiment` — the directional read of what the
 *      information says about the company. Nothing else can flip the sign.
 *
 *   2. CONVICTION is a weighted mean of the six non-directional dimensions
 *      (materiality, credibility, novelty, engagement velocity, cross-source
 *      confirmation, recency), each 0..100, normalised to 0..1. Conviction
 *      SCALES the direction; it cannot create it. A maximally credible, novel,
 *      material post with neutral sentiment scores ~0, which is correct: it is
 *      information, not a trade.
 *
 *   3. base = sentiment * conviction                       (-100..+100)
 *
 *   4. PRICE CONFIRMATION is a bounded additive adjustment, capped at
 *      `maxPriceContribution` points, and gated so it can only apply once the
 *      X-derived base already clears `priceGateMinAbsBase`. This is the
 *      guardrail that keeps the strategy an X strategy: price data corroborates
 *      or discounts an information thesis, it never manufactures one. Without
 *      the gate, quiet days with drifting prices would slowly turn this into a
 *      momentum bot.
 *
 *   5. score = clamp(base + priceAdjustment, -100, +100)
 *
 * Every step is reported as a ComponentContribution so the UI can show exactly
 * where the points came from.
 */

export interface ConvictionWeights {
  materiality: number;
  credibility: number;
  novelty: number;
  engagementVelocity: number;
  crossSourceConfirmation: number;
  recency: number;
}

export interface SignalBandThresholds {
  strongBearish: number;
  bearish: number;
  bullish: number;
  strongBullish: number;
}

export interface SignalEngineConfig {
  /** Immutable identity. Change any value below and you must change this id. */
  signalConfigId: string;
  description: string;

  /** Weights of the conviction blend. Normalised at load; need not sum to 1. */
  convictionWeights: ConvictionWeights;

  /** Maximum points price confirmation may add or remove from the composite. */
  maxPriceContribution: number;
  /** X-derived base magnitude required before price confirmation applies. */
  priceGateMinAbsBase: number;

  bands: SignalBandThresholds;

  /** Half-life (hours) of the recency decay. */
  recencyHalfLifeHours: number;
  /** Events older than this are not eligible to trigger a signal at all. */
  maxEventAgeHours: number;

  /** Independent credible sources at which cross-source confirmation saturates. */
  crossSourceSaturationCount: number;
  /** Tier weights used when counting "independent credible" sources. */
  tierIndependenceWeight: Record<'TIER_1' | 'TIER_2' | 'TIER_3' | 'TIER_4', number>;

  /** Engagement velocity: multiple of author baseline at which it saturates. */
  engagementSaturationMultiple: number;

  /** Novelty: half-life (hours) of a story's freshness once first seen. */
  noveltyHalfLifeHours: number;

  /**
   * Minimum minutes between two signals on the same security when no NEW
   * evidence has arrived.
   *
   * Without this the engine re-scores the same stored events on every cycle and
   * emits a near-duplicate signal each time, which floods the analytics sample
   * with correlated rows and makes hit rate meaningless. Fresh evidence always
   * bypasses the interval; the interval only governs pure re-evaluation, which
   * still needs to happen periodically because the exit engine watches the
   * live signal for reversals.
   */
  resignalIntervalMinutes: number;

  /** Price confirmation feature weights (they blend into one -100..100 number). */
  priceFeatureWeights: {
    momentum: number;
    abnormalMove: number;
    abnormalVolume: number;
    marketRelative: number;
  };
  /** Lookback in trading days for momentum / market-relative features. */
  priceLookbackDays: number;

  /** Uncertainty model inputs. */
  uncertainty: {
    /** Independent sources at/above which source-thinness stops contributing. */
    comfortableSourceCount: number;
    /** Weight of each uncertainty driver; normalised at use. */
    weights: {
      sourceThinness: number;
      resolutionAmbiguity: number;
      sentimentDisagreement: number;
      priceDataUnavailable: number;
      lowMateriality: number;
    };
  };
}

/**
 * v1 weights and the reasoning behind each.
 *
 * credibility (0.26) — highest single weight. The single most common way a
 *   social signal goes wrong is trusting an account that had no business
 *   knowing anything. Tier is the strongest available prior.
 * materiality (0.24) — second. "Could this move fundamentals?" separates a CEO
 *   announcing an acquisition from a CEO posting a photo.
 * crossSourceConfirmation (0.18) — independent corroboration is the main
 *   defence against a single fabricated or misread post.
 * novelty (0.14) — information already in the tape is not tradable; this
 *   discounts the 400th retelling of a two-day-old story.
 * recency (0.10) — a real but hours-old event is still worth less than a
 *   minutes-old one, but recency alone is nearly worthless, hence the low
 *   weight.
 * engagementVelocity (0.08) — lowest. Attention is the most gameable dimension
 *   on X, so it is a tiebreaker, never a driver.
 */
export const SIGNAL_CONFIG_V1: SignalEngineConfig = {
  signalConfigId: 'x-signal-config-v1',
  description:
    'X Signal v1 — direction from sentiment, magnitude from a conviction blend, price data as bounded gated confirmation.',

  convictionWeights: {
    materiality: 0.24,
    credibility: 0.26,
    novelty: 0.14,
    engagementVelocity: 0.08,
    crossSourceConfirmation: 0.18,
    recency: 0.1,
  },

  maxPriceContribution: 15,
  priceGateMinAbsBase: 20,

  bands: {
    strongBearish: -60,
    bearish: -25,
    bullish: 25,
    strongBullish: 60,
  },

  recencyHalfLifeHours: 6,
  maxEventAgeHours: 48,

  crossSourceSaturationCount: 4,
  tierIndependenceWeight: {
    TIER_1: 1.0,
    TIER_2: 0.8,
    TIER_3: 0.45,
    TIER_4: 0.1,
  },

  engagementSaturationMultiple: 8,

  noveltyHalfLifeHours: 3,

  resignalIntervalMinutes: 60,

  priceFeatureWeights: {
    momentum: 0.3,
    abnormalMove: 0.35,
    abnormalVolume: 0.15,
    marketRelative: 0.2,
  },
  priceLookbackDays: 5,

  uncertainty: {
    comfortableSourceCount: 3,
    weights: {
      sourceThinness: 0.3,
      resolutionAmbiguity: 0.25,
      sentimentDisagreement: 0.2,
      priceDataUnavailable: 0.1,
      lowMateriality: 0.15,
    },
  },
};

const REGISTRY = new Map<string, SignalEngineConfig>([[SIGNAL_CONFIG_V1.signalConfigId, SIGNAL_CONFIG_V1]]);

export function getSignalConfig(id: string): SignalEngineConfig {
  const cfg = REGISTRY.get(id);
  if (!cfg) throw new Error(`Unknown signal config: ${id}`);
  return cfg;
}

export function registerSignalConfig(cfg: SignalEngineConfig): void {
  if (REGISTRY.has(cfg.signalConfigId)) {
    throw new Error(`Signal config ${cfg.signalConfigId} already registered; configs are immutable.`);
  }
  REGISTRY.set(cfg.signalConfigId, cfg);
}

export function listSignalConfigs(): SignalEngineConfig[] {
  return [...REGISTRY.values()];
}

/**
 * Build an experiment variant. Trading Lab uses this to sweep weights without
 * mutating v1 — the variant gets its own id, so signals stay reproducible.
 */
export function deriveSignalConfig(
  base: SignalEngineConfig,
  id: string,
  description: string,
  overrides: Partial<Omit<SignalEngineConfig, 'signalConfigId' | 'description'>>,
): SignalEngineConfig {
  const variant: SignalEngineConfig = {
    ...structuredClone(base),
    ...structuredClone(overrides),
    signalConfigId: id,
    description,
  };
  return variant;
}
