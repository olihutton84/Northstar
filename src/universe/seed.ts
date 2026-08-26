/**
 * The BOT FALLBACK universe.
 *
 * This is NOT the Northstar Platform's portfolio, research list or watchlist.
 * It is this repository's own bounded allowlist, maintained here so the bot
 * stays independently deployable and a Platform outage cannot stop a paper
 * session. It is a plausible stand-in, hand-written, and it goes stale.
 *
 * The bot does not read the X firehose. It reads a bounded allowlist, which is
 * what makes entity resolution tractable: "$F" only resolves to Ford because
 * Ford is on the list, and "Apple" only resolves to AAPL because no other
 * allowlisted company claims that alias.
 *
 * The `sources` tags below are CLAIMS ABOUT MEMBERSHIP, and this file is not
 * their owner. When the Platform supplies a universe snapshot (see
 * `contract.ts` and `load.ts`) it replaces this list entirely and its claims
 * are authoritative. Until then these tags are a local approximation used to
 * shape the fallback, and whichever universe is active is stated plainly in
 * the startup banner, the dashboard and the session record — so fallback data
 * is never presented as live Platform state.
 *
 * The tags are kept as they are on purpose: `x-signal-v1` declares the same
 * source names in its frozen spec, so changing them here would change which
 * securities the strategy may trade and would republish the strategy version.
 */
import type { Security, UniverseSource } from '../domain/types.js';

export interface UniverseSeedEntry {
  ticker: string;
  companyName: string;
  aliases: string[];
  exchange: string;
  sources: UniverseSource[];
  fractionable?: boolean;
}

/**
 * Aliases are deliberately conservative. Ambiguous single words that mean
 * something else in ordinary English ("Apple" the fruit, "Meta" the prefix,
 * "Visa" the travel document) are handled by the resolver's context rules
 * rather than by removing them here — see tickerResolution.ts.
 */
/** Identifies this fallback list in provenance records and session logs. */
export const FALLBACK_UNIVERSE_ID = 'bot-fallback-v1';

export const UNIVERSE_FALLBACK_SEED: UniverseSeedEntry[] = [
  // --- large-cap core (approximates a portfolio list) ---------------------
  { ticker: 'AAPL', companyName: 'Apple Inc.', aliases: ['Apple', 'iPhone maker'], exchange: 'NASDAQ',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_PORTFOLIO', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'MSFT', companyName: 'Microsoft Corporation', aliases: ['Microsoft', 'Azure', 'MSFT'], exchange: 'NASDAQ',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_PORTFOLIO', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'NVDA', companyName: 'NVIDIA Corporation', aliases: ['Nvidia', 'NVIDIA'], exchange: 'NASDAQ',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_PORTFOLIO', 'NORTHSTAR_RESEARCH', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'GOOGL', companyName: 'Alphabet Inc.', aliases: ['Alphabet', 'Google', 'DeepMind'], exchange: 'NASDAQ',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_PORTFOLIO'] },
  { ticker: 'AMZN', companyName: 'Amazon.com Inc.', aliases: ['Amazon', 'AWS'], exchange: 'NASDAQ',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_PORTFOLIO'] },

  // --- semiconductors and AI infrastructure (approximates a research list) -
  { ticker: 'AMD', companyName: 'Advanced Micro Devices, Inc.', aliases: ['AMD', 'Advanced Micro Devices'],
    exchange: 'NASDAQ', sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_RESEARCH', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'INTC', companyName: 'Intel Corporation', aliases: ['Intel'], exchange: 'NASDAQ',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_RESEARCH'] },
  { ticker: 'TSM', companyName: 'Taiwan Semiconductor Manufacturing Company', aliases: ['TSMC', 'Taiwan Semiconductor'],
    exchange: 'NYSE', sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_RESEARCH'] },
  { ticker: 'AVGO', companyName: 'Broadcom Inc.', aliases: ['Broadcom'], exchange: 'NASDAQ',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_RESEARCH'] },
  { ticker: 'MU', companyName: 'Micron Technology, Inc.', aliases: ['Micron'], exchange: 'NASDAQ',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_RESEARCH'] },
  { ticker: 'PLTR', companyName: 'Palantir Technologies Inc.', aliases: ['Palantir'], exchange: 'NASDAQ',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_RESEARCH', 'TRADING_LAB_UNIVERSE'] },

  // --- broader liquid US names (approximates a watchlist) ------------------
  { ticker: 'TSLA', companyName: 'Tesla, Inc.', aliases: ['Tesla'], exchange: 'NASDAQ',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST', 'TRADING_LAB_UNIVERSE'] },
  { ticker: 'META', companyName: 'Meta Platforms, Inc.', aliases: ['Meta Platforms', 'Facebook', 'Instagram'],
    exchange: 'NASDAQ', sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'NFLX', companyName: 'Netflix, Inc.', aliases: ['Netflix'], exchange: 'NASDAQ',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'CRM', companyName: 'Salesforce, Inc.', aliases: ['Salesforce'], exchange: 'NYSE',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'SHOP', companyName: 'Shopify Inc.', aliases: ['Shopify'], exchange: 'NYSE',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'UBER', companyName: 'Uber Technologies, Inc.', aliases: ['Uber'], exchange: 'NYSE',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'COIN', companyName: 'Coinbase Global, Inc.', aliases: ['Coinbase'], exchange: 'NASDAQ',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST', 'TRADING_LAB_UNIVERSE'] },
  { ticker: 'DIS', companyName: 'The Walt Disney Company', aliases: ['Disney'], exchange: 'NYSE',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'BA', companyName: 'The Boeing Company', aliases: ['Boeing'], exchange: 'NYSE',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'F', companyName: 'Ford Motor Company', aliases: ['Ford', 'Ford Motor'], exchange: 'NYSE',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'DAL', companyName: 'Delta Air Lines, Inc.', aliases: ['Delta Air Lines'], exchange: 'NYSE',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'SBUX', companyName: 'Starbucks Corporation', aliases: ['Starbucks'], exchange: 'NASDAQ',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'WMT', companyName: 'Walmart Inc.', aliases: ['Walmart'], exchange: 'NYSE',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'JPM', companyName: 'JPMorgan Chase & Co.', aliases: ['JPMorgan', 'JP Morgan'], exchange: 'NYSE',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'PFE', companyName: 'Pfizer Inc.', aliases: ['Pfizer'], exchange: 'NYSE',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'MRK', companyName: 'Merck & Co., Inc.', aliases: ['Merck'], exchange: 'NYSE',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST'] },
  { ticker: 'LLY', companyName: 'Eli Lilly and Company', aliases: ['Eli Lilly', 'Lilly'], exchange: 'NYSE',
    sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_WATCHLIST'] },

  // --- Benchmark ----------------------------------------------------------
  { ticker: 'SPY', companyName: 'SPDR S&P 500 ETF Trust', aliases: ['S&P 500 ETF'], exchange: 'NYSE',
    sources: ['ALPACA_US_EQUITY', 'TRADING_LAB_UNIVERSE'] },
];

export function securityIdForTicker(ticker: string): string {
  return `sec_${ticker.toUpperCase()}`;
}

export function seedToSecurities(seed: UniverseSeedEntry[] = UNIVERSE_FALLBACK_SEED): Security[] {
  return seed.map((e) => ({
    securityId: securityIdForTicker(e.ticker),
    ticker: e.ticker.toUpperCase(),
    companyName: e.companyName,
    aliases: e.aliases,
    exchange: e.exchange,
    assetClass: 'US_EQUITY' as const,
    alpacaTradable: true,
    alpacaFractionable: e.fractionable ?? true,
    universeSources: e.sources,
    active: true,
  }));
}

/**
 * @deprecated Use `UNIVERSE_FALLBACK_SEED`. Retained so existing callers keep
 * working; the rename exists to stop this list reading as live Platform state.
 */
export const UNIVERSE_SEED = UNIVERSE_FALLBACK_SEED;
