/**
 * Ticker / entity resolution.
 *
 * `$XYZ` is a claim, not a fact. This resolver validates every candidate
 * against the Northstar company master (the universe allowlist, which is itself
 * reconciled against Alpaca's tradable instruments) and attaches a confidence
 * score. Low-confidence mappings are recorded but the risk engine refuses to
 * trade them.
 *
 * Confidence model (documented, not magic):
 *
 *   OFFICIAL_ACCOUNT  0.98  the company's own account posted it
 *   CASHTAG           0.92  $AAPL, exact ticker match in the universe
 *   COMPANY_NAME      0.88  full legal/common name, e.g. "Advanced Micro Devices"
 *   ALIAS             0.72  a brand or product, e.g. "Azure", "iPhone maker"
 *
 * then penalties:
 *   -0.25  another allowlisted security matches the same span (ambiguity)
 *   -0.20  the match is an ambiguous common word used without market context
 *   -0.10  the match came from a downweighted post
 *   +0.05  a second, independent method matched the same security
 */
import { clamp } from '../core/index.js';
import type { FilterResult, ResolutionMethod, Security, SocialEvent, TickerResolution } from '../domain/types.js';
import type { UniverseRegistry } from '../universe/UniverseRegistry.js';

export interface ResolutionConfig {
  baseConfidence: Record<ResolutionMethod, number>;
  ambiguityPenalty: number;
  commonWordPenalty: number;
  downweightedPostPenalty: number;
  corroborationBonus: number;
  /** Below this, a resolution is recorded but marked unusable for trading. */
  minUsableConfidence: number;
}

export const DEFAULT_RESOLUTION_CONFIG: ResolutionConfig = {
  baseConfidence: {
    OFFICIAL_ACCOUNT: 0.98,
    CASHTAG: 0.92,
    COMPANY_NAME: 0.88,
    ALIAS: 0.72,
    AMBIGUOUS: 0.3,
    UNRESOLVED: 0,
  },
  ambiguityPenalty: 0.25,
  commonWordPenalty: 0.2,
  downweightedPostPenalty: 0.1,
  corroborationBonus: 0.05,
  minUsableConfidence: 0.75,
};

/**
 * Aliases that are ordinary English words. Matching one of these requires
 * nearby market context, otherwise "the apple harvest was strong" resolves to
 * AAPL.
 */
const AMBIGUOUS_ALIASES = new Set([
  'apple', 'meta', 'ford', 'delta', 'visa', 'target', 'gap', 'shell', 'block', 'match', 'lyft', 'square',
  'amazon', 'google', 'oracle', 'nike', 'unity', 'roku', 'zoom', 'peloton', 'lilly', 'disney',
]);

/** Words that indicate the post is talking about a company as an investment. */
const MARKET_CONTEXT = new RegExp(
  [
    'shares?', 'stock', 'ticker', 'earnings', 'revenue', 'guidance', 'eps', 'quarter', 'q[1-4]\\b',
    'analyst', 'upgrade', 'downgrade', 'price target', 'market cap', 'investors?', 'nasdaq', 'nyse',
    'sec\\b', 'filing', '8-k', '10-k', '10-q', 'acquisition', 'acquire', 'merger', 'buyback', 'dividend',
    'ceo', 'cfo', 'board', 'ipo', 'valuation', 'profit', 'loss', 'sales', 'outlook', 'forecast',
  ].join('|'),
  'i',
);

export class TickerResolver {
  constructor(
    private readonly universe: UniverseRegistry,
    private readonly config: ResolutionConfig = DEFAULT_RESOLUTION_CONFIG,
  ) {}

  get minUsableConfidence(): number {
    return this.config.minUsableConfidence;
  }

  /**
   * Resolve one event to zero or more securities.
   *
   * `officialForSecurityId` (when the poster is the company itself) is a strong
   * prior but not a licence: the company must still be in the universe.
   */
  resolve(event: SocialEvent, filter: FilterResult | null, officialForSecurityId?: string): TickerResolution[] {
    const hits = new Map<string, { methods: ResolutionMethod[]; matchedText: string; notes: string[] }>();
    const text = event.text;

    const record = (securityId: string, method: ResolutionMethod, matchedText: string, note?: string): void => {
      const existing = hits.get(securityId);
      if (existing) {
        if (!existing.methods.includes(method)) existing.methods.push(method);
        if (note) existing.notes.push(note);
      } else {
        hits.set(securityId, { methods: [method], matchedText, notes: note ? [note] : [] });
      }
    };

    // 1) The company's own account.
    if (officialForSecurityId && this.universe.has(officialForSecurityId)) {
      const sec = this.universe.byIdOrNull(officialForSecurityId)!;
      record(sec.securityId, 'OFFICIAL_ACCOUNT', `@${event.authorHandle}`, 'Posted by the official account');
    }

    // 2) Cashtags, validated against the universe. An unknown cashtag is not a
    //    ticker as far as Northstar is concerned.
    const cashtags = new Set([
      ...event.mentionedCashtags.map((c) => c.toUpperCase()),
      ...[...text.matchAll(/\$([A-Za-z]{1,5})\b/g)].map((m) => (m[1] ?? '').toUpperCase()),
    ]);
    for (const tag of cashtags) {
      if (!tag) continue;
      const sec = this.universe.byTickerOrNull(tag);
      if (sec) record(sec.securityId, 'CASHTAG', `$${tag}`);
    }

    // 3) Company names and aliases.
    //
    // The ambiguity rule applies to the company NAME as well as to aliases:
    // "Apple" is exactly as ambiguous when it arrives as a legal name as when
    // it arrives as a brand alias, and a fruit reference must never resolve to
    // AAPL just because Apple Inc. is the registered name.
    const hasMarketContext = MARKET_CONTEXT.test(text);
    for (const sec of this.universe.active()) {
      const candidates: { label: string; method: 'COMPANY_NAME' | 'ALIAS' }[] = [
        { label: sec.companyName, method: 'COMPANY_NAME' },
        ...sec.aliases.map((a) => ({ label: a, method: 'ALIAS' as const })),
      ];

      for (const candidate of candidates) {
        const hit = this.matchName(text, candidate.label);
        if (!hit) continue;
        const ambiguous = AMBIGUOUS_ALIASES.has(nameCore(candidate.label).toLowerCase());
        if (ambiguous && !hasMarketContext) {
          record(
            sec.securityId,
            'AMBIGUOUS',
            hit,
            `"${nameCore(candidate.label)}" is an ordinary English word and the post carries no market context`,
          );
        } else {
          record(
            sec.securityId,
            candidate.method,
            hit,
            ambiguous ? `Ambiguous name "${nameCore(candidate.label)}" resolved by nearby market context` : undefined,
          );
        }
      }
    }

    if (hits.size === 0) return [];

    // Competing securities: any other security matched by the same event.
    const allIds = [...hits.keys()];
    const resolutions: TickerResolution[] = [];

    for (const [securityId, hit] of hits) {
      const sec = this.universe.byIdOrNull(securityId);
      if (!sec) continue;

      const method = bestMethod(hit.methods);
      let confidence = this.config.baseConfidence[method];
      const notes = [...hit.notes];

      const competing = allIds.filter((id) => id !== securityId);
      // Only *strong* competitors create ambiguity. A cashtag plus a weak
      // alias hit on another name is not genuinely ambiguous.
      const strongCompetitors = competing.filter((id) => {
        const other = hits.get(id);
        return other ? bestMethod(other.methods) === method : false;
      });
      if (strongCompetitors.length > 0) {
        confidence -= this.config.ambiguityPenalty;
        notes.push(`Ambiguous with ${strongCompetitors.length} other security/securities matched the same way`);
      }

      if (method === 'AMBIGUOUS') {
        confidence -= this.config.commonWordPenalty;
      }

      if (filter && filter.verdict === 'DOWNWEIGHT') {
        confidence -= this.config.downweightedPostPenalty;
        notes.push('Source post was downweighted by the filter');
      }

      if (hit.methods.length > 1) {
        confidence += this.config.corroborationBonus;
        notes.push(`Corroborated by ${hit.methods.length} resolution methods`);
      }

      confidence = clamp(Number(confidence.toFixed(4)), 0, 1);
      if (confidence < this.config.minUsableConfidence) {
        notes.push(`Below the ${this.config.minUsableConfidence} usable threshold — recorded but not tradable`);
      }

      resolutions.push({
        eventId: event.eventId,
        securityId: sec.securityId,
        ticker: sec.ticker,
        method,
        confidence,
        matchedText: hit.matchedText,
        competingSecurityIds: competing,
        notes,
      });
    }

    resolutions.sort((a, b) => b.confidence - a.confidence);
    return resolutions;
  }

  isTradable(resolution: TickerResolution): boolean {
    return resolution.confidence >= this.config.minUsableConfidence && resolution.method !== 'UNRESOLVED';
  }

  /** Word-boundary match that tolerates the usual corporate suffixes. */
  private matchName(text: string, name: string): string | null {
    const core = nameCore(name);
    if (core.length < 3) return null;
    const escaped = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\w$])${escaped}(?![\\w])`, 'i');
    const m = re.exec(text);
    return m ? m[0] : null;
  }
}

/** Strips the corporate suffix so "Apple Inc." and "Apple" compare equal. */
function nameCore(name: string): string {
  return name
    .replace(/^The\s+/i, '')
    .replace(/,?\s+(Inc\.?|Corporation|Corp\.?|Company|Co\.?|Ltd\.?|plc|Holdings|Group|Technologies|Platforms|Motor Company)$/i, '')
    .trim();
}

const METHOD_RANK: ResolutionMethod[] = ['OFFICIAL_ACCOUNT', 'CASHTAG', 'COMPANY_NAME', 'ALIAS', 'AMBIGUOUS', 'UNRESOLVED'];

function bestMethod(methods: ResolutionMethod[]): ResolutionMethod {
  for (const m of METHOD_RANK) if (methods.includes(m)) return m;
  return 'UNRESOLVED';
}

/** Convenience: securities a batch of events resolved to, above threshold. */
export function tradableSecurities(
  resolutions: TickerResolution[],
  universe: UniverseRegistry,
  minConfidence: number,
): Security[] {
  const ids = new Set(resolutions.filter((r) => r.confidence >= minConfidence).map((r) => r.securityId));
  return [...ids].map((id) => universe.byIdOrNull(id)).filter((s): s is Security => s !== null);
}
