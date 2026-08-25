/**
 * Unit tests for the scored dimensions and the composite.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SIGNAL_CONFIG_V1, deriveSignalConfig } from '../../src/config/signalConfig.js';
import type { SignalComponents } from '../../src/domain/types.js';
import { bandFor, computeComposite, computeUncertainty } from '../../src/pipeline/signal/composite.js';
import { MAX_POPULARITY_BONUS, aggregateCredibility, scoreCredibility } from '../../src/pipeline/signal/credibility.js';
import {
  scoreCrossSourceConfirmation,
  scoreEngagementVelocity,
  scoreNovelty,
  scoreRecency,
} from '../../src/pipeline/signal/dynamics.js';
import { aggregateMateriality, scoreMateriality } from '../../src/pipeline/signal/materiality.js';
import { aggregateSentiment, scoreSentiment } from '../../src/pipeline/signal/sentiment.js';

const NOW = new Date('2026-03-10T15:00:00.000Z').getTime();

/* -------------------------------------------------------------- sentiment */

describe('sentiment', () => {
  it('reads finance-specific language, not general English', () => {
    assert.ok(scoreSentiment('Company raises guidance for the full year').score > 60);
    assert.ok(scoreSentiment('Company cuts guidance for the full year').score < -60);
    assert.ok(scoreSentiment('Earnings beat expectations comfortably').score > 50);
    assert.ok(scoreSentiment('Earnings missed expectations badly').score < -50);
  });

  it('returns neutral for text with no directional content', () => {
    assert.equal(scoreSentiment('The company held its annual meeting in Denver on Tuesday.').score, 0);
  });

  it('handles negation', () => {
    const plain = scoreSentiment('The company will cut guidance.');
    const negated = scoreSentiment('The company denies it will cut guidance.');
    assert.ok(plain.score < 0);
    assert.ok(negated.score > plain.score, 'a denial must not read as the event itself');
  });

  it('discounts hedged claims', () => {
    const firm = scoreSentiment('Acme raises guidance to $4B.');
    const hedged = scoreSentiment('Acme reportedly may raise guidance to $4B.');
    assert.ok(Math.abs(hedged.score) < Math.abs(firm.score), 'rumours must score lower than facts');
  });

  it('lets a single extreme term dominate a long mild post', () => {
    const long =
      'The quarter showed growth in several segments and expansion into new markets with positive ' +
      'commentary from management, however the company cuts guidance for the year.';
    assert.ok(scoreSentiment(long).score < 0, 'a guidance cut must not be diluted by mild positives');
  });

  it('is deterministic', () => {
    const text = 'NVIDIA raises guidance to $32.5B on record demand.';
    assert.equal(scoreSentiment(text).score, scoreSentiment(text).score);
  });

  it('aggregates by weight and reports disagreement', () => {
    const agree = aggregateSentiment([{ sentiment: 80, weight: 1 }, { sentiment: 70, weight: 1 }]);
    assert.ok(agree.score > 70);
    assert.equal(agree.disagreement, 0);

    const split = aggregateSentiment([{ sentiment: 80, weight: 1 }, { sentiment: -80, weight: 1 }]);
    assert.equal(split.disagreement, 1, 'an even split is maximal disagreement');
    assert.equal(split.score, 0);
  });

  it('ignores zero-weight (filtered-out) evidence', () => {
    const result = aggregateSentiment([{ sentiment: 90, weight: 1 }, { sentiment: -90, weight: 0 }]);
    assert.equal(result.score, 90);
  });
});

/* ------------------------------------------------------------ materiality */

describe('materiality', () => {
  it('ranks corporate events above commentary', () => {
    const guidance = scoreMateriality('Acme raises its full-year guidance to $4.2B.');
    const chat = scoreMateriality('Nice to see the team at the Acme booth again this year.');
    assert.ok(guidance.score > chat.score + 40);
    assert.equal(guidance.eventType, 'GUIDANCE_CHANGE');
    assert.equal(chat.eventType, 'GENERAL_COMMENTARY');
  });

  it('classifies the major event types', () => {
    assert.equal(scoreMateriality('Acme to acquire Beta Corp in an all-cash deal').eventType, 'MERGER_ACQUISITION');
    assert.equal(scoreMateriality('FDA approval granted for the new therapy').eventType, 'REGULATORY_APPROVAL');
    assert.equal(scoreMateriality('SEC opens an investigation into the company').eventType, 'REGULATORY_ACTION');
    assert.equal(scoreMateriality('Acme announces layoffs of 3,000 staff').eventType, 'WORKFORCE_ACTION');
    assert.equal(scoreMateriality('Analyst upgrades Acme with a $200 price target').eventType, 'ANALYST_ACTION');
    assert.equal(scoreMateriality('Acme files for chapter 11 bankruptcy').eventType, 'CREDIT_EVENT');
  });

  it('rewards specific figures and penalises rumour framing', () => {
    const specific = scoreMateriality('Acme raises guidance to $4.2B, up 18%.');
    const vague = scoreMateriality('Acme raises guidance.');
    const rumoured = scoreMateriality('Acme reportedly may raise guidance.');
    assert.ok(specific.score > vague.score);
    assert.ok(rumoured.score < vague.score);
  });

  it('takes the strongest well-supported reading across a cluster', () => {
    const result = aggregateMateriality([
      { materiality: 95, eventType: 'MERGER_ACQUISITION', weight: 1 },
      { materiality: 10, eventType: 'GENERAL_COMMENTARY', weight: 1 },
      { materiality: 10, eventType: 'GENERAL_COMMENTARY', weight: 1 },
    ]);
    assert.equal(result.dominantEventType, 'MERGER_ACQUISITION');
    assert.ok(result.score > 60, 'a crowd of vague posts must not dilute a real event');
  });
});

/* ------------------------------------------------------------ credibility */

describe('credibility and source tiers', () => {
  const base = { verified: false, followerCount: 0, isOfficialForSecurity: false, nowMs: NOW };

  it('ranks tiers in the intended order', () => {
    const t1 = scoreCredibility({ ...base, sourceTier: 'TIER_1', sourceClass: 'REGULATOR' });
    const t2 = scoreCredibility({ ...base, sourceTier: 'TIER_2', sourceClass: 'FINANCIAL_JOURNALIST' });
    const t3 = scoreCredibility({ ...base, sourceTier: 'TIER_3', sourceClass: 'SELL_SIDE_ANALYST' });
    const t4 = scoreCredibility({ ...base, sourceTier: 'TIER_4', sourceClass: 'UNVERIFIED_COMMENTARY' });
    assert.ok(t1.score > t2.score);
    assert.ok(t2.score > t3.score);
    assert.ok(t3.score > t4.score);
  });

  it('never lets follower count outrank tier', () => {
    const hugeAnon = scoreCredibility({
      ...base,
      sourceTier: 'TIER_4',
      sourceClass: 'UNVERIFIED_COMMENTARY',
      followerCount: 50_000_000,
    });
    const smallRegulator = scoreCredibility({
      ...base,
      sourceTier: 'TIER_1',
      sourceClass: 'REGULATOR',
      followerCount: 1200,
    });
    assert.ok(
      smallRegulator.score > hugeAnon.score,
      'a small regulator must outrank a huge anonymous account',
    );
    assert.ok(hugeAnon.popularityBonus <= MAX_POPULARITY_BONUS);
  });

  it('penalises very new accounts', () => {
    const fresh = scoreCredibility({
      ...base,
      sourceTier: 'TIER_3',
      sourceClass: 'SPECIALIST_COMMENTATOR',
      accountCreatedAt: new Date(NOW - 5 * 86_400_000).toISOString(),
    });
    const established = scoreCredibility({
      ...base,
      sourceTier: 'TIER_3',
      sourceClass: 'SPECIALIST_COMMENTATOR',
      accountCreatedAt: new Date(NOW - 5 * 365 * 86_400_000).toISOString(),
    });
    assert.ok(fresh.score < established.score - 10);
  });

  it('takes the best source, not the average, across a cluster', () => {
    const score = aggregateCredibility([
      { credibility: 92, tier: 'TIER_1', weight: 1 },
      ...Array.from({ length: 20 }, () => ({ credibility: 20, tier: 'TIER_4' as const, weight: 1 })),
    ]);
    assert.ok(score >= 92, 'a crowd of anonymous accounts cannot dilute a regulator');
  });
});

/* --------------------------------------------------------------- dynamics */

describe('novelty, engagement, confirmation and recency', () => {
  it('scores the first observation of a story highest', () => {
    const first = scoreNovelty({
      postedAtMs: NOW,
      clusterFirstSeenMs: NOW,
      priorClusterSize: 0,
      alreadySignalled: false,
      halfLifeHours: 3,
    });
    const retelling = scoreNovelty({
      postedAtMs: NOW,
      clusterFirstSeenMs: NOW - 4 * 3_600_000,
      priorClusterSize: 30,
      alreadySignalled: false,
      halfLifeHours: 3,
    });
    assert.equal(first.score, 100);
    assert.ok(retelling.score < 10, 'a well-worn story is not novel');
  });

  it('heavily discounts a story that already produced a signal', () => {
    const args = {
      postedAtMs: NOW,
      clusterFirstSeenMs: NOW,
      priorClusterSize: 1,
      halfLifeHours: 3,
    };
    const fresh = scoreNovelty({ ...args, alreadySignalled: false });
    const repeat = scoreNovelty({ ...args, alreadySignalled: true });
    assert.ok(repeat.score < fresh.score * 0.4);
  });

  it('measures engagement against the author baseline, not absolute reach', () => {
    const smallAccountSpike = scoreEngagementVelocity({
      engagement: { likes: 500, reposts: 100, replies: 40, quotes: 20 },
      authorBaseline: 20,
      ageMinutes: 30,
      saturationMultiple: 8,
      tier: 'TIER_2',
    });
    const bigAccountNormal = scoreEngagementVelocity({
      engagement: { likes: 500, reposts: 100, replies: 40, quotes: 20 },
      authorBaseline: 50_000,
      ageMinutes: 30,
      saturationMultiple: 8,
      tier: 'TIER_2',
    });
    assert.ok(smallAccountSpike.score > 80);
    assert.equal(bigAccountNormal.score, 0, 'below-baseline engagement is not a signal');
  });

  it('halves Tier 4 engagement because mobs are cheap to manufacture', () => {
    const args = {
      engagement: { likes: 5000, reposts: 1000, replies: 200, quotes: 100 },
      authorBaseline: 50,
      ageMinutes: 30,
      saturationMultiple: 8,
    };
    const tier2 = scoreEngagementVelocity({ ...args, tier: 'TIER_2' });
    const tier4 = scoreEngagementVelocity({ ...args, tier: 'TIER_4' });
    assert.ok(tier4.score <= tier2.score * 0.55);
  });

  it('gives no confirmation credit to a single source', () => {
    const result = scoreCrossSourceConfirmation({
      sources: [{ authorId: 'a', tier: 'TIER_1', weight: 1 }],
      config: SIGNAL_CONFIG_V1,
    });
    assert.equal(result.score, 0);
    assert.equal(result.distinctAuthors, 1);
  });

  it('counts one author once no matter how often they post', () => {
    const result = scoreCrossSourceConfirmation({
      sources: Array.from({ length: 8 }, () => ({ authorId: 'same', tier: 'TIER_1' as const, weight: 1 })),
      config: SIGNAL_CONFIG_V1,
    });
    assert.equal(result.distinctAuthors, 1);
    assert.equal(result.score, 0);
  });

  it('values two credible sources above a hundred anonymous ones', () => {
    const twoCredible = scoreCrossSourceConfirmation({
      sources: [
        { authorId: 'a', tier: 'TIER_1', weight: 1 },
        { authorId: 'b', tier: 'TIER_2', weight: 1 },
      ],
      config: SIGNAL_CONFIG_V1,
    });
    const hundredAnon = scoreCrossSourceConfirmation({
      sources: Array.from({ length: 100 }, (_, i) => ({ authorId: `x${i}`, tier: 'TIER_4' as const, weight: 1 })),
      config: SIGNAL_CONFIG_V1,
    });
    assert.ok(
      twoCredible.independentSourceCount >= 1.8,
      'a Tier-1 plus a Tier-2 should be worth ~1.8 independent sources',
    );
    assert.ok(hundredAnon.independentSourceCount <= 10, '100 anonymous accounts are worth at most ~10');
  });

  it('decays recency on the configured half-life', () => {
    const now = scoreRecency(NOW, NOW, 6);
    const sixHours = scoreRecency(NOW - 6 * 3_600_000, NOW, 6);
    assert.equal(now.score, 100);
    assert.equal(sixHours.score, 50);
  });
});

/* -------------------------------------------------------------- composite */

describe('composite score', () => {
  const neutralComponents = (over: Partial<SignalComponents> = {}): SignalComponents => ({
    sentiment: 0,
    materiality: 0,
    credibility: 0,
    novelty: 0,
    engagementVelocity: 0,
    crossSourceConfirmation: 0,
    priceConfirmation: 0,
    recency: 0,
    ...over,
  });

  it('takes its direction only from sentiment', () => {
    const bullish = computeComposite({
      components: neutralComponents({ sentiment: 80, materiality: 90, credibility: 90, recency: 100 }),
      config: SIGNAL_CONFIG_V1,
    });
    const bearish = computeComposite({
      components: neutralComponents({ sentiment: -80, materiality: 90, credibility: 90, recency: 100 }),
      config: SIGNAL_CONFIG_V1,
    });
    assert.ok(bullish.score > 0);
    assert.ok(bearish.score < 0);
    assert.equal(bullish.score, -bearish.score, 'the composite must be symmetric in direction');
  });

  it('scores near zero when the information is credible but not directional', () => {
    const result = computeComposite({
      components: neutralComponents({
        sentiment: 0,
        materiality: 100,
        credibility: 100,
        novelty: 100,
        crossSourceConfirmation: 100,
        recency: 100,
        engagementVelocity: 100,
      }),
      config: SIGNAL_CONFIG_V1,
    });
    assert.equal(result.score, 0, 'maximum conviction about nothing directional is not a trade');
  });

  it('scales magnitude by conviction', () => {
    const highConviction = computeComposite({
      components: neutralComponents({ sentiment: 100, materiality: 100, credibility: 100, novelty: 100, recency: 100, crossSourceConfirmation: 100, engagementVelocity: 100 }),
      config: SIGNAL_CONFIG_V1,
    });
    const lowConviction = computeComposite({
      components: neutralComponents({ sentiment: 100, materiality: 10, credibility: 10, novelty: 10, recency: 10 }),
      config: SIGNAL_CONFIG_V1,
    });
    assert.ok(highConviction.score > 90);
    assert.ok(lowConviction.score < 20);
  });

  it('never lets price data alone create a signal', () => {
    const result = computeComposite({
      components: neutralComponents({ sentiment: 5, materiality: 20, credibility: 30, priceConfirmation: 100 }),
      config: SIGNAL_CONFIG_V1,
    });
    assert.equal(result.priceAdjustment, 0, 'the price gate must hold below the base threshold');
    assert.ok(Math.abs(result.score) < SIGNAL_CONFIG_V1.bands.bullish);
  });

  it('caps the price contribution once the gate is passed', () => {
    const withPrice = computeComposite({
      components: neutralComponents({ sentiment: 70, materiality: 90, credibility: 90, novelty: 90, recency: 100, crossSourceConfirmation: 80, priceConfirmation: 100 }),
      config: SIGNAL_CONFIG_V1,
    });
    const withoutPrice = computeComposite({
      components: neutralComponents({ sentiment: 70, materiality: 90, credibility: 90, novelty: 90, recency: 100, crossSourceConfirmation: 80, priceConfirmation: 0 }),
      config: SIGNAL_CONFIG_V1,
    });
    const delta = withPrice.score - withoutPrice.score;
    assert.ok(delta > 0, 'agreeing price data should help');
    assert.ok(delta <= SIGNAL_CONFIG_V1.maxPriceContribution + 1, `price moved the score by ${delta}, above the cap`);
  });

  it('lets contradicting price data reduce the score', () => {
    const agreeing = computeComposite({
      components: neutralComponents({ sentiment: 70, materiality: 90, credibility: 90, novelty: 90, recency: 100, priceConfirmation: 80 }),
      config: SIGNAL_CONFIG_V1,
    });
    const contradicting = computeComposite({
      components: neutralComponents({ sentiment: 70, materiality: 90, credibility: 90, novelty: 90, recency: 100, priceConfirmation: -80 }),
      config: SIGNAL_CONFIG_V1,
    });
    assert.ok(contradicting.score < agreeing.score);
  });

  it('explains every component', () => {
    const result = computeComposite({
      components: neutralComponents({ sentiment: 60, materiality: 70, credibility: 80, recency: 90 }),
      config: SIGNAL_CONFIG_V1,
    });
    for (const c of result.contributions) {
      assert.ok(c.explanation.length > 10, `${String(c.component)} must carry an explanation`);
    }
    const keys = result.contributions.map((c) => String(c.component));
    for (const expected of ['sentiment', 'materiality', 'credibility', 'novelty', 'engagementVelocity', 'crossSourceConfirmation', 'priceConfirmation', 'recency']) {
      assert.ok(keys.includes(expected), `missing contribution for ${expected}`);
    }
  });

  it('maps scores onto the interpretable bands', () => {
    assert.equal(bandFor(-90, SIGNAL_CONFIG_V1), 'STRONG_BEARISH');
    assert.equal(bandFor(-40, SIGNAL_CONFIG_V1), 'BEARISH');
    assert.equal(bandFor(0, SIGNAL_CONFIG_V1), 'NEUTRAL');
    assert.equal(bandFor(40, SIGNAL_CONFIG_V1), 'BULLISH');
    assert.equal(bandFor(90, SIGNAL_CONFIG_V1), 'STRONG_BULLISH');
  });

  it('supports weight experiments through a derived config', () => {
    const variant = deriveSignalConfig(SIGNAL_CONFIG_V1, 'x-signal-config-test', 'Materiality-only variant', {
      convictionWeights: {
        materiality: 1, credibility: 0, novelty: 0, engagementVelocity: 0, crossSourceConfirmation: 0, recency: 0,
      },
    });
    const components = neutralComponents({ sentiment: 100, materiality: 100, credibility: 0, novelty: 0, recency: 0 });
    assert.ok(
      computeComposite({ components, config: variant }).score >
        computeComposite({ components, config: SIGNAL_CONFIG_V1 }).score,
      'a variant that only values materiality should score this higher',
    );
    assert.notEqual(variant.signalConfigId, SIGNAL_CONFIG_V1.signalConfigId);
    assert.equal(SIGNAL_CONFIG_V1.convictionWeights.materiality, 0.24, 'v1 must not be mutated by deriving');
  });
});

/* ------------------------------------------------------------ uncertainty */

describe('uncertainty', () => {
  it('is high on thin, ambiguous evidence', () => {
    const thin = computeUncertainty({
      independentSourceCount: 0.1,
      resolutionConfidence: 0.5,
      sentimentDisagreement: 0.8,
      priceDataAvailable: false,
      materiality: 10,
      config: SIGNAL_CONFIG_V1,
    });
    assert.ok(thin.value > 0.7);
  });

  it('is low on corroborated, unambiguous, material evidence', () => {
    const solid = computeUncertainty({
      independentSourceCount: 4,
      resolutionConfidence: 0.98,
      sentimentDisagreement: 0,
      priceDataAvailable: true,
      materiality: 95,
      config: SIGNAL_CONFIG_V1,
    });
    assert.ok(solid.value < 0.1);
  });

  it('is independent of score magnitude', () => {
    // A very strong score built on one anonymous source must still be flagged
    // uncertain — the risk engine relies on these being separate facts.
    const result = computeUncertainty({
      independentSourceCount: 0.1,
      resolutionConfidence: 0.8,
      sentimentDisagreement: 0,
      priceDataAvailable: true,
      materiality: 90,
      config: SIGNAL_CONFIG_V1,
    });
    assert.ok(result.value > 0.2);
    assert.ok(result.drivers.some((d) => d.driver === 'sourceThinness' && d.contribution > 0));
  });
});
