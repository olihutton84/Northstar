/**
 * The universe contract.
 *
 * This bot does not own portfolio, research or watchlist membership — the
 * Northstar Platform does. This file is the whole of the boundary between them:
 * a small, versioned, validated snapshot that the Platform can hand over as a
 * file today and over HTTP later, with no code in this repository depending on
 * anything in the Platform repository.
 *
 * The shape is deliberately small. It carries membership and the identifying
 * facts the resolver needs, and nothing else — no prices, no positions, no
 * recommendations. Anything richer would make the bot a consumer of Platform
 * internals rather than of one clearly-scoped list.
 *
 * Two rules govern everything here:
 *
 *   1. ALL OR NOTHING. A snapshot that is malformed anywhere is rejected
 *      entirely. Partially ingesting a universe would silently narrow or widen
 *      what the strategy may trade, which is the one thing a universe must
 *      never do quietly.
 *
 *   2. IDENTIFIED. Every accepted snapshot has a version and a content
 *      fingerprint, both recorded with the trading session, so a trade months
 *      from now can be reconstructed against the exact eligible universe that
 *      produced it.
 */
import { shortHash } from '../core/index.js';
import type { Security, UniverseSource } from '../domain/types.js';
import { securityIdForTicker } from './seed.js';

/** Every source the contract recognises. Membership in any of these is a claim the Platform makes. */
export const UNIVERSE_SOURCES: readonly UniverseSource[] = [
  'ALPACA_US_EQUITY',
  'NORTHSTAR_WATCHLIST',
  'NORTHSTAR_RESEARCH',
  'NORTHSTAR_PORTFOLIO',
  'TRADING_LAB_UNIVERSE',
];

export interface UniverseSnapshotEntry {
  ticker: string;
  /** Optional: derived from the ticker when absent, matching stored ids. */
  securityId?: string;
  companyName: string;
  aliases?: string[];
  exchange?: string;
  /** Which Platform list put this security here. At least one is required. */
  sources: UniverseSource[];
  /** Defaults true; a false here removes the security from trading eligibility. */
  alpacaTradable?: boolean;
  alpacaFractionable?: boolean;
  active?: boolean;
}

export interface UniverseSnapshot {
  /** Platform-assigned identifier for this revision of the universe. */
  version: string;
  generatedAt: string;
  securities: UniverseSnapshotEntry[];
}

export type UniverseOrigin = 'PLATFORM' | 'BOT_FALLBACK';

export interface UniverseParseResult {
  ok: boolean;
  snapshot: UniverseSnapshot | null;
  /** Every problem found, not merely the first — an operator fixes them together. */
  problems: string[];
}

/* --------------------------------------------------------------- parsing */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Validate an untrusted payload into a snapshot.
 *
 * Returns every problem rather than throwing on the first, and returns no
 * snapshot at all unless the whole payload is sound.
 */
export function parseUniverseSnapshot(raw: unknown): UniverseParseResult {
  const problems: string[] = [];
  const reject = (): UniverseParseResult => ({ ok: false, snapshot: null, problems });

  if (!isObject(raw)) {
    problems.push('Universe payload must be a JSON object.');
    return reject();
  }

  if (!isNonEmptyString(raw['version'])) problems.push('`version` is required and must be a non-empty string.');
  if (!isNonEmptyString(raw['generatedAt'])) {
    problems.push('`generatedAt` is required and must be a non-empty ISO timestamp.');
  } else if (Number.isNaN(Date.parse(raw['generatedAt'] as string))) {
    problems.push(`\`generatedAt\` is not a parsable timestamp: ${String(raw['generatedAt'])}`);
  }

  const securities = raw['securities'];
  if (!Array.isArray(securities)) {
    problems.push('`securities` is required and must be an array.');
    return reject();
  }
  if (securities.length === 0) {
    // An empty universe would silently stop all trading while looking healthy.
    problems.push('`securities` is empty; an empty universe is rejected rather than silently disabling trading.');
  }

  const entries: UniverseSnapshotEntry[] = [];
  const seenTickers = new Set<string>();

  securities.forEach((item, index) => {
    const at = `securities[${index}]`;
    if (!isObject(item)) {
      problems.push(`${at} must be an object.`);
      return;
    }

    const ticker = item['ticker'];
    if (!isNonEmptyString(ticker)) {
      problems.push(`${at}.ticker is required and must be a non-empty string.`);
      return;
    }
    const upper = ticker.trim().toUpperCase();
    if (!/^[A-Z][A-Z.-]{0,9}$/.test(upper)) {
      problems.push(`${at}.ticker "${ticker}" is not a plausible US equity symbol.`);
      return;
    }
    if (seenTickers.has(upper)) {
      problems.push(`${at}.ticker "${upper}" appears more than once.`);
      return;
    }
    seenTickers.add(upper);

    if (!isNonEmptyString(item['companyName'])) {
      problems.push(`${at}.companyName is required — the resolver needs it to match a company by name.`);
      return;
    }

    const sources = item['sources'];
    if (!Array.isArray(sources) || sources.length === 0) {
      problems.push(`${at}.sources is required and must list at least one universe source.`);
      return;
    }
    const unknown = sources.filter((s) => !UNIVERSE_SOURCES.includes(s as UniverseSource));
    if (unknown.length > 0) {
      problems.push(`${at}.sources contains unrecognised source(s): ${unknown.map(String).join(', ')}.`);
      return;
    }

    const aliases = item['aliases'];
    if (aliases !== undefined && (!Array.isArray(aliases) || aliases.some((a) => !isNonEmptyString(a)))) {
      problems.push(`${at}.aliases must be an array of non-empty strings when present.`);
      return;
    }

    for (const flag of ['alpacaTradable', 'alpacaFractionable', 'active'] as const) {
      if (item[flag] !== undefined && typeof item[flag] !== 'boolean') {
        problems.push(`${at}.${flag} must be a boolean when present.`);
        return;
      }
    }

    const entry: UniverseSnapshotEntry = {
      ticker: upper,
      companyName: (item['companyName'] as string).trim(),
      sources: sources as UniverseSource[],
    };
    if (isNonEmptyString(item['securityId'])) entry.securityId = (item['securityId'] as string).trim();
    if (Array.isArray(aliases)) entry.aliases = (aliases as string[]).map((a) => a.trim());
    if (isNonEmptyString(item['exchange'])) entry.exchange = (item['exchange'] as string).trim();
    if (typeof item['alpacaTradable'] === 'boolean') entry.alpacaTradable = item['alpacaTradable'];
    if (typeof item['alpacaFractionable'] === 'boolean') entry.alpacaFractionable = item['alpacaFractionable'];
    if (typeof item['active'] === 'boolean') entry.active = item['active'];

    entries.push(entry);
  });

  if (problems.length > 0) return reject();

  return {
    ok: true,
    problems: [],
    snapshot: {
      version: (raw['version'] as string).trim(),
      generatedAt: new Date(raw['generatedAt'] as string).toISOString(),
      securities: entries,
    },
  };
}

/* ------------------------------------------------------------ conversion */

/** Turn a validated snapshot into the securities the registry holds. */
export function snapshotToSecurities(snapshot: UniverseSnapshot): Security[] {
  return snapshot.securities.map((e) => ({
    securityId: e.securityId ?? securityIdForTicker(e.ticker),
    ticker: e.ticker,
    companyName: e.companyName,
    aliases: e.aliases ?? [],
    exchange: e.exchange ?? 'UNKNOWN',
    assetClass: 'US_EQUITY' as const,
    alpacaTradable: e.alpacaTradable ?? true,
    alpacaFractionable: e.alpacaFractionable ?? true,
    universeSources: e.sources,
    active: e.active ?? true,
  }));
}

/**
 * Content fingerprint of a universe.
 *
 * Derived from membership only — ticker, id and sources — because those are
 * what decide eligibility. A company renaming itself does not change which
 * securities the strategy could trade, and should not invalidate the
 * comparison between two sessions.
 */
export function universeFingerprint(securities: Security[]): string {
  const canonical = securities
    .map((s) => `${s.securityId}|${s.ticker}|${[...s.universeSources].sort().join(',')}|${s.active ? 1 : 0}|${s.alpacaTradable ? 1 : 0}`)
    .sort()
    .join('\n');
  return shortHash(canonical);
}

/** What the bot is running on, and where it came from. */
export interface UniverseProvenance {
  origin: UniverseOrigin;
  /** Platform version string, or the fallback's own identifier. */
  version: string;
  generatedAt: string | null;
  fingerprint: string;
  securityCount: number;
  /** Present when a platform snapshot was offered and refused. */
  rejection: { source: string; problems: string[] } | null;
  /** Human-readable one-liner for banners and logs. */
  label: string;
}
