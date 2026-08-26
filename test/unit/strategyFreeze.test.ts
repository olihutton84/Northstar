/**
 * The v1 freeze.
 *
 * `x-signal-v1` is frozen. Every stored signal, proposal, risk decision and
 * trade points at it, and the strategy-version comparison measures against it,
 * so changing it in place would silently falsify the record rather than improve
 * anything.
 *
 * If a test in this file fails, the change you made belongs in `x-signal-v2`.
 * Publishing a new version is cheap; a baseline that quietly moved is not.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dollarsToCents } from '../../src/core/index.js';
import { SIGNAL_CONFIG_V1 } from '../../src/config/signalConfig.js';
import {
  X_SIGNAL_V1,
  X_SIGNAL_V1_FINGERPRINT,
  fingerprintVersion,
  latestVersion,
  publishStrategyVersion,
  X_STRATEGY_ID,
} from '../../src/config/strategyRegistry.js';
import { DEFAULT_OPERATIONS, loadOperations } from '../../src/config/operations.js';

describe('x-signal-v1 freeze', () => {
  it('matches its published fingerprint', () => {
    assert.equal(
      fingerprintVersion(X_SIGNAL_V1),
      X_SIGNAL_V1_FINGERPRINT,
      'x-signal-v1 changed. Publish x-signal-v2 instead of editing v1 — see strategyRegistry.ts.',
    );
  });

  it('keeps the risk limits the spec fixed', () => {
    const l = X_SIGNAL_V1.riskLimits;
    assert.equal(l.startingCapitalCents, dollarsToCents(50));
    assert.equal(l.maxPositionPctOfEquity, 20);
    assert.equal(l.maxConcurrentPositions, 5);
    assert.equal(l.maxDailyLossPct, 4);
    assert.equal(l.maxDrawdownPct, 12);
    assert.equal(l.allowLeverage, false);
    assert.equal(l.allowMargin, false);
    assert.equal(l.allowOptions, false);
    assert.equal(l.allowShorting, false);
  });

  it('keeps the documented signal weights', () => {
    const w = SIGNAL_CONFIG_V1.convictionWeights;
    assert.equal(w.credibility, 0.26);
    assert.equal(w.materiality, 0.24);
    assert.equal(w.crossSourceConfirmation, 0.18);
    assert.equal(w.novelty, 0.14);
    assert.equal(w.recency, 0.1);
    assert.equal(w.engagementVelocity, 0.08);

    const total = Object.values(w).reduce((sum: number, v: number) => sum + v, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, 'the conviction weights must sum to 1');
  });

  it('keeps market data as confirmation only, never as the driver', () => {
    assert.equal(SIGNAL_CONFIG_V1.maxPriceContribution, 15);
    assert.equal(SIGNAL_CONFIG_V1.priceGateMinAbsBase, 20);
  });

  it('refuses to republish the same version id', () => {
    assert.throws(
      () => publishStrategyVersion(X_SIGNAL_V1),
      /already published/,
      'a published version must be immutable',
    );
  });

  it('is still the version the app loads', () => {
    assert.equal(latestVersion(X_STRATEGY_ID).version, X_SIGNAL_V1.version);
  });
});

describe('operational config is outside the freeze', () => {
  it('does not affect the strategy fingerprint', () => {
    const before = fingerprintVersion(X_SIGNAL_V1);
    // Changing cadence must not republish the strategy. How often the bot
    // looks is not what it believes.
    loadOperations({ xScanIntervalSeconds: 600, sameTickerCooldownMinutes: 120 });
    assert.equal(fingerprintVersion(X_SIGNAL_V1), before);
  });

  it('keeps rate controls out of the versioned spec', () => {
    const specKeys = Object.keys(X_SIGNAL_V1);
    for (const key of Object.keys(DEFAULT_OPERATIONS)) {
      assert.ok(!specKeys.includes(key), `${key} must not live on the strategy version`);
    }
  });
});
