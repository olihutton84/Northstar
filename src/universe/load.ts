/**
 * Loading the universe.
 *
 * Priority, and it is not negotiable:
 *
 *   1. PLATFORM     a valid snapshot supplied by the Northstar Platform
 *   2. BOT_FALLBACK this repository's own bounded list
 *
 * The fallback is a real, usable universe — the bot must stay independently
 * deployable, and a Platform outage cannot be allowed to stop a paper session.
 * But the two are never confused: whichever is active is stated in the startup
 * banner, on the dashboard and in the session record, so nothing ever implies
 * that fallback data is live Platform state.
 *
 * The reader is injected rather than imported, so adding an HTTP source later
 * means passing a different function — not taking a dependency on the Platform.
 */
import { readFileSync } from 'node:fs';
import type { Logger } from '../core/index.js';
import type { Security } from '../domain/types.js';
import {
  parseUniverseSnapshot,
  snapshotToSecurities,
  universeFingerprint,
  type UniverseProvenance,
} from './contract.js';
import { seedToSecurities, FALLBACK_UNIVERSE_ID, UNIVERSE_FALLBACK_SEED } from './seed.js';

/** Where a snapshot came from. A URL reader can be supplied the same way. */
export interface UniverseSource {
  /** Describes the origin for logs and the rejection record, e.g. a path. */
  describe(): string;
  /** Returns the raw payload, or null when nothing is configured. */
  read(): unknown;
}

/** Reads a snapshot from a local JSON file. */
export function fileUniverseSource(path: string): UniverseSource {
  return {
    describe: () => path,
    read: () => JSON.parse(readFileSync(path, 'utf8')),
  };
}

export interface LoadedUniverse {
  securities: Security[];
  provenance: UniverseProvenance;
}

/** The bot's own list, always available, always labelled as such. */
export function loadFallbackUniverse(): LoadedUniverse {
  const securities = seedToSecurities(UNIVERSE_FALLBACK_SEED);
  return {
    securities,
    provenance: {
      origin: 'BOT_FALLBACK',
      version: FALLBACK_UNIVERSE_ID,
      generatedAt: null,
      fingerprint: universeFingerprint(securities),
      securityCount: securities.length,
      rejection: null,
      label: `BOT FALLBACK (${FALLBACK_UNIVERSE_ID}, ${securities.length} securities)`,
    },
  };
}

/**
 * Resolve the universe for this session.
 *
 * A configured source that fails to load or fails validation does NOT crash the
 * bot and does NOT partially apply: it is rejected whole, the reason is
 * recorded on the provenance so it reaches the banner, the dashboard and the
 * session record, and the fallback runs in its place — clearly labelled.
 */
export function loadUniverse(source: UniverseSource | null, logger: Logger): LoadedUniverse {
  const log = logger.child('universe');

  if (!source) {
    const fallback = loadFallbackUniverse();
    log.info('no platform universe configured; using the bot fallback', {
      version: fallback.provenance.version,
      securities: fallback.provenance.securityCount,
    });
    return fallback;
  }

  const where = source.describe();
  let raw: unknown;
  try {
    raw = source.read();
  } catch (e) {
    return rejectTo(log, where, [`Could not read the universe: ${e instanceof Error ? e.message : String(e)}`]);
  }

  if (raw === null || raw === undefined) {
    return rejectTo(log, where, ['The universe source returned nothing.']);
  }

  const parsed = parseUniverseSnapshot(raw);
  if (!parsed.ok || !parsed.snapshot) {
    return rejectTo(log, where, parsed.problems);
  }

  const securities = snapshotToSecurities(parsed.snapshot);
  const fingerprint = universeFingerprint(securities);
  log.info('platform universe accepted', {
    source: where,
    version: parsed.snapshot.version,
    generatedAt: parsed.snapshot.generatedAt,
    securities: securities.length,
    fingerprint,
  });

  return {
    securities,
    provenance: {
      origin: 'PLATFORM',
      version: parsed.snapshot.version,
      generatedAt: parsed.snapshot.generatedAt,
      fingerprint,
      securityCount: securities.length,
      rejection: null,
      label: `PLATFORM (${parsed.snapshot.version}, ${securities.length} securities)`,
    },
  };
}

/** Refuse the snapshot whole, say why loudly, and fall back. */
function rejectTo(log: Logger, source: string, problems: string[]): LoadedUniverse {
  log.error('platform universe REJECTED; falling back to the bot universe', {
    source,
    problems: problems.slice(0, 10),
    problemCount: problems.length,
  });

  const fallback = loadFallbackUniverse();
  return {
    securities: fallback.securities,
    provenance: {
      ...fallback.provenance,
      rejection: { source, problems },
      label: `BOT FALLBACK (${fallback.provenance.version}, ${fallback.provenance.securityCount} securities) — platform universe rejected`,
    },
  };
}
