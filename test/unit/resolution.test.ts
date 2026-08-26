/**
 * Ticker/entity resolution and post filtering.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SocialEvent } from '../../src/domain/types.js';
import { PostFilter, dedupKeyFor, jaccard, claimTokens } from '../../src/pipeline/filtering.js';
import { TickerResolver } from '../../src/pipeline/tickerResolution.js';
import { SourceRegistry, tierForClass } from '../../src/providers/social/sourceRegistry.js';
import { UniverseRegistry } from '../../src/universe/UniverseRegistry.js';

const NOW = new Date('2026-03-10T15:00:00.000Z').getTime();
const universe = UniverseRegistry.fromSeed();
const UNIVERSE_TICKERS = new Set(universe.active().map((s) => s.ticker));

function event(over: Partial<SocialEvent> & { text: string }): SocialEvent {
  return {
    eventId: over.eventId ?? `evt-${Math.abs(hash(over.text))}`,
    platform: 'X',
    source: 'FIXTURE',
    provenance: 'FIXTURE',
    postId: over.postId ?? `post-${Math.abs(hash(over.text))}`,
    authorId: 'author-1',
    authorHandle: 'someone',
    authorDisplayName: 'Someone',
    sourceClass: 'GENERAL_ACCOUNT',
    sourceTier: 'TIER_4',
    postedAt: new Date(NOW - 5 * 60_000).toISOString(),
    capturedAt: new Date(NOW).toISOString(),
    url: 'https://x.com/someone/status/1',
    kind: 'ORIGINAL',
    mentionedCashtags: [],
    mentionedCompanies: [],
    resolvedSecurityIds: [],
    engagement: { likes: 10, reposts: 1, replies: 1, quotes: 0 },
    ingestBatchId: 'batch-1',
    lang: 'en',
    ...over,
  };
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/* ------------------------------------------------------------ resolution */

describe('ticker resolution', () => {
  const resolver = new TickerResolver(universe);

  it('resolves a valid cashtag with high confidence', () => {
    const [r] = resolver.resolve(event({ text: 'Big move coming for $NVDA on data centre demand', mentionedCashtags: ['NVDA'] }), null);
    assert.ok(r);
    assert.equal(r.ticker, 'NVDA');
    assert.equal(r.method, 'CASHTAG');
    assert.ok(r.confidence >= 0.9);
    assert.ok(resolver.isTradable(r));
  });

  it('does not treat an unknown cashtag as a ticker', () => {
    const results = resolver.resolve(event({ text: 'Loading up on $ZZZZ before the squeeze', mentionedCashtags: ['ZZZZ'] }), null);
    assert.equal(results.length, 0, '$ZZZZ is not in the Northstar universe and must not resolve');
  });

  it('resolves company names', () => {
    const results = resolver.resolve(event({ text: 'Advanced Micro Devices reported record server revenue this quarter' }), null);
    const amd = results.find((r) => r.ticker === 'AMD');
    assert.ok(amd, 'AMD should resolve from its full company name');
    assert.equal(amd.method, 'COMPANY_NAME');
    assert.ok(resolver.isTradable(amd));
  });

  it('demands market context before resolving an ambiguous common word', () => {
    const noContext = resolver.resolve(event({ text: 'I ate an apple for lunch and it was delicious today' }), null);
    const aapl = noContext.find((r) => r.ticker === 'AAPL');
    assert.ok(aapl, 'the match is still recorded for auditability');
    assert.equal(aapl.method, 'AMBIGUOUS');
    assert.equal(resolver.isTradable(aapl), false, 'a fruit reference must never be tradable');

    const withContext = resolver.resolve(
      event({ text: 'Apple shares jumped after the company raised its quarterly guidance' }),
      null,
    );
    const withContextAapl = withContext.find((r) => r.ticker === 'AAPL');
    assert.ok(withContextAapl);
    assert.ok(
      withContextAapl.method === 'COMPANY_NAME' || withContextAapl.method === 'ALIAS',
      `market context should promote the match to a usable method, got ${withContextAapl.method}`,
    );
    assert.ok(withContextAapl.confidence > aapl.confidence);
    assert.ok(resolver.isTradable(withContextAapl));
  });

  it('gives the official company account the strongest confidence', () => {
    const [r] = resolver.resolve(
      event({ text: 'Our third-quarter results are out now.', authorHandle: 'nvidia' }),
      null,
      'sec_NVDA',
    );
    assert.ok(r);
    assert.equal(r.method, 'OFFICIAL_ACCOUNT');
    assert.ok(r.confidence >= 0.95);
  });

  it('penalises a downweighted source post', () => {
    const e = event({ text: 'Big move coming for $NVDA', mentionedCashtags: ['NVDA'] });
    const clean = resolver.resolve(e, null)[0]!;
    const downweighted = resolver.resolve(e, {
      eventId: e.eventId, verdict: 'DOWNWEIGHT', reasons: ['MEME'], weight: 0.35, dedupKey: 'k', notes: [],
    })[0]!;
    assert.ok(downweighted.confidence < clean.confidence);
  });

  it('records competing securities when several are mentioned', () => {
    const results = resolver.resolve(
      event({ text: 'Comparing $NVDA and $AMD chip roadmaps this quarter', mentionedCashtags: ['NVDA', 'AMD'] }),
      null,
    );
    assert.equal(results.length, 2);
    for (const r of results) {
      assert.ok(r.competingSecurityIds.length >= 1, 'each resolution should record the alternatives');
      assert.ok(r.confidence < 0.9, 'ambiguity must lower confidence');
    }
  });

  it('keeps every resolution explainable', () => {
    const [r] = resolver.resolve(event({ text: 'Tesla shares fell after the earnings miss', mentionedCashtags: [] }), null);
    assert.ok(r);
    assert.ok(r.matchedText.length > 0, 'the matched span must be recorded');
  });
});

/* ------------------------------------------------------------- filtering */

describe('post filtering', () => {
  const filter = new PostFilter();
  const ctx = { priorEvents: [], nowMs: NOW, universeTickers: UNIVERSE_TICKERS };

  const reject = (text: string, over: Partial<SocialEvent> = {}) =>
    filter.filter(event({ text, ...over }), { ...ctx, priorEvents: [] });

  it('rejects giveaways, spam and promotion', () => {
    assert.equal(reject('GIVEAWAY! Free shares of $NVDA to ten lucky followers, enter to win now').verdict, 'REJECT');
    assert.equal(reject('DM me for my premium signals group, guaranteed 100% win rate on every call').verdict, 'REJECT');
    assert.equal(reject('Use code MOON for 50% off my newsletter, link in bio for the full watchlist').verdict, 'REJECT');
  });

  it('rejects cashtag stuffing', () => {
    const result = reject('Watchlist: $NVDA $AAPL $TSLA $AMD $MSFT $PFE all setting up', {
      mentionedCashtags: ['NVDA', 'AAPL', 'TSLA', 'AMD', 'MSFT', 'PFE'],
    });
    assert.equal(result.verdict, 'REJECT');
    assert.ok(result.reasons.includes('CASHTAG_STUFFING'));
  });

  it('rejects pure reposts, which add no independent information', () => {
    const result = reject('NVIDIA raises its full-year guidance to $32.5 billion today', { kind: 'REPOST' });
    assert.equal(result.verdict, 'REJECT');
    assert.ok(result.reasons.includes('PURE_REPOST'));
  });

  it('rejects posts about tickers outside the universe', () => {
    const result = reject('Loading up on $ZZZZ ahead of the announcement next week', { mentionedCashtags: ['ZZZZ'] });
    assert.equal(result.verdict, 'REJECT');
    assert.ok(result.reasons.includes('NO_UNIVERSE_MATCH'));
  });

  it('rejects text too short to carry a claim', () => {
    assert.equal(reject('$NVDA 🚀', { mentionedCashtags: ['NVDA'] }).verdict, 'REJECT');
  });

  it('downweights memes and engagement bait rather than deleting them', () => {
    const meme = reject('$NVDA stonks only go up, diamond hands, apes together strong forever', { mentionedCashtags: ['NVDA'] });
    assert.equal(meme.verdict, 'DOWNWEIGHT');
    assert.ok(meme.weight < 1 && meme.weight > 0);

    const bait = reject('Who is buying $NVDA today? Comment below and tag a friend to find out', { mentionedCashtags: ['NVDA'] });
    assert.equal(bait.verdict, 'DOWNWEIGHT');
  });

  it('downweights an unverified source with no concrete figures', () => {
    const result = reject('I think NVIDIA is going to do really well with data centres this year', {
      sourceTier: 'TIER_4',
    });
    assert.ok(result.reasons.includes('LOW_TIER_NO_SUBSTANCE'));
    assert.ok(result.weight < 1);
  });

  it('detects exact duplicates across authors and bot-like repeats from one author', () => {
    const text = 'NVIDIA raises full-year guidance to $32.5 billion on data centre demand growth';
    const first = event({ text, eventId: 'a', authorId: 'author-1' });
    const otherAuthor = event({ text, eventId: 'b', authorId: 'author-2' });
    const sameAuthor = event({ text, eventId: 'c', authorId: 'author-1' });

    const prior = [{ eventId: 'a', authorId: 'author-1', text, dedupKey: dedupKeyFor(first), postedAt: first.postedAt }];

    const dupe = filter.filter(otherAuthor, { ...ctx, priorEvents: prior });
    assert.equal(dupe.verdict, 'REJECT');
    assert.ok(dupe.reasons.includes('EXACT_DUPLICATE'));

    const bot = filter.filter(sameAuthor, { ...ctx, priorEvents: prior });
    assert.equal(bot.verdict, 'REJECT');
    assert.ok(bot.reasons.includes('BOT_LIKE_DUPLICATE'));
  });

  it('clusters substantially identical information under one dedup key', () => {
    const a = event({
      text: 'NVIDIA raises full-year guidance to $32.5 billion on data centre demand',
      mentionedCashtags: ['NVDA'],
    });
    const b = event({
      text: 'NVIDIA raises full-year guidance to $32.5 billion, citing data centre demand',
      mentionedCashtags: ['NVDA'],
    });
    const unrelated = event({
      text: 'NVIDIA announces a new gaming laptop partnership with a European retailer',
      mentionedCashtags: ['NVDA'],
    });
    assert.equal(dedupKeyFor(a), dedupKeyFor(b), 'two retellings of one story share a cluster');
    assert.notEqual(dedupKeyFor(a), dedupKeyFor(unrelated), 'a different story is a different cluster');
  });

  it('measures near-duplication with token overlap', () => {
    const a = new Set(claimTokens('NVIDIA raises full-year guidance to $32.5 billion on data centre demand'));
    const b = new Set(claimTokens('NVIDIA lifts full-year guidance to $32.5 billion on data centre demand'));
    const c = new Set(claimTokens('Pfizer wins FDA approval for its new oncology therapy'));
    assert.ok(jaccard(a, b) > 0.7);
    assert.ok(jaccard(a, c) < 0.15);
  });

  it('accepts a substantive post from a credible source', () => {
    const result = reject(
      'NVIDIA raises guidance for the third quarter to $32.5B, up 24% sequentially on data centre demand. $NVDA',
      { mentionedCashtags: ['NVDA'], sourceTier: 'TIER_1', sourceClass: 'COMPANY_OFFICIAL' },
    );
    assert.equal(result.verdict, 'ACCEPT');
    assert.equal(result.weight, 1);
    assert.equal(result.reasons.length, 0);
  });
});

/* ------------------------------------------------------- source registry */

describe('source classification', () => {
  const registry = new SourceRegistry();

  it('maps classes to the intended tiers', () => {
    assert.equal(tierForClass('REGULATOR'), 'TIER_1');
    assert.equal(tierForClass('COMPANY_OFFICIAL'), 'TIER_1');
    assert.equal(tierForClass('FINANCIAL_JOURNALIST'), 'TIER_2');
    assert.equal(tierForClass('SELL_SIDE_ANALYST'), 'TIER_3');
    assert.equal(tierForClass('UNVERIFIED_COMMENTARY'), 'TIER_4');
  });

  it('classifies known accounts from the allowlist', () => {
    const sec = registry.classify({ authorId: '1', handle: '@SEC_News', displayName: 'SEC', verified: true, followerCount: 100 });
    assert.equal(sec.sourceTier, 'TIER_1');
    assert.equal(sec.sourceClass, 'REGULATOR');

    const nvidia = registry.classify({ authorId: '2', handle: 'nvidia', displayName: 'NVIDIA', verified: true, followerCount: 1 });
    assert.equal(nvidia.officialForSecurityId, 'sec_NVDA');
  });

  it('defaults unknown accounts to Tier 4 regardless of reach', () => {
    const whale = registry.classify({
      authorId: '3', handle: 'anonwhale', displayName: 'Anon Whale', verified: true, followerCount: 40_000_000,
    });
    assert.equal(whale.sourceTier, 'TIER_4');
    assert.equal(whale.sourceClass, 'GENERAL_ACCOUNT');
  });

  it('follows Tier 1 and Tier 2 accounts for timeline pulls', () => {
    const followed = registry.followedHandles();
    assert.ok(followed.includes('sec_news'));
    assert.ok(followed.includes('reuters'));
    assert.ok(!followed.includes('jimcramer'), 'Tier 3 accounts are searched, not followed');
  });
});

/* ---------------------------------------------------------- the universe */

describe('universe allowlist', () => {
  it('only admits securities from a declared Northstar list', () => {
    const eligible = universe.eligible(['NORTHSTAR_PORTFOLIO']);
    assert.ok(eligible.length > 0);
    for (const s of eligible) assert.ok(s.universeSources.includes('NORTHSTAR_PORTFOLIO'));
    assert.ok(!eligible.some((s) => s.ticker === 'PFE'), 'PFE is watchlist-only, not portfolio');
  });

  it('excludes securities the broker cannot trade', () => {
    const registry = UniverseRegistry.fromSeed();
    const nvda = registry.byTickerOrNull('NVDA')!;
    registry.add({ ...nvda, alpacaTradable: false });
    assert.equal(registry.isEligible(nvda.securityId, ['NORTHSTAR_PORTFOLIO']), false);
  });

  it('builds bounded search terms rather than a firehose query', () => {
    const { tickers, keywords } = universe.searchTerms(['NORTHSTAR_WATCHLIST']);
    assert.ok(tickers.length > 5 && tickers.length < 100);
    assert.ok(keywords.length > 5);
    assert.ok(keywords.some((k) => k === 'Tesla'));
  });
});
