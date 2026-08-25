/**
 * Environment configuration and provider selection.
 *
 * The failure this guards against is the quiet one: a half-configured
 * credential set producing a fixture provider that looks live. Falling back is
 * correct only when nothing is configured at all.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigurationError, NorthstarApp } from '../../src/app.js';
import {
  alpacaPaperCredentialReport,
  loadEnv,
  tiingoCredentialReport,
  xCredentialReport,
} from '../../src/config/env.js';
import { FixedClock, NullLogger } from '../../src/core/index.js';
import { TEST_NOW } from '../fixtures/harness.js';

const CREDENTIAL_VARS = [
  'X_BEARER_TOKEN',
  'TIINGO_API_KEY',
  'ALPACA_PAPER_KEY_ID',
  'ALPACA_PAPER_SECRET_KEY',
  'ALPACA_LIVE_KEY_ID',
  'ALPACA_LIVE_SECRET_KEY',
  'NORTHSTAR_LIVE_TRADING_ENABLED',
  'NORTHSTAR_USE_FIXTURES',
];

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  for (const name of CREDENTIAL_VARS) delete process.env[name];
});

afterEach(() => {
  process.env = saved;
});

/** An app on an in-memory database, reading whatever process.env currently is. */
function app(): NorthstarApp {
  return new NorthstarApp({
    env: loadEnv(),
    clock: new FixedClock(TEST_NOW),
    logger: new NullLogger(),
    databasePath: ':memory:',
  });
}

describe('credential reports', () => {
  it('reports ABSENT when nothing is configured', () => {
    assert.equal(xCredentialReport(loadEnv()).state, 'ABSENT');
    assert.equal(tiingoCredentialReport(loadEnv()).state, 'ABSENT');
    assert.equal(alpacaPaperCredentialReport().state, 'ABSENT');
  });

  it('reports CONFIGURED when everything is set', () => {
    process.env['X_BEARER_TOKEN'] = 'placeholder';
    process.env['TIINGO_API_KEY'] = 'placeholder';
    process.env['ALPACA_PAPER_KEY_ID'] = 'placeholder';
    process.env['ALPACA_PAPER_SECRET_KEY'] = 'placeholder';

    assert.equal(xCredentialReport(loadEnv()).state, 'CONFIGURED');
    assert.equal(tiingoCredentialReport(loadEnv()).state, 'CONFIGURED');
    assert.equal(alpacaPaperCredentialReport().state, 'CONFIGURED');
  });

  it('reports PARTIAL when only one of the Alpaca pair is set', () => {
    process.env['ALPACA_PAPER_KEY_ID'] = 'placeholder';
    const report = alpacaPaperCredentialReport();

    assert.equal(report.state, 'PARTIAL');
    assert.deepEqual(report.present, ['ALPACA_PAPER_KEY_ID']);
    assert.deepEqual(report.missing, ['ALPACA_PAPER_SECRET_KEY']);
    assert.match(report.detail, /ALPACA_PAPER_SECRET_KEY missing/);
  });

  it('never puts a credential value in the report', () => {
    process.env['ALPACA_PAPER_KEY_ID'] = 'super-secret-value-do-not-leak';
    const report = alpacaPaperCredentialReport();
    const serialised = JSON.stringify(report);
    assert.ok(!serialised.includes('super-secret-value-do-not-leak'), 'reports must name variables, never values');
  });

  it('treats a whitespace-only value as unset', () => {
    // A botched paste leaves the variable defined but empty. Constructing a
    // real provider with a blank token would fail later with a confusing 401.
    process.env['X_BEARER_TOKEN'] = '   \n';
    assert.equal(loadEnv().xBearerToken, null);
    assert.equal(xCredentialReport(loadEnv()).state, 'ABSENT');
  });

  it('trims surrounding whitespace off a real value', () => {
    process.env['X_BEARER_TOKEN'] = '  placeholder-token\n';
    assert.equal(loadEnv().xBearerToken, 'placeholder-token');
  });
});

describe('provider selection', () => {
  it('falls back to fixtures when nothing is configured', () => {
    const a = app();
    const p = a.describeProviders();

    assert.equal(p.x, 'FIXTURE');
    assert.equal(p.marketData, 'FIXTURE');
    assert.equal(p.broker, 'SIMULATED');
    assert.equal(p.allReal, false);
    assert.equal(p.forcedFixtures, false);
    a.close();
  });

  it('selects the real providers when everything is configured', () => {
    process.env['X_BEARER_TOKEN'] = 'placeholder';
    process.env['TIINGO_API_KEY'] = 'placeholder';
    process.env['ALPACA_PAPER_KEY_ID'] = 'placeholder';
    process.env['ALPACA_PAPER_SECRET_KEY'] = 'placeholder';

    const a = app();
    const p = a.describeProviders();

    assert.equal(p.x, 'LIVE');
    assert.equal(p.marketData, 'TIINGO');
    assert.equal(p.broker, 'ALPACA PAPER');
    assert.equal(p.mode, 'PAPER');
    assert.equal(p.allReal, true);
    a.close();
  });

  it('selects providers independently of one another', () => {
    process.env['TIINGO_API_KEY'] = 'placeholder';
    const a = app();
    const p = a.describeProviders();

    assert.equal(p.marketData, 'TIINGO', 'a configured provider must be used');
    assert.equal(p.x, 'FIXTURE', 'an unconfigured one must not be');
    assert.equal(p.allReal, false, 'allReal requires all three');
    a.close();
  });

  it('THROWS rather than silently simulating when Alpaca PAPER is half-configured', () => {
    process.env['ALPACA_PAPER_KEY_ID'] = 'placeholder';
    // ALPACA_PAPER_SECRET_KEY deliberately absent.

    assert.throws(
      () => app(),
      (e: unknown) =>
        e instanceof ConfigurationError &&
        /partially configured/.test(e.message) &&
        /ALPACA_PAPER_SECRET_KEY/.test(e.message),
      'a half-configured broker must fail loudly, never fall back to the simulator',
    );
  });

  it('throws on the mirror-image half-configuration too', () => {
    process.env['ALPACA_PAPER_SECRET_KEY'] = 'placeholder';
    assert.throws(() => app(), ConfigurationError);
  });

  it('honours NORTHSTAR_USE_FIXTURES and says so', () => {
    process.env['X_BEARER_TOKEN'] = 'placeholder';
    process.env['TIINGO_API_KEY'] = 'placeholder';
    process.env['ALPACA_PAPER_KEY_ID'] = 'placeholder';
    process.env['ALPACA_PAPER_SECRET_KEY'] = 'placeholder';
    process.env['NORTHSTAR_USE_FIXTURES'] = 'true';

    const a = app();
    const p = a.describeProviders();

    assert.equal(p.x, 'FIXTURE');
    assert.equal(p.marketData, 'FIXTURE');
    assert.equal(p.broker, 'SIMULATED');
    assert.equal(p.forcedFixtures, true, 'the override must be reported, not inferred from missing credentials');
    a.close();
  });

  it('still refuses to construct a LIVE broker without the explicit opt-in', () => {
    process.env['ALPACA_PAPER_KEY_ID'] = 'placeholder';
    process.env['ALPACA_PAPER_SECRET_KEY'] = 'placeholder';
    process.env['ALPACA_LIVE_KEY_ID'] = 'placeholder';
    process.env['ALPACA_LIVE_SECRET_KEY'] = 'placeholder';
    // NORTHSTAR_LIVE_TRADING_ENABLED deliberately absent.

    assert.throws(
      () =>
        new NorthstarApp({
          env: loadEnv(),
          clock: new FixedClock(TEST_NOW),
          logger: new NullLogger(),
          databasePath: ':memory:',
          mode: 'LIVE',
        }),
      /LIVE trading is disabled/,
    );
  });

  it('does not let PAPER credentials satisfy LIVE', () => {
    process.env['ALPACA_PAPER_KEY_ID'] = 'placeholder';
    process.env['ALPACA_PAPER_SECRET_KEY'] = 'placeholder';
    process.env['NORTHSTAR_LIVE_TRADING_ENABLED'] = 'true';
    // No ALPACA_LIVE_* variables.

    assert.throws(
      () =>
        new NorthstarApp({
          env: loadEnv(),
          clock: new FixedClock(TEST_NOW),
          logger: new NullLogger(),
          databasePath: ':memory:',
          mode: 'LIVE',
        }),
      /LIVE credentials missing/,
    );
  });
});
