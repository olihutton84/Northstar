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
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function optional(name: string): string | null {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? null : raw;
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
  };
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
    const keyId = process.env['ALPACA_PAPER_KEY_ID'] ?? '';
    const secretKey = process.env['ALPACA_PAPER_SECRET_KEY'] ?? '';
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
  const keyId = process.env['ALPACA_LIVE_KEY_ID'] ?? '';
  const secretKey = process.env['ALPACA_LIVE_SECRET_KEY'] ?? '';
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
