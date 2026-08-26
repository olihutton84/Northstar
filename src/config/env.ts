/**
 * Environment configuration.
 *
 * Credentials are read here and nowhere else. They are never persisted, never
 * logged, never returned by the API, and PAPER and LIVE credentials live in
 * separate variables that are never read into the same config object.
 */
import type { TradingMode } from '../domain/types.js';

export interface AlpacaCredentials {
  keyId: string;
  secretKey: string;
  baseUrl: string;
  dataUrl: string;
  mode: TradingMode;
}

export interface NorthstarEnv {
  nodeEnv: string;
  dataDir: string;
  databasePath: string;
  httpPort: number;
  logLevel: string;

  /** X (Twitter) API v2 bearer token. */
  xBearerToken: string | null;
  xApiBaseUrl: string;
  /** Consecutive X provider failures tolerated before the strategy pauses. */
  xFailureTolerance: number;

  /** Tiingo — Northstar's existing market-data vendor. */
  tiingoApiKey: string | null;
  tiingoBaseUrl: string;

  /** Explicit opt-in required before LIVE mode can even be constructed. */
  liveTradingEnabled: boolean;
  /** Identity recorded against manual approvals. */
  approverId: string;

  /** Use recorded fixtures instead of live vendor calls. */
  useFixtures: boolean;

  /**
   * Path to a Northstar Platform universe snapshot.
   *
   * Absent means the bot runs its own fallback universe, clearly labelled as
   * such. It is never a credential and never reaches a provider.
   */
  universeFile: string | null;
}

/**
 * Read and trim a variable.
 *
 * Trimming matters for credentials: a token pasted with a trailing newline or a
 * stray space is the single most common way a valid key produces a 401. A value
 * that is only whitespace is treated as unset, which is also what an untouched
 * `X_BEARER_TOKEN=` line in the copied template means.
 */
function raw(name: string): string | null {
  const value = process.env[name];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function num(name: string, fallback: number): number {
  const value = raw(name);
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback = false): boolean {
  const value = raw(name);
  if (value === null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function str(name: string, fallback: string): string {
  return raw(name) ?? fallback;
}

function optional(name: string): string | null {
  return raw(name);
}

export function loadEnv(): NorthstarEnv {
  const dataDir = str('NORTHSTAR_DATA_DIR', './data');
  return {
    nodeEnv: str('NODE_ENV', 'development'),
    dataDir,
    databasePath: str('NORTHSTAR_DB_PATH', `${dataDir}/northstar.sqlite`),
    httpPort: num('NORTHSTAR_PORT', 3737),
    logLevel: str('LOG_LEVEL', 'info'),

    xBearerToken: optional('X_BEARER_TOKEN'),
    xApiBaseUrl: str('X_API_BASE_URL', 'https://api.twitter.com/2'),
    xFailureTolerance: num('X_FAILURE_TOLERANCE', 3),

    tiingoApiKey: optional('TIINGO_API_KEY'),
    tiingoBaseUrl: str('TIINGO_BASE_URL', 'https://api.tiingo.com'),

    liveTradingEnabled: bool('NORTHSTAR_LIVE_TRADING_ENABLED', false),
    approverId: str('NORTHSTAR_APPROVER_ID', 'local-operator'),

    useFixtures: bool('NORTHSTAR_USE_FIXTURES', false),

    universeFile: optional('NORTHSTAR_UNIVERSE_FILE'),
  };
}

/**
 * How completely a provider's credentials are configured.
 *
 *   ABSENT      nothing is set — falling back to fixtures is the correct,
 *               unambiguous outcome
 *   CONFIGURED  everything needed is set — use the real provider, and if it
 *               fails to construct, fail loudly rather than falling back
 *   PARTIAL     some but not all of a credential set is present — the operator
 *               clearly intended a real provider and got it wrong. Silently
 *               running on fixtures here is the worst outcome available: it
 *               looks live and is not.
 */
export type CredentialState = 'ABSENT' | 'CONFIGURED' | 'PARTIAL';

export interface CredentialReport {
  state: CredentialState;
  /** Variable names that are set. Never their values. */
  present: string[];
  /** Variable names still needed to reach CONFIGURED. */
  missing: string[];
  detail: string;
}

function reportFor(label: string, required: string[]): CredentialReport {
  const present = required.filter((name) => raw(name) !== null);
  const missing = required.filter((name) => raw(name) === null);

  if (present.length === 0) {
    return { state: 'ABSENT', present, missing, detail: `${label} is not configured` };
  }
  if (missing.length === 0) {
    return { state: 'CONFIGURED', present, missing, detail: `${label} is fully configured` };
  }
  return {
    state: 'PARTIAL',
    present,
    missing,
    detail:
      `${label} is partially configured: ${present.join(', ')} set, but ${missing.join(', ')} missing. ` +
      `Set the missing variable(s), or unset the others to run on fixtures deliberately.`,
  };
}

/**
 * Credential completeness for the X provider.
 *
 * Read from the resolved env object rather than process.env so it agrees with
 * the rest of the configuration, including an env injected for tests. A
 * single-variable provider cannot be PARTIAL — it is set or it is not.
 */
export function xCredentialReport(env: NorthstarEnv): CredentialReport {
  return env.xBearerToken === null
    ? { state: 'ABSENT', present: [], missing: ['X_BEARER_TOKEN'], detail: 'X API is not configured' }
    : { state: 'CONFIGURED', present: ['X_BEARER_TOKEN'], missing: [], detail: 'X API is fully configured' };
}

/** Credential completeness for the Tiingo market-data provider. */
export function tiingoCredentialReport(env: NorthstarEnv): CredentialReport {
  return env.tiingoApiKey === null
    ? { state: 'ABSENT', present: [], missing: ['TIINGO_API_KEY'], detail: 'Tiingo is not configured' }
    : { state: 'CONFIGURED', present: ['TIINGO_API_KEY'], missing: [], detail: 'Tiingo is fully configured' };
}

/**
 * Credential completeness for Alpaca PAPER.
 *
 * This is the pair that actually goes wrong in practice: one of the two set is
 * a typo or a half-finished paste, not an intention to run simulated. Read
 * straight from process.env, because credentials are deliberately never held on
 * NorthstarEnv.
 */
export function alpacaPaperCredentialReport(): CredentialReport {
  return reportFor('Alpaca PAPER', ['ALPACA_PAPER_KEY_ID', 'ALPACA_PAPER_SECRET_KEY']);
}

/**
 * Resolve Alpaca credentials for exactly one mode.
 *
 * PAPER and LIVE variables are deliberately disjoint. There is no fallback from
 * LIVE to PAPER (or the reverse): a missing credential is an error, never a
 * silent switch to the other environment.
 */
export function loadAlpacaCredentials(mode: TradingMode): AlpacaCredentials {
  if (mode === 'PAPER') {
    // Trimmed, exactly as `alpacaPaperCredentialReport` trims: the two paths
    // must agree on what "configured" means, or readiness can report a
    // credential present that the broker then reads as blank.
    const keyId = raw('ALPACA_PAPER_KEY_ID') ?? '';
    const secretKey = raw('ALPACA_PAPER_SECRET_KEY') ?? '';
    if (!keyId || !secretKey) {
      throw new Error(
        'Alpaca PAPER credentials missing: set ALPACA_PAPER_KEY_ID and ALPACA_PAPER_SECRET_KEY.',
      );
    }
    return {
      keyId,
      secretKey,
      baseUrl: str('ALPACA_PAPER_BASE_URL', 'https://paper-api.alpaca.markets'),
      dataUrl: str('ALPACA_DATA_URL', 'https://data.alpaca.markets'),
      mode: 'PAPER',
    };
  }

  if (!bool('NORTHSTAR_LIVE_TRADING_ENABLED', false)) {
    throw new Error(
      'LIVE trading is disabled. Set NORTHSTAR_LIVE_TRADING_ENABLED=true to construct a LIVE broker.',
    );
  }
  const keyId = raw('ALPACA_LIVE_KEY_ID') ?? '';
  const secretKey = raw('ALPACA_LIVE_SECRET_KEY') ?? '';
  if (!keyId || !secretKey) {
    throw new Error(
      'Alpaca LIVE credentials missing: set ALPACA_LIVE_KEY_ID and ALPACA_LIVE_SECRET_KEY.',
    );
  }
  const baseUrl = str('ALPACA_LIVE_BASE_URL', 'https://api.alpaca.markets');
  if (baseUrl.includes('paper-api')) {
    throw new Error('Refusing to run LIVE mode against a paper endpoint: check ALPACA_LIVE_BASE_URL.');
  }
  return {
    keyId,
    secretKey,
    baseUrl,
    dataUrl: str('ALPACA_DATA_URL', 'https://data.alpaca.markets'),
    mode: 'LIVE',
  };
}

/** True when credentials for a mode are present, without exposing them. */
export function hasAlpacaCredentials(mode: TradingMode): boolean {
  try {
    loadAlpacaCredentials(mode);
    return true;
  } catch {
    return false;
  }
}
