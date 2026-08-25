/**
 * Source classification.
 *
 * Tier is a property of *what an account is*, not how many people follow it.
 * A pseudonymous account with two million followers is Tier 4; the SEC's press
 * account with far fewer is Tier 1. Follower count enters the model only as a
 * small, capped popularity term inside credibility scoring (see credibility.ts)
 * and can never promote a tier.
 *
 * The registry is an explicit allowlist. Unknown accounts default to Tier 4,
 * which the risk layer will not trade on its own.
 */
import type { SocialAuthor, SourceClass, SourceTier } from '../../domain/types.js';

export interface SourceRegistryEntry {
  handle: string;
  displayName: string;
  sourceClass: SourceClass;
  /** Northstar securityId this account officially speaks for, if any. */
  officialForSecurityId?: string;
  note?: string;
}

export const TIER_BY_CLASS: Record<SourceClass, SourceTier> = {
  // Tier 1 — the entity itself, or the body that regulates/lists it.
  COMPANY_OFFICIAL: 'TIER_1',
  COMPANY_EXECUTIVE: 'TIER_1',
  REGULATOR: 'TIER_1',
  GOVERNMENT_AGENCY: 'TIER_1',
  EXCHANGE: 'TIER_1',
  // Tier 2 — professionals with editorial accountability or domain standing.
  FINANCIAL_JOURNALIST: 'TIER_2',
  INDUSTRY_EXPERT: 'TIER_2',
  SPECIALIST_PUBLICATION: 'TIER_2',
  // Tier 3 — informed but interested parties.
  SELL_SIDE_ANALYST: 'TIER_3',
  SPECIALIST_COMMENTATOR: 'TIER_3',
  INDUSTRY_PARTICIPANT: 'TIER_3',
  // Tier 4 — everyone else.
  GENERAL_ACCOUNT: 'TIER_4',
  UNVERIFIED_COMMENTARY: 'TIER_4',
};

export function tierForClass(sourceClass: SourceClass): SourceTier {
  return TIER_BY_CLASS[sourceClass];
}

/**
 * Seed registry. Handles are stored lower-case without the leading '@'.
 * `officialForSecurityId` values match the universe seed (sec_<TICKER>).
 */
export const SOURCE_REGISTRY_SEED: SourceRegistryEntry[] = [
  // --- Tier 1: regulators, agencies, exchanges ---------------------------
  { handle: 'sec_news', displayName: 'U.S. Securities and Exchange Commission', sourceClass: 'REGULATOR' },
  { handle: 'sec_enforcement', displayName: 'SEC Enforcement', sourceClass: 'REGULATOR' },
  { handle: 'us_fda', displayName: 'U.S. Food and Drug Administration', sourceClass: 'REGULATOR' },
  { handle: 'ftc', displayName: 'Federal Trade Commission', sourceClass: 'REGULATOR' },
  { handle: 'thejusticedept', displayName: 'U.S. Department of Justice', sourceClass: 'GOVERNMENT_AGENCY' },
  { handle: 'federalreserve', displayName: 'Federal Reserve', sourceClass: 'GOVERNMENT_AGENCY' },
  { handle: 'commercegov', displayName: 'U.S. Department of Commerce', sourceClass: 'GOVERNMENT_AGENCY' },
  { handle: 'nasdaq', displayName: 'Nasdaq', sourceClass: 'EXCHANGE' },
  { handle: 'nyse', displayName: 'New York Stock Exchange', sourceClass: 'EXCHANGE' },

  // --- Tier 1: company official accounts ---------------------------------
  { handle: 'apple', displayName: 'Apple', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_AAPL' },
  { handle: 'microsoft', displayName: 'Microsoft', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_MSFT' },
  { handle: 'nvidia', displayName: 'NVIDIA', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_NVDA' },
  { handle: 'nvidianewsroom', displayName: 'NVIDIA Newsroom', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_NVDA' },
  { handle: 'tesla', displayName: 'Tesla', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_TSLA' },
  { handle: 'amazon', displayName: 'Amazon', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_AMZN' },
  { handle: 'google', displayName: 'Google', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_GOOGL' },
  { handle: 'meta', displayName: 'Meta', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_META' },
  { handle: 'amd', displayName: 'AMD', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_AMD' },
  { handle: 'intel', displayName: 'Intel', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_INTC' },
  { handle: 'pfizer', displayName: 'Pfizer', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_PFE' },
  { handle: 'merck', displayName: 'Merck', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_MRK' },
  { handle: 'boeing', displayName: 'Boeing', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_BA' },
  { handle: 'ford', displayName: 'Ford Motor Company', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_F' },
  { handle: 'delta', displayName: 'Delta Air Lines', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_DAL' },
  { handle: 'starbucks', displayName: 'Starbucks', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_SBUX' },
  { handle: 'netflix', displayName: 'Netflix', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_NFLX' },
  { handle: 'uber', displayName: 'Uber', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_UBER' },
  { handle: 'salesforce', displayName: 'Salesforce', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_CRM' },
  { handle: 'shopify', displayName: 'Shopify', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_SHOP' },
  { handle: 'palantirtech', displayName: 'Palantir', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_PLTR' },
  { handle: 'coinbase', displayName: 'Coinbase', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_COIN' },
  { handle: 'jpmorgan', displayName: 'JPMorgan Chase', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_JPM' },
  { handle: 'walmart', displayName: 'Walmart', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_WMT' },
  { handle: 'disney', displayName: 'The Walt Disney Company', sourceClass: 'COMPANY_OFFICIAL', officialForSecurityId: 'sec_DIS' },

  // --- Tier 1: executives -------------------------------------------------
  { handle: 'tim_cook', displayName: 'Tim Cook', sourceClass: 'COMPANY_EXECUTIVE', officialForSecurityId: 'sec_AAPL' },
  { handle: 'satyanadella', displayName: 'Satya Nadella', sourceClass: 'COMPANY_EXECUTIVE', officialForSecurityId: 'sec_MSFT' },
  { handle: 'elonmusk', displayName: 'Elon Musk', sourceClass: 'COMPANY_EXECUTIVE', officialForSecurityId: 'sec_TSLA' },
  { handle: 'sundarpichai', displayName: 'Sundar Pichai', sourceClass: 'COMPANY_EXECUTIVE', officialForSecurityId: 'sec_GOOGL' },
  { handle: 'lisasu', displayName: 'Lisa Su', sourceClass: 'COMPANY_EXECUTIVE', officialForSecurityId: 'sec_AMD' },
  { handle: 'andyjassy', displayName: 'Andy Jassy', sourceClass: 'COMPANY_EXECUTIVE', officialForSecurityId: 'sec_AMZN' },
  { handle: 'brian_armstrong', displayName: 'Brian Armstrong', sourceClass: 'COMPANY_EXECUTIVE', officialForSecurityId: 'sec_COIN' },
  { handle: 'tobi', displayName: 'Tobi Lutke', sourceClass: 'COMPANY_EXECUTIVE', officialForSecurityId: 'sec_SHOP' },

  // --- Tier 2: journalists and specialist publications --------------------
  { handle: 'reuters', displayName: 'Reuters', sourceClass: 'SPECIALIST_PUBLICATION' },
  { handle: 'reutersbiz', displayName: 'Reuters Business', sourceClass: 'SPECIALIST_PUBLICATION' },
  { handle: 'business', displayName: 'Bloomberg', sourceClass: 'SPECIALIST_PUBLICATION' },
  { handle: 'wsjmarkets', displayName: 'WSJ Markets', sourceClass: 'SPECIALIST_PUBLICATION' },
  { handle: 'ft', displayName: 'Financial Times', sourceClass: 'SPECIALIST_PUBLICATION' },
  { handle: 'cnbc', displayName: 'CNBC', sourceClass: 'SPECIALIST_PUBLICATION' },
  { handle: 'apnews', displayName: 'Associated Press', sourceClass: 'SPECIALIST_PUBLICATION' },
  { handle: 'theinformation', displayName: 'The Information', sourceClass: 'SPECIALIST_PUBLICATION' },
  { handle: 'faberreport', displayName: 'David Faber', sourceClass: 'FINANCIAL_JOURNALIST' },
  { handle: 'carlquintanilla', displayName: 'Carl Quintanilla', sourceClass: 'FINANCIAL_JOURNALIST' },
  { handle: 'lizannsonders', displayName: 'Liz Ann Sonders', sourceClass: 'INDUSTRY_EXPERT' },
  { handle: 'dylan522p', displayName: 'SemiAnalysis', sourceClass: 'INDUSTRY_EXPERT' },
  { handle: 'ericjhrgarcia', displayName: 'Semiconductor Analyst', sourceClass: 'INDUSTRY_EXPERT' },

  // --- Tier 3: analysts and specialist commentators -----------------------
  { handle: 'danielives', displayName: 'Dan Ives', sourceClass: 'SELL_SIDE_ANALYST' },
  { handle: 'gerberkawasaki', displayName: 'Ross Gerber', sourceClass: 'SPECIALIST_COMMENTATOR' },
  { handle: 'chamath', displayName: 'Chamath Palihapitiya', sourceClass: 'INDUSTRY_PARTICIPANT' },
  { handle: 'jimcramer', displayName: 'Jim Cramer', sourceClass: 'SPECIALIST_COMMENTATOR' },
];

export class SourceRegistry {
  private readonly byHandle = new Map<string, SourceRegistryEntry>();

  constructor(entries: SourceRegistryEntry[] = SOURCE_REGISTRY_SEED) {
    for (const e of entries) this.byHandle.set(normaliseHandle(e.handle), e);
  }

  add(entry: SourceRegistryEntry): void {
    this.byHandle.set(normaliseHandle(entry.handle), entry);
  }

  lookup(handle: string): SourceRegistryEntry | null {
    return this.byHandle.get(normaliseHandle(handle)) ?? null;
  }

  entries(): SourceRegistryEntry[] {
    return [...this.byHandle.values()];
  }

  /** Handles Northstar always pulls timelines for (Tier 1 and Tier 2). */
  followedHandles(): string[] {
    return this.entries()
      .filter((e) => tierForClass(e.sourceClass) === 'TIER_1' || tierForClass(e.sourceClass) === 'TIER_2')
      .map((e) => e.handle);
  }

  /**
   * Classify an account. Registry hit wins; otherwise Tier 4.
   *
   * Note what is deliberately absent: no branch here reads followerCount.
   */
  classify(input: {
    authorId: string;
    handle: string;
    displayName: string;
    verified: boolean;
    followerCount: number;
    accountCreatedAt?: string;
  }): SocialAuthor {
    const entry = this.lookup(input.handle);
    const sourceClass: SourceClass = entry
      ? entry.sourceClass
      : input.verified
        ? 'GENERAL_ACCOUNT'
        : 'UNVERIFIED_COMMENTARY';
    const author: SocialAuthor = {
      authorId: input.authorId,
      handle: normaliseHandle(input.handle),
      displayName: input.displayName || entry?.displayName || input.handle,
      verified: input.verified,
      followerCount: input.followerCount,
      sourceClass,
      sourceTier: tierForClass(sourceClass),
    };
    if (input.accountCreatedAt) author.accountCreatedAt = input.accountCreatedAt;
    if (entry?.officialForSecurityId) author.officialForSecurityId = entry.officialForSecurityId;
    return author;
  }
}

export function normaliseHandle(handle: string): string {
  return handle.trim().toLowerCase().replace(/^@/, '');
}
