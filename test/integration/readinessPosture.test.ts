/**
 * Readiness and the execution gate must believe the same thing.
 *
 * They did not. The gate accepted operator-supplied X posts inside the
 * experiment window; readiness classified the same provider as a fixture and
 * demanded the X_BEARER_TOKEN the experiment exists to avoid paying for. That
 * was not a cosmetic disagreement: the gate refuses to act without a PASSING
 * readiness verdict, so the two definitions deadlocked and the manual
 * experiment could never trade at all.
 *
 * The decision now lives in one place — `dataPosture` — and both read it. These
 * tests pin the four postures, and then pin that the two components agree.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHarness } from '../fixtures/harness.js';
import { realDataConfigured, unrealProviders, xPosture } from '../../src/runtime/dataPosture.js';
import { buildObservability } from '../../src/api/observability.js';
import type { ProviderSummary } from '../../src/app.js';
import { NO_MANUAL_WINDOW } from '../../src/config/manualIngest.js';

const OPEN = { permitted: true, reason: 'Manual-X experiment active until 2026-09-02T00:00:00Z (100h remaining).' };
const CLOSED = { permitted: false, reason: 'The manual-X experiment has never been started.' };
const EXPIRED = { permitted: false, reason: 'The 7-day manual-X experiment expired at 2026-03-17T00:00:00Z.' };
const LIVE_REFUSED = { permitted: false, reason: 'LIVE never accepts operator-supplied X posts.' };

function providers(over: Partial<ProviderSummary>): ProviderSummary {
  return {
    x: 'FIXTURE',
    marketData: 'TIINGO',
    broker: 'ALPACA PAPER',
    mode: 'PAPER',
    universe: {
      origin: 'BOT_FALLBACK', version: 'bot-fallback-v1', securityCount: 29,
      fingerprint: 'x', rejection: null, generatedAt: '2026-03-10T00:00:00Z', label: 'BOT FALLBACK',
    },
    allReal: false,
    forcedFixtures: false,
    manual: NO_MANUAL_WINDOW,
    ...over,
  };
}

/* ================================================== 1. the four postures == */

describe('what counts as real X data', () => {
  it('treats the API as real, and requires its token', () => {
    const p = xPosture(providers({ x: 'LIVE' }), CLOSED);
    assert.equal(p.posture, 'API_LIVE');
    assert.equal(p.realData, true);
    assert.equal(p.credentialsRequired, true);
    assert.equal(p.label, 'X API LIVE');
  });

  it('treats an OPEN manual window as real, and does NOT require the token', () => {
    // The experiment exists because the API costs money. Demanding its token
    // anyway is the bug this pins.
    const p = xPosture(providers({ x: 'MANUAL' }), OPEN);
    assert.equal(p.posture, 'MANUAL_EXPERIMENT');
    assert.equal(p.realData, true);
    assert.equal(p.credentialsRequired, false);
    assert.equal(p.label, 'MANUAL REAL OBSERVED DATA', 'provenance is preserved, never renamed to LIVE');
  });

  it('treats a CLOSED manual window as not usable', () => {
    const p = xPosture(providers({ x: 'MANUAL' }), CLOSED);
    assert.equal(p.posture, 'MANUAL_UNAVAILABLE');
    assert.equal(p.realData, false);
  });

  it('treats an EXPIRED manual window as not usable', () => {
    const p = xPosture(providers({ x: 'MANUAL' }), EXPIRED);
    assert.equal(p.posture, 'MANUAL_UNAVAILABLE');
    assert.equal(p.realData, false);
    assert.match(p.detail, /expired/);
  });

  it('never treats fixtures as real, whatever the window says', () => {
    for (const manual of [OPEN, CLOSED, EXPIRED]) {
      const p = xPosture(providers({ x: 'FIXTURE' }), manual);
      assert.equal(p.posture, 'FIXTURE');
      assert.equal(p.realData, false, 'an open window must never launder fixture data');
    }
  });
});

/* ================================================ 2. the composite ======== */

describe('whether the whole configuration is real data', () => {
  it('accepts manual X + Tiingo + Alpaca PAPER', () => {
    assert.equal(realDataConfigured(providers({ x: 'MANUAL' }), OPEN), true);
  });

  it('accepts live X + Tiingo + Alpaca PAPER', () => {
    assert.equal(realDataConfigured(providers({ x: 'LIVE' }), CLOSED), true);
  });

  it('rejects manual X once the window has gone', () => {
    assert.equal(realDataConfigured(providers({ x: 'MANUAL' }), EXPIRED), false);
  });

  it('rejects fixture X against a real broker', () => {
    assert.equal(realDataConfigured(providers({ x: 'FIXTURE' }), OPEN), false);
  });

  it('rejects fixture market data even with real X', () => {
    assert.equal(realDataConfigured(providers({ x: 'LIVE', marketData: 'FIXTURE' }), CLOSED), false);
  });

  it('rejects a simulated broker', () => {
    assert.equal(realDataConfigured(providers({ x: 'MANUAL', broker: 'SIMULATED' }), OPEN), false);
  });

  it('does not list an open manual experiment as an unreal provider', () => {
    assert.deepEqual(unrealProviders(providers({ x: 'MANUAL' }), OPEN), []);
  });

  it('does list a fixture provider', () => {
    const unreal = unrealProviders(providers({ x: 'FIXTURE' }), OPEN);
    assert.equal(unreal.length, 1);
    assert.match(unreal[0]!, /^X /);
  });
});

/* ================================================== 3. LIVE is refused ==== */

describe('LIVE never accepts manual X', () => {
  it('refuses the posture outright when the permission says LIVE', () => {
    const p = xPosture(providers({ x: 'MANUAL', mode: 'LIVE' }), LIVE_REFUSED);
    assert.equal(p.realData, false);
    assert.match(p.detail, /LIVE/);
  });

  it('refuses at the app level with the window wide open', () => {
    const h = createHarness({ mode: 'LIVE', liveTradingEnabled: false });
    h.app.manualIngest.startExperiment('op', 'test');
    assert.equal(h.app.manualWindow().active, true, 'precondition: the window is open');
    assert.equal(h.app.manualIngestPermission().permitted, false);

    const verdict = h.app.autonomy.evaluate();
    assert.equal(verdict.tier, 'LIVE');
    assert.equal(verdict.autonomous, false);
    assert.equal(verdict.requiresHumanApproval, true);
    h.close();
  });
});

/* ================================== 4. readiness and the gate agree ======= */

describe('readiness and the autonomy gate cannot disagree', () => {
  /**
   * A harness that has really selected the manual provider.
   *
   * Two apps over one database file, because the provider is chosen at
   * construction: the operator opens the window in one process and starts the
   * bot in another. Opening a window on an already-running bot changes nothing,
   * which is the behaviour the gate reports separately.
   */
  function manualHarness() {
    const dir = mkdtempSync(join(tmpdir(), 'northstar-posture-'));
    const databasePath = join(dir, 'db.sqlite');
    const opener = createHarness({ databasePath });
    opener.app.manualIngest.startExperiment('op', 'posture test');
    opener.close();

    const h = createHarness({ databasePath, selectSocialProvider: true });
    assert.equal(h.app.social.providerId, 'x-manual', 'precondition: the manual provider is active');
    return { ...h, close: () => { h.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  it('readiness stops demanding the X token during a valid manual window', async () => {
    const h = manualHarness();
    const report = await h.app.readiness.run();

    const credentials = report.checks.find((c) => c.id === 'credentials');
    assert.ok(credentials);
    // The harness has no X token at all; the check must not blame it.
    assert.doesNotMatch(credentials.detail, /X ABSENT/);
    assert.match(credentials.detail, /NOT REQUIRED/);
    h.close();
  });

  it('readiness still demands the X token when there is no manual window', async () => {
    const h = createHarness();
    const report = await h.app.readiness.run();
    const credentials = report.checks.find((c) => c.id === 'credentials');
    assert.ok(credentials);
    assert.match(credentials.detail, /X ABSENT/, 'without a window the token is genuinely required');
    h.close();
  });

  it('readiness reports the same real-data verdict the shared rule computes', async () => {
    /*
     * Like for like. `no-fixtures` is the COMPOSITE question (X, prices and
     * broker together); the gate's `live-x` is about X alone — comparing those
     * two directly compares different questions. What must hold is that
     * readiness's verdict is the shared rule's verdict, computed independently
     * here from the same inputs.
     */
    const h = manualHarness();
    const report = await h.app.readiness.run();
    const expected = realDataConfigured(h.app.describeProviders(), h.app.manualIngestPermission());
    assert.equal(report.liveDataConfigured, expected);
    h.close();
  });

  it('the gate judges X exactly as the shared rule does', () => {
    const h = manualHarness();
    const gate = h.app.autonomy.evaluate();
    const expected = xPosture(h.app.describeProviders(), h.app.manualIngestPermission()).realData;
    assert.equal(gate.checks.find((c) => c.id === 'live-x')?.passed, expected);
    h.close();
  });

  it('closing the window flips BOTH of them together', async () => {
    const h = manualHarness();

    /*
     * The gate is asked at PAPER tier deliberately. This harness runs a
     * simulated broker, where real X data is not required and `live-x` passes
     * whatever the window says — correctly, but it would prove nothing here.
     * The question that matters is what happens against a real PAPER account.
     */
    const asPaper = () => h.app.autonomy.tier({
      ...h.app.describeProviders(), x: 'MANUAL', marketData: 'TIINGO', broker: 'ALPACA PAPER',
    });

    const openX = xPosture(h.app.describeProviders(), h.app.manualIngestPermission()).realData;
    const openCredentials = (await h.app.readiness.run()).checks.find((c) => c.id === 'credentials');
    assert.equal(openX, true);
    assert.equal(asPaper(), 'PAPER', 'an open window reaches the PAPER tier');
    assert.match(openCredentials!.detail, /NOT REQUIRED/);

    h.app.manualIngest.stopExperiment('done for the day');

    const closedX = xPosture(h.app.describeProviders(), h.app.manualIngestPermission()).realData;
    const closedCredentials = (await h.app.readiness.run()).checks.find((c) => c.id === 'credentials');
    assert.equal(closedX, false, 'the shared rule flips');
    assert.equal(asPaper(), 'INCOHERENT', 'and so does the gate: manual data is no longer real');
    assert.match(closedCredentials!.detail, /X ABSENT/, 'and readiness starts requiring the token again');
    h.close();
  });
});

/* ============================== 5. operator-facing surfaces agree ========= */

describe('every operator-facing surface reports the same posture', () => {
  /**
   * The bug this pins.
   *
   * `npm run status` printed "Running on fixtures. No live data or orders."
   * while readiness said READY FOR REAL-DATA PAPER and the gate agreed. Three
   * surfaces, three independent answers, one of them wrong — and the wrong one
   * was the one an operator reads before deciding whether to trust the run.
   */
  function manualHarness() {
    const dir = mkdtempSync(join(tmpdir(), 'northstar-surfaces-'));
    const databasePath = join(dir, 'db.sqlite');
    const opener = createHarness({ databasePath });
    opener.app.manualIngest.startExperiment('op', 'surfaces');
    opener.close();
    const h = createHarness({ databasePath, selectSocialProvider: true });
    return { ...h, close: () => { h.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  it('does not call the manual X provider a fixture', () => {
    /*
     * Precisely X. This harness really does run fixture market data and a
     * simulated broker, so "fixture" legitimately appears in the summary — the
     * claim under test is that X is not among them.
     */
    const h = manualHarness();
    const o = buildObservability(h.app);
    const unreal = unrealProviders(h.app.describeProviders(), h.app.manualIngestPermission());
    assert.ok(!unreal.some((u) => u.startsWith('X ')), `X must not be listed as unreal: ${unreal.join(', ')}`);
    assert.match(o.providers.xLabel, /MANUAL REAL OBSERVED DATA/);
    // And the old wording is gone entirely.
    assert.doesNotMatch(o.summary.connectedDetail, /Running on fixtures/i);
    h.close();
  });

  it('drops the manual X provider into the unreal list once the window closes', () => {
    const h = manualHarness();
    h.app.manualIngest.stopExperiment('closed');
    const unreal = unrealProviders(h.app.describeProviders(), h.app.manualIngestPermission());
    assert.ok(unreal.some((u) => u.startsWith('X ')), 'a closed window makes X unusable again');
    h.close();
  });

  it('labels a fixture run as a fixture run', () => {
    const h = createHarness(); // fixtures forced
    const o = buildObservability(h.app);
    assert.equal(o.providers.realData, false);
    assert.match(o.providers.xLabel, /FIXTURE/);
    assert.match(o.summary.connectedDetail, /Not real data/);
    h.close();
  });

  it('never labels manual data as LIVE', () => {
    const h = manualHarness();
    const o = buildObservability(h.app);
    assert.notEqual(o.providers.xLabel, 'X API LIVE');
    assert.notEqual(o.providers.x, 'LIVE');
    assert.equal(o.providers.x, 'MANUAL', 'the provenance stays distinguishable');
    h.close();
  });

  it('uses ONE label string, shared with the canonical posture', () => {
    // Two spellings of the same state is how surfaces drift apart again.
    const h = manualHarness();
    const o = buildObservability(h.app);
    const canonical = xPosture(h.app.describeProviders(), h.app.manualIngestPermission());
    assert.equal(o.providers.xLabel, canonical.label);
    h.close();
  });

  it('uses the posture, not `allReal`, where the two genuinely differ', () => {
    /*
     * The exact shape of the reported bug, and the one case that can catch it.
     *
     * With manual X plus REAL Tiingo and REAL Alpaca PAPER, `allReal` is false
     * (X is not the vendor API) while the configuration is unambiguously real
     * data. Anywhere those two are conflated, this configuration reports a
     * fixture run. Every other harness has fixture market data too, so
     * `allReal` and `realData` agree there and the mistake hides.
     */
    const h = manualHarness();
    const real = {
      ...h.app.describeProviders(),
      x: 'MANUAL' as const,
      marketData: 'TIINGO' as const,
      broker: 'ALPACA PAPER',
      allReal: false,
    };
    h.app.describeProviders = () => real;

    assert.equal(real.allReal, false, 'precondition: allReal is false for manual X');
    assert.equal(
      realDataConfigured(real, h.app.manualIngestPermission()), true,
      'precondition: but it IS real data',
    );

    const o = buildObservability(h.app);
    assert.equal(o.providers.realData, true, 'the dashboard must follow the posture, not allReal');
    assert.equal(o.summary.connected, true, 'and must not report a fixture run');
    assert.doesNotMatch(o.summary.connectedDetail, /Not real data/);
    assert.match(o.summary.connectedDetail, /MANUAL REAL OBSERVED DATA/);
    h.close();
  });

  it('agrees with readiness and the gate about whether this is real data', async () => {
    const h = manualHarness();
    const o = buildObservability(h.app);
    const report = await h.app.readiness.run();
    const canonical = realDataConfigured(h.app.describeProviders(), h.app.manualIngestPermission());

    assert.equal(o.providers.realData, canonical, 'the dashboard must match the canonical rule');
    assert.equal(report.liveDataConfigured, canonical, 'and so must readiness');
    h.close();
  });

  it('reports LIVE trading as disabled while the broker is PAPER', () => {
    const h = manualHarness();
    assert.notEqual(h.app.broker.mode, 'LIVE');
    assert.notEqual(h.app.describeProviders().mode, 'LIVE');
    h.close();
  });
});
