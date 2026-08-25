/**
 * Adversarial X inputs.
 *
 * Each case is a way X actually breaks a naive signal bot. They are kept
 * together so that the defence against each is testable in isolation and so a
 * future weight change can be checked against all of them at once.
 *
 * These are hostile inputs, not a representative sample of X. Passing them all
 * means the specific failure modes are handled; it does not mean the strategy
 * is safe.
 */
import type { FixturePost } from '../../src/providers/social/FixtureSocialProvider.js';

export interface AdversarialCase {
  id: string;
  title: string;
  /** What the naive failure would be. */
  hazard: string;
  /** What the system must do instead. */
  expectation: string;
  posts: FixturePost[];
}

/* --------------------------------------------------------------- cases --- */

export const SARCASM: AdversarialCase = {
  id: 'sarcasm',
  title: 'Sarcasm and irony',
  hazard: 'A lexicon reads "great quarter, guys" and the mocking use of positive words as bullish.',
  expectation: 'Must not produce a tradable bullish signal from mockery by unverified accounts.',
  posts: [
    {
      postId: 'sarc-1',
      handle: 'snarkytrader',
      text: 'Oh brilliant, another "record quarter" for $TSLA while margins collapse. Great job everyone, truly outstanding work.',
      minutesAgo: 5,
      likes: 12_000,
      reposts: 3000,
      baselineEngagement: 400,
    },
    {
      postId: 'sarc-2',
      handle: 'marketwit',
      text: 'Fantastic news: $TSLA delivers a strong beat on absolutely nothing. Wonderful. Just wonderful.',
      minutesAgo: 4,
      likes: 6000,
      baselineEngagement: 300,
    },
  ],
};

export const VAGUE_COMPANY: AdversarialCase = {
  id: 'vague-company',
  title: 'Vague company reference',
  hazard: 'An ordinary English word ("apple", "delta", "ford") is read as a ticker.',
  expectation: 'Must not resolve to a security without market context, and must never trade on it.',
  posts: [
    {
      postId: 'vague-1',
      handle: 'reuters',
      text: 'A delta of nearly two points separated the two candidates in the latest polling out of the midwest today.',
      minutesAgo: 5,
      likes: 800,
      baselineEngagement: 700,
    },
    {
      postId: 'vague-2',
      handle: 'foodblogger',
      text: 'Made an apple tart tonight and it turned out beautifully. Recipe below for anyone who wants it.',
      minutesAgo: 6,
      likes: 300,
      baselineEngagement: 200,
    },
  ],
};

export const TICKER_COLLISION: AdversarialCase = {
  id: 'ticker-collision',
  title: 'Ticker collision',
  hazard: 'Two allowlisted names match the same post, and the bot picks one arbitrarily.',
  expectation: 'Resolution confidence must drop for BOTH, recording the competing candidates.',
  posts: [
    {
      postId: 'collide-1',
      handle: 'reuters',
      text: 'Comparing $NVDA and $AMD data centre roadmaps: both firms report accelerating revenue this quarter.',
      minutesAgo: 5,
      likes: 4000,
      baselineEngagement: 800,
    },
  ],
};

export const REPOST_STORM: AdversarialCase = {
  id: 'repost-storm',
  title: 'Repost storm',
  hazard: 'One claim reposted by 40 accounts reads as 40 independent confirmations.',
  expectation: 'Duplicates are rejected and independent source count stays near one.',
  posts: [
    {
      postId: 'storm-origin',
      handle: 'anonalpha',
      text: 'BREAKING: $PFE is about to announce a major FDA approval for its lead oncology therapy today.',
      minutesAgo: 10,
      likes: 900,
      baselineEngagement: 100,
    },
    ...Array.from({ length: 40 }, (_, i) => ({
      postId: `storm-${i}`,
      handle: `amplifier${i}`,
      text: 'BREAKING: $PFE is about to announce a major FDA approval for its lead oncology therapy today.',
      minutesAgo: 9 - (i % 8),
      likes: 200 + i * 10,
      reposts: 80,
      baselineEngagement: 60,
    })),
  ],
};

export const RUMOR_AMPLIFICATION: AdversarialCase = {
  id: 'rumor-amplification',
  title: 'Rumour amplification',
  hazard: 'Hedged speculation gathers enough volume to look like fact.',
  expectation: 'Hedging must discount sentiment and materiality; the rumour must not clear the bar.',
  posts: [
    {
      postId: 'rumor-1',
      handle: 'anonalpha',
      text: 'Hearing $AAPL may reportedly be exploring a major acquisition. Unconfirmed, but could be huge if true.',
      minutesAgo: 8,
      likes: 30_000,
      reposts: 9000,
      baselineEngagement: 500,
    },
    {
      postId: 'rumor-2',
      handle: 'gerberkawasaki',
      text: 'Speculation is that $AAPL might possibly be considering a large deal. Nothing confirmed at this stage.',
      minutesAgo: 6,
      likes: 5000,
      baselineEngagement: 600,
    },
  ],
};

export const CONTRADICTORY_SOURCES: AdversarialCase = {
  id: 'contradictory-sources',
  title: 'Contradictory credible sources',
  hazard: 'Two Tier-1/2 sources say opposite things and the bot averages them into a confident number.',
  expectation: 'Disagreement must raise uncertainty and suppress the composite, not average away.',
  posts: [
    {
      postId: 'contra-1',
      handle: 'reuters',
      text: 'NVIDIA raises full-year guidance to $34.0B, well ahead of consensus, on record data centre demand. $NVDA',
      minutesAgo: 6,
      likes: 5000,
      baselineEngagement: 800,
    },
    {
      postId: 'contra-2',
      handle: 'business',
      text: 'NVIDIA cuts full-year guidance to $26.0B, badly below consensus, citing weak demand and export controls. $NVDA',
      minutesAgo: 5,
      likes: 4800,
      baselineEngagement: 800,
    },
  ],
};

export const STALE_BREAKING_NEWS: AdversarialCase = {
  id: 'stale-breaking-news',
  title: 'Stale "breaking" news',
  hazard: 'A two-day-old story resurfaces labelled BREAKING and is treated as new information.',
  expectation: 'Recency and novelty decay must strip it of conviction.',
  posts: [
    {
      postId: 'stale-1',
      handle: 'reuters',
      text: 'BREAKING: NVIDIA raises full-year guidance to $32.5B on accelerating data centre demand. $NVDA',
      minutesAgo: 40 * 60, // ~40 hours old, inside the 48h ceiling but heavily decayed
      likes: 20_000,
      baselineEngagement: 800,
    },
  ],
};

export const EDITED_LOOKING: AdversarialCase = {
  id: 'edited-or-deleted',
  title: 'Deleted or edited-looking events',
  hazard: 'The same post id reappears with different text, or a claim mutates between observations.',
  expectation: 'The post id is the identity: a second version must not create a second piece of evidence.',
  posts: [
    {
      postId: 'edit-1',
      handle: 'reuters',
      text: 'NVIDIA raises full-year guidance to $32.5B on accelerating data centre demand. $NVDA',
      minutesAgo: 8,
      likes: 4000,
      baselineEngagement: 800,
    },
    {
      // Same post id, different text — as if the post were edited after capture.
      postId: 'edit-1',
      handle: 'reuters',
      text: 'CORRECTION: NVIDIA did NOT raise guidance. The earlier figure was in error. $NVDA',
      minutesAgo: 4,
      likes: 4200,
      baselineEngagement: 800,
    },
  ],
};

export const SPAM_CAMPAIGN: AdversarialCase = {
  id: 'spam-campaign',
  title: 'Coordinated spam campaign',
  hazard: 'A promoted pump fills the feed and drowns out genuine signal.',
  expectation: 'Every spam pattern is rejected before scoring; none contributes evidence.',
  posts: [
    ...Array.from({ length: 12 }, (_, i) => ({
      postId: `spam-${i}`,
      handle: `pumpbot${i}`,
      text: 'GIVEAWAY! Free shares of $AMD to 10 lucky winners. Like and retweet to enter to win, DM me for details!',
      minutesAgo: 3 + (i % 6),
      likes: 40_000,
      reposts: 30_000,
      baselineEngagement: 100,
    })),
    {
      postId: 'spam-promo',
      handle: 'signalsguru',
      text: 'My premium signals group called $AMD before the move. Use code MOON for 50% off my newsletter today only.',
      minutesAgo: 4,
      likes: 900,
      baselineEngagement: 200,
    },
  ],
};

export const LOUD_BUT_WORTHLESS: AdversarialCase = {
  id: 'loud-low-credibility',
  title: 'High engagement, low credibility',
  hazard: 'Virality is mistaken for information.',
  expectation: 'Tier-4 engagement is halved and cannot carry a signal on its own.',
  posts: [
    {
      postId: 'loud-1',
      handle: 'anonwhale',
      text: '$TSLA is going to absolutely explode higher this week. Biggest move of the year incoming, mark my words.',
      minutesAgo: 5,
      likes: 250_000,
      reposts: 80_000,
      baselineEngagement: 1000,
    },
  ],
};

export const QUIET_PRIMARY_SOURCE: AdversarialCase = {
  id: 'quiet-primary-source',
  title: 'Credible low-engagement primary source',
  hazard: 'An engagement-driven bot ignores the regulator nobody has retweeted yet.',
  expectation: 'A Tier-1 primary source with almost no engagement must still score highly.',
  posts: [
    {
      postId: 'quiet-1',
      handle: 'sec_news',
      text:
        'The SEC has opened a formal investigation into Tesla over accounting irregularities covering ' +
        '$1.4B of recognised revenue in its 2025 filings. $TSLA',
      minutesAgo: 3,
      likes: 12,
      reposts: 4,
      baselineEngagement: 400,
    },
    {
      postId: 'quiet-2',
      handle: 'reuters',
      text: 'Tesla faces an SEC probe into accounting irregularities covering $1.4B of revenue, per a filing. $TSLA',
      minutesAgo: 2,
      likes: 40,
      baselineEngagement: 800,
    },
  ],
};

export const ADVERSARIAL_CASES: AdversarialCase[] = [
  SARCASM,
  VAGUE_COMPANY,
  TICKER_COLLISION,
  REPOST_STORM,
  RUMOR_AMPLIFICATION,
  CONTRADICTORY_SOURCES,
  STALE_BREAKING_NEWS,
  EDITED_LOOKING,
  SPAM_CAMPAIGN,
  LOUD_BUT_WORTHLESS,
  QUIET_PRIMARY_SOURCE,
];
