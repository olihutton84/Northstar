/**
 * Post filtering.
 *
 * Cheap, deterministic noise rejection that runs before any expensive scoring.
 *
 * The important idea here is the dedup key. A story repeated by 100 accounts is
 * one piece of information, not 100. Each event is assigned a cluster key built
 * from its *claim* — the entities plus the normalised substantive words — so
 * that near-identical retellings collapse into a single cluster. The signal
 * engine then counts independent SOURCES per cluster, not posts.
 */
import { clamp, shortHash } from '../core/index.js';
import type { FilterReason, FilterResult, FilterVerdict, SocialEvent } from '../domain/types.js';

export interface FilterConfig {
  /** Posts shorter than this carry no analysable claim. */
  minTextLength: number;
  /** More cashtags than this is stuffing, not a thesis. */
  maxCashtags: number;
  /** Jaccard similarity at/above which two posts are near-duplicates. */
  nearDuplicateThreshold: number;
  /** A repost of a post older than this is stale recycling. */
  staleRepostHours: number;
  /** Weight multiplier applied to a downweighted event's evidence. */
  downweightFactor: number;
  /** Accept non-English posts (v1: English only). */
  allowNonEnglish: boolean;
}

export const DEFAULT_FILTER_CONFIG: FilterConfig = {
  minTextLength: 25,
  maxCashtags: 4,
  nearDuplicateThreshold: 0.82,
  staleRepostHours: 24,
  downweightFactor: 0.35,
  allowNonEnglish: false,
};

/* --------------------------------------------------------------- patterns */

const SPAM_PATTERNS: { re: RegExp; reason: FilterReason }[] = [
  { re: /\b(giveaway|give\s?away|airdrop|free\s+(shares|stock|crypto)|enter\s+to\s+win)\b/i, reason: 'GIVEAWAY' },
  { re: /\b(dm\s+me|dm\s+for|link\s+in\s+bio|join\s+my|telegram|whats\s?app|discord\.gg)\b/i, reason: 'SPAM' },
  { re: /\b(guaranteed|100%\s+(win|profit)|risk\s?free|get\s+rich|to\s+the\s+moon\s+guaranteed)\b/i, reason: 'SPAM' },
  { re: /\b(pump|pumping)\s+(it|this)\b|\bnext\s+10\s?x\b|\b1000x\b/i, reason: 'SPAM' },
  { re: /\b(subscribe|sign\s+up|promo\s?code|use\s+code|affiliate|sponsored)\b/i, reason: 'PROMOTIONAL' },
  { re: /\b(my\s+(course|newsletter|signals?|alerts?)|premium\s+(group|channel))\b/i, reason: 'PROMOTIONAL' },
];

const ENGAGEMENT_BAIT = [
  /\b(like\s+(and|&)\s+(retweet|repost)|rt\s+(if|to)|comment\s+below|tag\s+(a|your)\s+friend)\b/i,
  /\b(who('|')?s\s+buying|drop\s+your\s+tickers?|what\s+are\s+you\s+buying)\b/i,
  /\b(follow\s+me\s+for|turn\s+on\s+notifications)\b/i,
];

const MEME_MARKERS = [
  /\b(stonks?|tendies|diamond\s+hands|apes?\s+together|hodl|yolo|bagholder)\b/i,
  /🚀{2,}|💎🙌|🦍/u,
];

/** Words that carry no claim; excluded from the dedup shingle. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on',
  'at', 'for', 'with', 'from', 'by', 'as', 'it', 'its', 'this', 'that', 'these', 'those', 'has', 'have', 'had',
  'will', 'would', 'can', 'could', 'should', 'may', 'might', 'we', 'they', 'he', 'she', 'you', 'i', 'our', 'their',
  'not', 'no', 'via', 'about', 'after', 'before', 'more', 'than', 'just', 'now', 'new', 'up', 'down', 'out',
  'breaking', 'report', 'says', 'said', 'per',
]);

/* --------------------------------------------------------------- helpers */

export function normaliseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#]\w+/g, ' ')
    .replace(/[^\p{L}\p{N}$%.\- ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Content words plus any numbers, which are usually the load-bearing facts. */
export function claimTokens(text: string): string[] {
  return normaliseText(text)
    .split(' ')
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Vocabulary of story-defining terms.
 *
 * The cluster key is built from what a post CLAIMS, not from how it is worded.
 * Connective verbs differ between retellings ("on demand" vs "citing demand")
 * while the entities, the numbers and the event vocabulary do not, so keying on
 * those three makes two accounts reporting one story land in one cluster.
 */
const TOPIC_VOCAB = new Set([
  'guidance', 'outlook', 'forecast', 'earnings', 'revenue', 'profit', 'loss', 'eps', 'margin', 'sales',
  'acquisition', 'acquire', 'acquires', 'merger', 'takeover', 'buyout', 'stake', 'divest', 'spinoff',
  'approval', 'approved', 'clearance', 'fda', 'trial', 'therapy', 'drug', 'patent',
  'investigation', 'probe', 'subpoena', 'lawsuit', 'litigation', 'settlement', 'fine', 'penalty', 'fraud',
  'contract', 'order', 'deal', 'partnership', 'alliance', 'joint',
  'layoffs', 'restructuring', 'hiring', 'strike', 'union',
  'buyback', 'repurchase', 'dividend', 'offering', 'dilution', 'raise',
  'bankruptcy', 'default', 'downgrade', 'upgrade', 'target',
  'recall', 'breach', 'outage', 'hack', 'shutdown', 'halt', 'delisting',
  'launch', 'launches', 'product', 'chip', 'platform', 'model', 'device',
  'ceo', 'cfo', 'coo', 'chairman', 'resign', 'resigns', 'appointed',
  'demand', 'supply', 'shortage', 'backlog', 'capacity', 'inventory',
  'tariff', 'tariffs', 'sanctions', 'export', 'antitrust',
  'quarter', 'quarterly', 'annual', 'index', 'inclusion',
  'datacentre', 'datacenter', 'centre', 'center', 'cloud', 'ai',
]);

/** Numeric facts, normalised so "$32.5B" and "32.5 billion" agree. */
export function numericFacts(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\$?\s?(\d[\d,]*(?:\.\d+)?)\s?(b(?:n|illion)?|m(?:n|illion)?|k|t(?:rillion)?|%)?/gi)) {
    const value = (m[1] ?? '').replace(/,/g, '');
    if (!value) continue;
    const unitRaw = (m[2] ?? '').toLowerCase();
    const unit = unitRaw.startsWith('b') ? 'b'
      : unitRaw.startsWith('m') ? 'm'
      : unitRaw.startsWith('t') ? 't'
      : unitRaw === 'k' ? 'k'
      : unitRaw === '%' ? '%' : '';
    out.add(`${Number(value)}${unit}`);
  }
  return [...out].sort();
}

/**
 * Cluster key for "substantially the same information".
 *
 * key = entities + numeric facts + event vocabulary present in the text.
 *
 * Two accounts reporting the same guidance raise agree on all three even with
 * different phrasing; a different story about the same company does not. When a
 * post carries neither numbers nor event vocabulary there is nothing to cluster
 * on, so the key falls back to the post's own distinctive words — which
 * correctly makes such posts their own cluster.
 */
export function dedupKeyFor(event: SocialEvent): string {
  const entities = [...event.mentionedCashtags, ...event.mentionedCompanies]
    .map((s) => s.toLowerCase())
    .sort();
  const tokens = claimTokens(event.text);
  const topics = [...new Set(tokens.filter((t) => TOPIC_VOCAB.has(t)))].sort();
  const numbers = numericFacts(event.text);

  if (topics.length === 0 && numbers.length === 0) {
    const distinctive = [...new Set(tokens)].sort().slice(0, 8);
    return shortHash(JSON.stringify({ entities, distinctive }));
  }
  return shortHash(JSON.stringify({ entities, topics, numbers }));
}

/* ---------------------------------------------------------------- filter */

export interface FilterContext {
  /** Events already accepted in this window, for duplicate detection. */
  priorEvents: { eventId: string; authorId: string; text: string; dedupKey: string; postedAt: string }[];
  nowMs: number;
  /** Cashtags/companies that exist in the universe, upper-cased tickers. */
  universeTickers: Set<string>;
}

export class PostFilter {
  constructor(private readonly config: FilterConfig = DEFAULT_FILTER_CONFIG) {}

  filter(event: SocialEvent, ctx: FilterContext): FilterResult {
    const reasons: FilterReason[] = [];
    const notes: string[] = [];
    // Held in an object: the helpers below mutate it from inside closures, and
    // a plain `let` would be narrowed by control-flow analysis at each read.
    const state: { verdict: FilterVerdict; weight: number } = { verdict: 'ACCEPT', weight: 1 };

    const dedupKey = dedupKeyFor(event);
    const text = event.text;
    const normalised = normaliseText(text);

    const reject = (reason: FilterReason, note: string): void => {
      reasons.push(reason);
      notes.push(note);
      state.verdict = 'REJECT';
      state.weight = 0;
    };
    const downweight = (reason: FilterReason, note: string, factor: number): void => {
      reasons.push(reason);
      notes.push(note);
      if (state.verdict !== 'REJECT') state.verdict = 'DOWNWEIGHT';
      state.weight = clamp(state.weight * factor, 0, 1);
    };

    // --- hard rejects ----------------------------------------------------
    if (normalised.length < this.config.minTextLength) {
      reject('TOO_SHORT', `Text under ${this.config.minTextLength} analysable characters`);
    }

    if (!this.config.allowNonEnglish && event.lang && event.lang !== 'en') {
      reject('NON_ENGLISH', `Language ${event.lang} not supported in v1`);
    }

    for (const { re, reason } of SPAM_PATTERNS) {
      if (re.test(text)) {
        reject(reason, `Matched ${reason.toLowerCase()} pattern`);
        break;
      }
    }

    if (event.mentionedCashtags.length > this.config.maxCashtags) {
      reject('CASHTAG_STUFFING', `${event.mentionedCashtags.length} cashtags in one post`);
    }

    // A pure repost adds no independent information. The original is already
    // in the corpus (or will be); counting both double-counts one source.
    if (event.kind === 'REPOST') {
      reject('PURE_REPOST', 'Repost with no added commentary');
    }

    const universeHit =
      event.mentionedCashtags.some((c) => ctx.universeTickers.has(c.toUpperCase())) ||
      event.mentionedCompanies.length > 0 ||
      [...ctx.universeTickers].some((t) => new RegExp(`\\$${t}\\b`, 'i').test(text));
    if (!universeHit && event.mentionedCashtags.length > 0) {
      // Cashtags present but none in the universe: this post is about
      // something Northstar does not trade.
      reject('NO_UNIVERSE_MATCH', 'No mentioned entity is in the Northstar universe');
    }

    // Exact duplicate of something already accepted, from any author.
    const exact = ctx.priorEvents.find((p) => normaliseText(p.text) === normalised && p.eventId !== event.eventId);
    if (exact) {
      if (exact.authorId === event.authorId) {
        reject('BOT_LIKE_DUPLICATE', 'Same author posted identical text already');
      } else {
        reject('EXACT_DUPLICATE', `Identical text already seen (${exact.eventId})`);
      }
    }

    // --- downweights -----------------------------------------------------
    if (state.verdict !== 'REJECT') {
      const tokens = new Set(claimTokens(text));
      for (const prior of ctx.priorEvents) {
        if (prior.eventId === event.eventId) continue;
        const similarity = jaccard(tokens, new Set(claimTokens(prior.text)));
        if (similarity >= this.config.nearDuplicateThreshold) {
          downweight('NEAR_DUPLICATE', `Near-duplicate of ${prior.eventId} (jaccard ${similarity.toFixed(2)})`, 0.25);
          break;
        }
      }

      if (MEME_MARKERS.some((re) => re.test(text))) {
        downweight('MEME', 'Meme vocabulary present', this.config.downweightFactor);
      }

      if (ENGAGEMENT_BAIT.some((re) => re.test(text))) {
        downweight('ENGAGEMENT_BAIT', 'Engagement-bait phrasing', this.config.downweightFactor);
      }

      if (event.kind === 'QUOTE' && normalised.length < 60) {
        downweight('NEAR_DUPLICATE', 'Quote post with minimal added commentary', 0.5);
      }

      if (event.sourceTier === 'TIER_4' && !/\d/.test(text)) {
        // Tier 4 with no concrete figure is opinion, not information. Kept, but
        // it should never be able to carry a signal by itself.
        downweight('LOW_TIER_NO_SUBSTANCE', 'Unverified source with no specific figures', 0.4);
      }

      const ageHours = (ctx.nowMs - new Date(event.postedAt).getTime()) / 3_600_000;
      if (event.referencedPostId && ageHours > this.config.staleRepostHours) {
        downweight('STALE_REPOST', `Recycled content ${ageHours.toFixed(1)}h old`, 0.3);
      }
    }

    return {
      eventId: event.eventId,
      verdict: state.verdict,
      reasons,
      weight: Number(state.weight.toFixed(4)),
      dedupKey,
      notes,
    };
  }

  /** Filter a batch, threading each accepted event into the dedup context. */
  filterBatch(events: SocialEvent[], universeTickers: Set<string>, nowMs: number): FilterResult[] {
    const priorEvents: FilterContext['priorEvents'] = [];
    const results: FilterResult[] = [];
    const ordered = [...events].sort((a, b) => a.postedAt.localeCompare(b.postedAt));

    for (const event of ordered) {
      const result = this.filter(event, { priorEvents, nowMs, universeTickers });
      results.push(result);
      if (result.verdict !== 'REJECT') {
        priorEvents.push({
          eventId: event.eventId,
          authorId: event.authorId,
          text: event.text,
          dedupKey: result.dedupKey,
          postedAt: event.postedAt,
        });
      }
    }
    return results;
  }
}
