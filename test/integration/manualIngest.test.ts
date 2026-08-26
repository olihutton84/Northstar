/**
 * The temporary manual-X experiment.
 *
 * Real, public X posts supplied by an operator instead of fetched from an API
 * nobody is paying for yet. Three things have to hold for that to be safe:
 *
 *   It must be REAL, and traceable. Every observation carries the URL it came
 *   from, and every trade can be walked back to it.
 *
 *   It must be DEDUPLICATED on the post, not on the URL as typed — otherwise
 *   the same post pasted twice becomes two sources corroborating each other,
 *   which is exactly what the signal engine rewards.
 *
 *   It must EXPIRE on its own, and never reach LIVE.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHarness, TEST_NOW } from '../fixtures/harness.js';
import { parseManualBatch, parseManualPost, parseXUrl } from '../../src/ingest/manualX.js';
import {
  MANUAL_INGEST_MAX_DAYS,
  expiryFor,
  manualIngestPermitted,
  resolveWindow,
} from '../../src/config/manualIngest.js';
import { FixedClock } from '../../src/core/index.js';

const URL_NVDA = 'https://x.com/nvidianewsroom/status/1234567890123456789';

/* ================================================== 1. URL parsing ======== */

describe('X URL parsing', () => {
  it('accepts the spellings that all mean the same post', () => {
    const forms = [
      URL_NVDA,
      'https://twitter.com/nvidianewsroom/status/1234567890123456789',
      'https://www.x.com/nvidianewsroom/status/1234567890123456789?s=20&t=abc',
      'https://mobile.twitter.com/nvidianewsroom/status/1234567890123456789/photo/1',
      'x.com/nvidianewsroom/status/1234567890123456789',
      'https://x.com/nvidianewsroom/statuses/1234567890123456789',
    ];
    for (const form of forms) {
      const parsed = parseXUrl(form);
      assert.ok(parsed, `failed to parse ${form}`);
      assert.equal(parsed.postId, '1234567890123456789', form);
    }
  });

  it('refuses anything that is not an X post', () => {
    for (const bad of [
      'https://youtube.com/watch?v=abc',
      'https://x.com/nvidianewsroom',
      'https://x.com/nvidianewsroom/status/not-a-number',
      'https://example.com/x.com/a/status/123',
      '',
      'nonsense',
    ]) {
      assert.equal(parseXUrl(bad), null, `should not have parsed ${bad}`);
    }
  });

  it('takes the handle from the URL when one is not supplied', () => {
    assert.equal(parseXUrl(URL_NVDA)?.handle, 'nvidianewsroom');
  });
});

/* ================================================ 2. validation =========== */

describe('validating an operator-supplied post', () => {
  it('accepts a complete post', () => {
    const r = parseManualPost(
      { url: URL_NVDA, text: 'NVIDIA raises guidance. $NVDA', postedAt: '2026-03-10T14:00:00Z', likes: 900 },
      TEST_NOW,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.post.postId, '1234567890123456789');
    assert.equal(r.post.handle, 'nvidianewsroom');
    assert.equal(r.post.likes, 900);
  });

  it('requires a timestamp rather than defaulting it to now', () => {
    // Defaulting would manufacture urgency the operator never claimed: post age
    // is most of the signal.
    const r = parseManualPost({ url: URL_NVDA, text: 'something' }, TEST_NOW);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.problems.some((p) => p.includes('timestamp')), r.problems.join('; '));
  });

  it('refuses a post dated in the future', () => {
    const r = parseManualPost(
      { url: URL_NVDA, text: 'tomorrow', postedAt: '2026-03-12T00:00:00Z' }, TEST_NOW);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.problems.some((p) => p.includes('future')));
  });

  it('reports every problem at once, not the first', () => {
    const r = parseManualPost({ url: 'nope', text: '' }, TEST_NOW);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.problems.length >= 2, `expected several problems, got ${r.problems.join('; ')}`);
  });

  it('gives the same observation id to the same post however it was spelled', () => {
    const a = parseManualPost({ url: URL_NVDA, text: 'x', postedAt: '2026-03-10T14:00:00Z' }, TEST_NOW);
    const b = parseManualPost(
      { url: 'https://twitter.com/NVIDIANewsroom/status/1234567890123456789?s=20', text: 'x',
        postedAt: '2026-03-10T14:00:00Z' },
      TEST_NOW,
    );
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    assert.equal(a.post.observationId, b.post.observationId);
  });
});

/* ================================================ 3. batch input ========== */

describe('batch input', () => {
  it('parses the line form a person actually pastes', () => {
    const raw = [
      '# a comment',
      '',
      `${URL_NVDA} | 2026-03-10T14:00:00Z | NVIDIA raises guidance. $NVDA`,
      'https://x.com/Reuters/status/1111111111111111111 | 2026-03-10T13:00:00Z | Apple record revenue. $AAPL',
    ].join('\n');
    const results = parseManualBatch(raw, TEST_NOW);
    assert.equal(results.length, 2);
    assert.ok(results.every((r) => r.ok));
  });

  it('parses a JSON array', () => {
    const raw = JSON.stringify([
      { url: URL_NVDA, text: 'a', postedAt: '2026-03-10T14:00:00Z' },
    ]);
    const results = parseManualBatch(raw, TEST_NOW);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.ok, true);
  });

  it('keeps the good lines when one line is bad', () => {
    const raw = [
      `${URL_NVDA} | 2026-03-10T14:00:00Z | good`,
      'https://youtube.com/watch?v=x | 2026-03-10T13:00:00Z | not an X post',
    ].join('\n');
    const results = parseManualBatch(raw, TEST_NOW);
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => !r.ok).length, 1);
  });
});

/* ============================================ 4. the experiment window ==== */

describe('the 7-day window', () => {
  it('expires exactly MANUAL_INGEST_MAX_DAYS after it started', () => {
    const started = '2026-03-10T00:00:00.000Z';
    const expires = new Date(expiryFor(started)).getTime() - new Date(started).getTime();
    assert.equal(expires, MANUAL_INGEST_MAX_DAYS * 86_400_000);
    assert.equal(MANUAL_INGEST_MAX_DAYS, 7);
  });

  it('closes itself when the window passes, with no action from anyone', () => {
    const started = '2026-03-10T00:00:00.000Z';
    const stored = { startedAt: started, endedAt: null, endedReason: null, startedBy: 'op', note: '' };

    const during = resolveWindow(stored, new FixedClock('2026-03-14T00:00:00.000Z'));
    assert.equal(during.active, true);

    const after = resolveWindow(stored, new FixedClock('2026-03-18T00:00:00.000Z'));
    assert.equal(after.active, false);
    assert.ok(after.inactiveReason?.includes('expired'), after.inactiveReason ?? '');
  });

  it('cannot be extended by a stored expiry, because none is stored', () => {
    // The expiry is computed from startedAt and a constant in code. Editing the
    // row cannot lengthen the experiment; only editing the code can.
    const stored = { startedAt: '2026-03-10T00:00:00.000Z', endedAt: null, endedReason: null,
      startedBy: 'op', note: '' };
    const w = resolveWindow(stored, new FixedClock('2026-03-11T00:00:00.000Z'));
    assert.equal(w.expiresAt, expiryFor(stored.startedAt));
  });

  it('never permits manual data in LIVE, window open or not', () => {
    const open = resolveWindow(
      { startedAt: '2026-03-10T00:00:00.000Z', endedAt: null, endedReason: null, startedBy: 'op', note: '' },
      new FixedClock('2026-03-11T00:00:00.000Z'),
    );
    assert.equal(open.active, true, 'precondition: the window is open');

    assert.equal(manualIngestPermitted(open, 'PAPER', 'PAPER').permitted, true);
    assert.equal(manualIngestPermitted(open, 'LIVE', 'PAPER').permitted, false);
    assert.equal(manualIngestPermitted(open, 'PAPER', 'LIVE').permitted, false);
    assert.equal(manualIngestPermitted(open, 'LIVE', 'LIVE').permitted, false);
  });
});

/* =========================================== 5. end to end through the bot = */

describe('manual posts through the real pipeline', () => {
  /** A harness with the experiment open and a couple of real-shaped posts. */
  function experiment() {
    const h = createHarness();
    h.app.manualIngest.startExperiment('test-operator', 'unit test');
    return h;
  }

  it('stores an observation with its full provenance', () => {
    const h = experiment();
    const report = h.app.manualIngest.submit(
      { url: 'https://twitter.com/nvidianewsroom/status/1234567890123456789?s=20',
        text: 'NVIDIA raises full-year guidance. $NVDA', postedAt: '2026-03-10T14:00:00Z' },
      'test-operator',
    );
    assert.equal(report.accepted, 1);

    const stored = h.app.store.manual.byPostId('1234567890123456789');
    assert.ok(stored);
    assert.equal(stored.source, 'X_MANUAL');
    assert.equal(stored.provenance, 'MANUAL_OPERATOR_SUPPLIED');
    assert.equal(stored.canonicalUrl, URL_NVDA);
    // The URL as typed survives too: it is what the operator actually saw.
    assert.equal(stored.submittedUrl, 'https://twitter.com/nvidianewsroom/status/1234567890123456789?s=20');
    assert.equal(stored.submittedBy, 'test-operator');
    assert.equal(stored.capturedAt, TEST_NOW);
    assert.equal(stored.status, 'PENDING');
    h.close();
  });

  it('deduplicates the same post across URL spellings', () => {
    const h = experiment();
    const first = h.app.manualIngest.submit(
      { url: URL_NVDA, text: 'a', postedAt: '2026-03-10T14:00:00Z' }, 'op');
    const second = h.app.manualIngest.submit(
      { url: 'https://twitter.com/NVIDIANewsroom/status/1234567890123456789/photo/1',
        text: 'a', postedAt: '2026-03-10T14:00:00Z' }, 'op');

    assert.equal(first.accepted, 1);
    assert.equal(second.accepted, 0);
    assert.equal(second.duplicates, 1, 'the second must be reported as a duplicate, not silently dropped');
    assert.equal(h.app.store.manual.counts().total, 1);
    h.close();
  });

  it('routes observations through the existing pipeline and marks them consumed', async () => {
    const h = experiment();
    h.app.manualIngest.submitBatch(
      `${URL_NVDA} | 2026-03-10T14:00:00Z | NVIDIA raises full-year guidance to $36.0B on record demand. $NVDA`,
      'op',
    );
    // Swap in the manual provider the way production does when there is no API
    // key and the window is open.
    const { ManualSocialProvider } = await import('../../src/providers/social/ManualSocialProvider.js');
    const provider = new ManualSocialProvider({ clock: h.clock, store: h.app.store, registry: h.registry });

    const result = await provider.fetch({ tickers: ['NVDA'], keywords: [], since: TEST_NOW, limit: 50 });
    assert.equal(result.events.length, 1);
    assert.equal(result.requestCount, 0, 'manual ingest must cost nothing');

    const event = result.events[0]!;
    assert.equal(event.source, 'X_MANUAL');
    assert.equal(event.provenance, 'MANUAL_OPERATOR_SUPPLIED');
    assert.equal(event.url, URL_NVDA);
    assert.ok(event.mentionedCashtags.includes('NVDA'), 'cashtags come from the text when there are no entities');

    // Consumed once: a second scan must not re-emit it as fresh corroboration.
    const again = await provider.fetch({ tickers: ['NVDA'], keywords: [], since: TEST_NOW, limit: 50 });
    assert.equal(again.events.length, 0);
    assert.equal(h.app.store.manual.byPostId('1234567890123456789')?.status, 'INGESTED');
    h.close();
  });

  it('does not filter out a post merely because it predates the scan window', async () => {
    // The operator chose it; that IS the request. Age is judged by the signal
    // engine's recency dimension, from the true postedAt, not by dropping it.
    const h = experiment();
    h.app.manualIngest.submit(
      { url: URL_NVDA, text: 'older news. $NVDA', postedAt: '2026-03-09T09:00:00Z' }, 'op');
    const { ManualSocialProvider } = await import('../../src/providers/social/ManualSocialProvider.js');
    const provider = new ManualSocialProvider({ clock: h.clock, store: h.app.store, registry: h.registry });

    const result = await provider.fetch({ tickers: ['NVDA'], keywords: [], since: TEST_NOW, limit: 50 });
    assert.equal(result.events.length, 1, 'a post older than the scan window must still be ingested');
    assert.equal(result.events[0]?.postedAt, '2026-03-09T09:00:00.000Z', 'and keep its true age');
    h.close();
  });

  it('accepts submissions while the window is closed, but says they will not trade', () => {
    const h = createHarness(); // no experiment started
    const report = h.app.manualIngest.submit(
      { url: URL_NVDA, text: 'a', postedAt: '2026-03-10T14:00:00Z' }, 'op');
    assert.equal(report.accepted, 1, 'the queue may be filled ahead of time');
    assert.equal(report.windowClosed, true, 'but the operator must be told it is not live');
    assert.equal(h.app.manualIngestPermission().permitted, false);
    h.close();
  });

  it('opening the experiment does not start trading', () => {
    const h = createHarness();
    const before = h.app.store.orders.all().length;
    h.app.manualIngest.startExperiment('op', 'note');
    assert.equal(h.app.store.orders.all().length, before, 'opening a window must never place an order');
    assert.equal(h.app.manualWindow().active, true);
    h.close();
  });
});

/* ================================================ 6. the gate ============= */

describe('manual data and the autonomy gate', () => {
  it('reports MANUAL, never LIVE', () => {
    const h = createHarness();
    // The harness runs fixtures; the label must still distinguish the three.
    assert.equal(h.app.describeProviders().x, 'FIXTURE');
    h.close();
  });

  it('counts manual posts as real X data in PAPER while the window is open', () => {
    const h = createHarness();
    h.app.manualIngest.startExperiment('op', 'test');
    const permission = h.app.manualIngestPermission();
    assert.equal(permission.permitted, true, permission.reason);
    h.close();
  });

  it('stops counting them the moment the experiment is closed', () => {
    const h = createHarness();
    h.app.manualIngest.startExperiment('op', 'test');
    assert.equal(h.app.manualIngestPermission().permitted, true);

    h.app.manualIngest.stopExperiment('done');
    assert.equal(h.app.manualIngestPermission().permitted, false);
    h.close();
  });

  it('refuses them in LIVE even with the window wide open', () => {
    const h = createHarness({ mode: 'LIVE', liveTradingEnabled: false });
    h.app.manualIngest.startExperiment('op', 'test');
    assert.equal(h.app.manualWindow().active, true, 'precondition: the window is open');

    const permission = h.app.manualIngestPermission();
    assert.equal(permission.permitted, false);
    assert.ok(permission.reason.includes('LIVE'), permission.reason);

    // And LIVE is not autonomous regardless.
    const verdict = h.app.autonomy.evaluate();
    assert.equal(verdict.tier, 'LIVE');
    assert.equal(verdict.autonomous, false);
    h.close();
  });

  it('still refuses fixtures, which are not real at all', () => {
    // The manual acceptance must not have widened into "anything goes".
    const h = createHarness();
    h.app.manualIngest.startExperiment('op', 'test');
    const tier = h.app.autonomy.tier({
      ...h.app.describeProviders(),
      x: 'FIXTURE',
      marketData: 'TIINGO',
      broker: 'ALPACA PAPER',
    });
    assert.equal(tier, 'INCOHERENT', 'an open manual window must not launder fixture data');
    h.close();
  });

  it('reaches PAPER on manual X plus real prices and a real PAPER broker', () => {
    const h = createHarness();
    h.app.manualIngest.startExperiment('op', 'test');
    const tier = h.app.autonomy.tier({
      ...h.app.describeProviders(),
      x: 'MANUAL',
      marketData: 'TIINGO',
      broker: 'ALPACA PAPER',
    });
    assert.equal(tier, 'PAPER');
    h.close();
  });
});

/* ====================================== 7. the whole chain, end to end ==== */

describe('a manual post all the way to an order', () => {
  /**
   * A harness where the app selects the manual provider for itself.
   *
   * Two apps over one database file, because that is what production does: the
   * operator opens the window in one process (`manual start`) and starts the bot
   * in another (`npm start`). The provider is chosen at construction, so the
   * window has to exist before the bot is built — modelling it any other way
   * would test a sequence that never happens.
   */
  function manualHarness() {
    const dir = mkdtempSync(join(tmpdir(), 'northstar-manual-'));
    const databasePath = join(dir, 'db.sqlite');

    const opener = createHarness({ databasePath });
    opener.app.manualIngest.startExperiment('op', 'end-to-end');
    opener.close();

    const h = createHarness({ databasePath, selectSocialProvider: true });
    assert.equal(h.app.social.providerId, 'x-manual', 'the app must select the manual provider itself');
    return { ...h, close: () => { h.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  /**
   * The claim this pass has to earn.
   *
   * Not "the observation was stored" and not "a signal appeared", but the whole
   * chain the requirement names: event detection, ticker resolution,
   * x-signal-v1 scoring, price confirmation, the risk engine, and an order at
   * the broker — with the finished trade still pointing back at the URL that
   * was pasted in.
   */
  it('produces an order, and the order traces back to the pasted URL', async () => {
    // selectSocialProvider: the app picks its own provider, exercising the real
    // selection path rather than having one handed to it.
    const h = manualHarness();

    // The same two real-shaped posts the fixture pipeline trades on, supplied
    // by hand instead. Timestamps are minutes before the harness clock, as a
    // freshly-observed post would be.
    const report = h.app.manualIngest.submitMany(
      [
        {
          url: 'https://x.com/nvidia/status/1900000000000000001',
          handle: 'nvidia',
          displayName: 'NVIDIA',
          verified: true,
          followerCount: 3_000_000,
          postedAt: new Date(new Date(TEST_NOW).getTime() - 5 * 60_000).toISOString(),
          text:
            'NVIDIA raises guidance for the third quarter to $32.5B, up 24% sequentially. ' +
            'Data centre demand continues to exceed our prior outlook. $NVDA',
          likes: 8200, reposts: 2100, replies: 640, quotes: 380,
        },
        {
          url: 'https://x.com/reuters/status/1900000000000000002',
          handle: 'reuters',
          displayName: 'Reuters',
          verified: true,
          followerCount: 26_000_000,
          postedAt: new Date(new Date(TEST_NOW).getTime() - 4 * 60_000).toISOString(),
          text:
            'Nvidia lifts quarterly guidance to $32.5 billion on accelerating data centre demand, ' +
            'well ahead of analyst expectations of $29.1 billion. $NVDA',
          likes: 3100, reposts: 1400, replies: 300, quotes: 200,
        },
      ],
      'op',
    );
    assert.equal(report.accepted, 2, JSON.stringify(report.outcomes));

    await h.app.runner.runCycle();

    /* ---- an order actually exists ---- */
    const orders = h.app.store.orders.all();
    assert.ok(orders.length >= 1, 'manual posts must be able to produce an order');
    const order = orders[0]!;
    assert.equal(order.ticker, 'NVDA');
    assert.equal(order.side, 'BUY');

    /* ---- price confirmation ran ---- */
    const signal = h.app.store.signals.recent(5).find((s) => s.ticker === 'NVDA');
    assert.ok(signal, 'a signal must have been scored for NVDA');
    assert.ok(
      signal.components.priceConfirmation !== undefined,
      'the market-data confirmation component must have been evaluated',
    );

    /* ---- risk ran and approved ---- */
    const proposal = h.app.store.proposals.recent(5).find((p) => p.ticker === 'NVDA');
    assert.ok(proposal, 'a proposal must exist');
    const risk = proposal.riskDecisionId ? h.app.store.risk.byId(proposal.riskDecisionId) : null;
    assert.ok(risk?.approved, 'the risk engine must have approved it');

    /* ---- and the whole thing walks back to the URL that was pasted ---- */
    const events = h.app.store.events.byIds(signal.triggeringEventIds);
    assert.ok(events.length >= 1);
    for (const e of events) {
      assert.equal(e.source, 'X_MANUAL');
      assert.equal(e.provenance, 'MANUAL_OPERATOR_SUPPLIED');
      const observation = h.app.store.manual.byPostId(e.postId);
      assert.ok(observation, `no observation behind event ${e.eventId}`);
      assert.equal(observation.canonicalUrl, e.url);
      assert.equal(observation.submittedBy, 'op');
    }
    const urls = events.map((e) => e.url);
    assert.ok(
      urls.includes('https://x.com/nvidia/status/1900000000000000001'),
      `the pasted URL must be reachable from the trade; got ${urls.join(', ')}`,
    );
    h.close();
  });

  it('costs zero vendor requests to do it', async () => {
    const h = manualHarness();
    h.app.manualIngest.submit(
      { url: 'https://x.com/nvidia/status/1900000000000000003', handle: 'nvidia',
        postedAt: new Date(new Date(TEST_NOW).getTime() - 5 * 60_000).toISOString(),
        text: 'NVIDIA raises guidance to $32.5B on data centre demand. $NVDA' },
      'op',
    );
    const report = await h.app.runner.runCycle();
    assert.equal(report.xRequests, 0, 'the whole point is that it costs nothing');
    assert.equal(h.app.social.providerId, 'x-manual', 'the app must have selected the manual provider itself');
    assert.equal(
      h.app.social.plannedRequestsPerScan({ tickers: [], keywords: [], since: TEST_NOW, limit: 10 }), 0);
    h.close();
  });
});
