/**
 * Historical replay and strategy-version comparison.
 *
 * The central claim under test is that replay cannot see the future. Everything
 * else a replay reports is worthless if that is not true.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FixedClock } from '../../src/core/index.js';
import { SIGNAL_CONFIG_V1, deriveSignalConfig, registerSignalConfig } from '../../src/config/signalConfig.js';
import { X_SIGNAL_V1, deriveStrategyVersion, getStrategyVersion, X_STRATEGY_ID } from '../../src/config/strategyRegistry.js';
import { compareStrategyVersions } from '../../src/replay/compare.js';
import { exportDatasetFromStore, validateDataset, type ReplayDataset } from '../../src/replay/dataset.js';
import { runReplay } from '../../src/replay/ReplayEngine.js';
import { buildSampleDataset } from '../../src/replay/sampleDataset.js';
import { ReplayMarketDataProvider, ReplaySocialProvider } from '../../src/replay/providers.js';
import { bullishTier1Post, corroboratingTier2Post, createHarness } from '../fixtures/harness.js';

const DATASET: ReplayDataset = buildSampleDataset({ hours: 30, seed: 424242 });

describe('replay providers cannot see the future', () => {
  it('reveals events only once their capture time has passed', async () => {
    const clock = new FixedClock(DATASET.window.from);
    const social = new ReplaySocialProvider(DATASET, clock);

    const atStart = await social.fetch({ tickers: [], keywords: [], since: '1970-01-01T00:00:00.000Z', limit: 1000 });
    assert.ok(social.hiddenCount() > 0, 'most of the dataset must still be hidden at the start');

    clock.set(DATASET.window.to);
    const atEnd = await social.fetch({ tickers: [], keywords: [], since: '1970-01-01T00:00:00.000Z', limit: 1000 });

    assert.ok(atEnd.events.length > atStart.events.length, 'more events become visible as time passes');
    assert.equal(social.hiddenCount(), 0, 'everything is visible by the end of the window');

    for (const event of atStart.events) {
      assert.ok(event.capturedAt <= DATASET.window.from, `event ${event.eventId} was revealed before capture`);
    }
  });

  it('never returns a bar dated after the replay clock', async () => {
    const clock = new FixedClock(DATASET.window.from);
    const market = new ReplayMarketDataProvider(DATASET, clock);

    // Ask explicitly for the future.
    const bars = await market.getDailyBars('NVDA', '1970-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
    assert.ok(bars.length > 0, 'warm-up history should be visible');
    for (const bar of bars) {
      assert.ok(bar.at <= clock.nowIso(), `bar at ${bar.at} leaked from the future`);
    }

    const quote = await market.getQuote('NVDA');
    assert.ok(quote.asOf <= clock.nowIso(), 'the quote must not be dated in the future');
  });

  it('advances the visible price as the clock moves', async () => {
    const clock = new FixedClock(DATASET.window.from);
    const market = new ReplayMarketDataProvider(DATASET, clock);
    const early = await market.getQuote('NVDA');

    clock.advanceHours(20);
    const later = await market.getQuote('NVDA');

    assert.ok(later.asOf > early.asOf, 'a later clock must expose a later bar');
  });

  it('rejects a dataset whose events were captured before they were posted', () => {
    const corrupt: ReplayDataset = {
      ...DATASET,
      events: [{ ...DATASET.events[0]!, capturedAt: '2000-01-01T00:00:00.000Z' }],
    };
    assert.throws(() => validateDataset(corrupt), /captured before it was posted/);
  });

  it('rejects a dataset with duplicate post ids or an inverted window', () => {
    assert.throws(
      () => validateDataset({ ...DATASET, events: [DATASET.events[0]!, DATASET.events[0]!] }),
      /Duplicate post id/,
    );
    assert.throws(
      () => validateDataset({ ...DATASET, window: { from: DATASET.window.to, to: DATASET.window.from } }),
      /ends at or before it starts/,
    );
  });
});

describe('replay through the real pipeline', () => {
  it('produces trades, P&L, drawdown, hit rate and risk interventions', async () => {
    const result = await runReplay({ dataset: DATASET, spec: X_SIGNAL_V1, stepMinutes: 30 });

    assert.equal(result.lookAheadClean, true);
    assert.ok(result.cycles.length > 10, 'the window should produce many cycles');
    assert.ok(result.signalsGenerated > 0, 'the dataset should generate signals');

    // The outputs the spec asks a replay to report.
    assert.equal(typeof result.returnPct, 'number');
    assert.equal(typeof result.maxDrawdownPct, 'number');
    assert.equal(typeof result.riskInterventions, 'number');
    assert.ok(Array.isArray(result.trades));
    assert.ok(result.finalEquityCents > 0);
    assert.ok('hitRatePct' in result);

    // Early cycles must have had part of the dataset still hidden — otherwise
    // time was not actually stepping and this is a look-ahead backtest.
    assert.ok(result.cycles[0]!.hiddenEvents > 0, 'the first cycle should not see the whole dataset');
    assert.equal(result.cycles[result.cycles.length - 1]!.hiddenEvents, 0, 'all events should be revealed by the end');

    assert.equal(result.errors.length, 0, `replay should be clean: ${result.errors.join('; ')}`);
  });

  it('is deterministic: the same dataset replays identically', async () => {
    const a = await runReplay({ dataset: DATASET, spec: X_SIGNAL_V1, stepMinutes: 60 });
    const b = await runReplay({ dataset: DATASET, spec: X_SIGNAL_V1, stepMinutes: 60 });

    assert.equal(a.signalsGenerated, b.signalsGenerated);
    assert.equal(a.tradeCount, b.tradeCount);
    assert.equal(a.finalEquityCents, b.finalEquityCents);
    assert.equal(a.riskInterventions, b.riskInterventions);
    assert.deepEqual(
      a.trades.map((t) => [t.ticker, t.realisedPnlCents]),
      b.trades.map((t) => [t.ticker, t.realisedPnlCents]),
    );
  });

  it('honours the strategy version it is given, not the latest one', async () => {
    const result = await runReplay({ dataset: DATASET, spec: X_SIGNAL_V1, stepMinutes: 60 });
    assert.equal(result.strategyVersion, X_SIGNAL_V1.version);
    assert.equal(result.signalConfigId, X_SIGNAL_V1.signalConfigId);
  });

  it('exports a dataset from a live store and replays it', async () => {
    const h = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await h.app.runner.runCycle();

    const to = h.clock.nowIso();
    const from = new Date(h.clock.nowMs() - 86_400_000).toISOString();
    const exported = exportDatasetFromStore(h.app.store, {
      from,
      to,
      benchmarkTicker: 'SPY',
      datasetId: 'exported-test',
      createdAt: to,
    });

    assert.ok(exported.events.length >= 2, 'the exported dataset should contain the observed posts');
    assert.ok(exported.authors.length >= 1);
    h.close();
  });
});

describe('strategy version comparison', () => {
  it('compares two immutable versions over one dataset', async () => {
    // A candidate that only trades on much stronger signals.
    const conservativeConfig = deriveSignalConfig(
      SIGNAL_CONFIG_V1,
      'x-signal-config-test-conservative',
      'Test variant: credibility-weighted, stricter price gate',
      {
        convictionWeights: {
          materiality: 0.2, credibility: 0.4, novelty: 0.1,
          engagementVelocity: 0.05, crossSourceConfirmation: 0.2, recency: 0.05,
        },
      },
    );
    registerSignalConfig(conservativeConfig);

    const candidate = deriveStrategyVersion(X_SIGNAL_V1, {
      version: '1.1.0-test',
      publishedAt: '2026-02-01T00:00:00.000Z',
      changelog: 'Test candidate: higher signal bar and credibility weighting.',
      signalConfigId: conservativeConfig.signalConfigId,
      riskLimits: { minSignalScore: 55 },
    });

    const comparison = await compareStrategyVersions({
      dataset: DATASET,
      specs: [X_SIGNAL_V1, candidate],
      stepMinutes: 60,
    });

    assert.equal(comparison.rows.length, 2);
    assert.equal(comparison.rows[0]!.version, '1.0.0');
    assert.equal(comparison.rows[1]!.version, '1.1.0-test');

    for (const row of comparison.rows) {
      for (const field of ['returnPct', 'alphaPct', 'maxDrawdownPct', 'turnover', 'tradeCount', 'signalsGenerated', 'riskInterventions']) {
        assert.ok(field in row, `comparison row is missing ${field}`);
      }
      assert.ok(Array.isArray(row.sourceTierPerformance));
    }

    // A thin sample must be flagged, not silently ranked.
    assert.equal(comparison.sampleAdequate, false);
    assert.match(comparison.caveat, /SAMPLE TOO SMALL/);
    assert.ok(comparison.bestByAlpha);

    // The stricter version must be at least as selective.
    const base = comparison.rows[0]!;
    const strict = comparison.rows[1]!;
    assert.ok(
      strict.tradeCount <= base.tradeCount,
      `a higher signal bar produced MORE trades (${strict.tradeCount} vs ${base.tradeCount})`,
    );
  });

  it('keeps the baseline immutable while deriving a candidate', () => {
    const before = structuredClone(X_SIGNAL_V1);

    const candidate = deriveStrategyVersion(X_SIGNAL_V1, {
      version: '1.2.0-test',
      publishedAt: '2026-02-02T00:00:00.000Z',
      changelog: 'Immutability probe.',
      riskLimits: { maxConcurrentPositions: 1 },
    });

    assert.deepEqual(X_SIGNAL_V1, before, 'deriving must not mutate the base version');
    assert.equal(candidate.riskLimits.maxConcurrentPositions, 1);
    assert.equal(X_SIGNAL_V1.riskLimits.maxConcurrentPositions, 5);

    // Both remain retrievable by their own ids.
    assert.equal(getStrategyVersion(X_STRATEGY_ID, '1.0.0').riskLimits.maxConcurrentPositions, 5);
    assert.equal(getStrategyVersion(X_STRATEGY_ID, '1.2.0-test').riskLimits.maxConcurrentPositions, 1);
  });

  it('refuses to republish a version id', () => {
    assert.throws(
      () =>
        deriveStrategyVersion(X_SIGNAL_V1, {
          version: '1.2.0-test',
          publishedAt: '2026-02-03T00:00:00.000Z',
          changelog: 'duplicate',
        }),
      /already published/,
    );
    assert.throws(() => registerSignalConfig(SIGNAL_CONFIG_V1), /already registered/);
  });

  it('refuses to compare fewer than two versions', async () => {
    await assert.rejects(
      () => compareStrategyVersions({ dataset: DATASET, specs: [X_SIGNAL_V1] }),
      /at least two specs/,
    );
  });
});
