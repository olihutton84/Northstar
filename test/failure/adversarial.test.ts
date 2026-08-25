/**
 * Adversarial X inputs run through the real pipeline.
 *
 * Each test states the hazard and asserts the specific defence, so a future
 * weight change that quietly removes one of them fails here rather than in
 * production.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADVERSARIAL_CASES,
  CONTRADICTORY_SOURCES,
  EDITED_LOOKING,
  LOUD_BUT_WORTHLESS,
  QUIET_PRIMARY_SOURCE,
  REPOST_STORM,
  RUMOR_AMPLIFICATION,
  SARCASM,
  SPAM_CAMPAIGN,
  STALE_BREAKING_NEWS,
  TICKER_COLLISION,
  VAGUE_COMPANY,
} from '../fixtures/adversarial.js';
import { createHarness } from '../fixtures/harness.js';

async function run(posts: Parameters<typeof createHarness>[0] extends undefined ? never : NonNullable<Parameters<typeof createHarness>[0]>['posts']) {
  const h = createHarness({ posts });
  const report = await h.app.runner.runCycle();
  return { h, report };
}

describe('adversarial X inputs', () => {
  it('does not trade on sarcasm', async () => {
    const { h, report } = await run(SARCASM.posts);
    assert.equal(report.ordersSubmitted, 0, SARCASM.expectation);
    assert.equal(h.broker.submitCount, 0);
    h.close();
  });

  it('does not resolve an ordinary English word to a ticker', async () => {
    const { h, report } = await run(VAGUE_COMPANY.posts);
    assert.equal(report.ordersSubmitted, 0, VAGUE_COMPANY.expectation);

    // Any resolution that DID occur must be flagged ambiguous and unusable.
    for (const event of h.app.store.events.recent(50)) {
      for (const r of h.app.store.resolutions.byEvent(event.eventId)) {
        assert.ok(
          r.method === 'AMBIGUOUS' || r.confidence < 0.75,
          `"${event.text.slice(0, 40)}" resolved to ${r.ticker} at ${r.confidence} via ${r.method}`,
        );
      }
    }
    h.close();
  });

  it('lowers confidence for both sides of a ticker collision', async () => {
    const { h } = await run(TICKER_COLLISION.posts);
    const event = h.app.store.events.recent(5)[0]!;
    const resolutions = h.app.store.resolutions.byEvent(event.eventId);

    assert.equal(resolutions.length, 2, 'both tickers should be recorded');
    for (const r of resolutions) {
      assert.ok(r.competingSecurityIds.length >= 1, `${r.ticker} must record its competitor`);
      assert.ok(r.confidence < 0.9, `${r.ticker} confidence ${r.confidence} should be reduced by ambiguity`);
    }
    h.close();
  });

  it('collapses a 40-account repost storm to roughly one source', async () => {
    const { h, report } = await run(REPOST_STORM.posts);

    assert.ok(report.filtered.rejected >= 35, 'the storm should be rejected as duplicates');
    for (const signal of h.app.store.signals.recent(10)) {
      assert.ok(
        signal.independentSourceCount <= 1.5,
        `storm produced ${signal.independentSourceCount} independent sources on ${signal.ticker}`,
      );
    }
    assert.equal(report.ordersSubmitted, 0, REPOST_STORM.expectation);
    h.close();
  });

  it('does not let amplified rumour clear the trading bar', async () => {
    const { h, report } = await run(RUMOR_AMPLIFICATION.posts);
    assert.equal(report.ordersSubmitted, 0, RUMOR_AMPLIFICATION.expectation);

    for (const signal of h.app.store.signals.recent(10)) {
      assert.ok(signal.score < 35, `hedged rumour scored ${signal.score}, above the trading threshold`);
    }
    h.close();
  });

  it('raises uncertainty rather than averaging contradictory credible sources', async () => {
    const { h, report } = await run(CONTRADICTORY_SOURCES.posts);
    const signal = h.app.store.signals.recent(10).find((s) => s.ticker === 'NVDA');
    assert.ok(signal, 'a signal should still be recorded — the disagreement is itself information');

    assert.ok(
      Math.abs(signal.score) < 35,
      `flatly contradictory sources produced a tradable score of ${signal.score}`,
    );
    assert.ok(signal.uncertainty > 0.15, `uncertainty ${signal.uncertainty} should reflect the disagreement`);
    assert.ok(
      signal.contradictoryEvidence.length > 0,
      'the opposing source must be recorded as contradictory evidence',
    );
    assert.equal(report.ordersSubmitted, 0);
    h.close();
  });

  it('strips conviction from stale "breaking" news', async () => {
    const { h, report } = await run(STALE_BREAKING_NEWS.posts);
    const signal = h.app.store.signals.recent(10).find((s) => s.ticker === 'NVDA');

    if (signal) {
      assert.ok(signal.components.recency < 15, `recency ${signal.components.recency} should be heavily decayed`);
      assert.ok(signal.score < 35, `a 40-hour-old story scored ${signal.score}`);
    }
    assert.equal(report.ordersSubmitted, 0, STALE_BREAKING_NEWS.expectation);
    h.close();
  });

  it('treats a re-observed post id as the same event, not new evidence', async () => {
    const { h, report } = await run(EDITED_LOOKING.posts);

    // The post id is the identity. Only one version is stored.
    assert.equal(report.ingested, 1, 'an edited post must not become a second event');
    const stored = h.app.store.events.recent(10).filter((e) => e.postId === 'edit-1');
    assert.equal(stored.length, 1);
    h.close();
  });

  it('rejects a coordinated spam campaign entirely', async () => {
    const { h, report } = await run(SPAM_CAMPAIGN.posts);

    assert.equal(report.filtered.accepted, 0, 'no spam post may be accepted as evidence');
    assert.ok(report.filtered.rejected >= 12);
    assert.equal(report.signalsGenerated, 0, SPAM_CAMPAIGN.expectation);
    assert.equal(h.broker.submitCount, 0);
    h.close();
  });

  it('does not mistake virality for information', async () => {
    const { h, report } = await run(LOUD_BUT_WORTHLESS.posts);
    assert.equal(report.ordersSubmitted, 0, LOUD_BUT_WORTHLESS.expectation);

    for (const signal of h.app.store.signals.recent(10)) {
      assert.ok(
        signal.components.credibility < 45,
        `a 250k-like anonymous post scored ${signal.components.credibility} credibility`,
      );
    }
    h.close();
  });

  it('acts on a credible primary source nobody has engaged with', async () => {
    const { h } = await run(QUIET_PRIMARY_SOURCE.posts);
    const signal = h.app.store.signals.recent(10).find((s) => s.ticker === 'TSLA');

    assert.ok(signal, 'a quiet regulator filing must still produce a signal');
    assert.ok(
      signal.components.credibility >= 85,
      `Tier-1 regulator scored only ${signal.components.credibility} credibility`,
    );
    assert.ok(signal.score <= -35, `a 12-like SEC probe scored ${signal.score}; it should be strongly bearish`);
    assert.ok(
      signal.components.engagementVelocity < 40,
      'engagement should be low — and that must not have prevented the signal',
    );
    h.close();
  });

  it('never produces an unexplained signal on any adversarial case', async () => {
    for (const testCase of ADVERSARIAL_CASES) {
      const { h } = await run(testCase.posts);
      for (const signal of h.app.store.signals.recent(20)) {
        assert.ok(signal.explanation.length > 60, `${testCase.id}: signal lacked an explanation`);
        assert.ok(signal.contributions.length >= 8, `${testCase.id}: missing component contributions`);
        assert.ok(signal.evidence.length > 0, `${testCase.id}: no evidence recorded`);
      }
      h.close();
    }
  });

  it('records a disposition for every signal on every adversarial case', async () => {
    for (const testCase of ADVERSARIAL_CASES) {
      const { h } = await run(testCase.posts);
      for (const signal of h.app.store.signals.recent(20)) {
        const view = h.app.audit.audit(signal.signalId);
        assert.ok(view, `${testCase.id}: audit view missing`);
        assert.notEqual(
          view.outcome.disposition,
          'NO_RECORD',
          `${testCase.id}: ${signal.ticker} signal ${signal.score} has no recorded disposition`,
        );
        assert.ok(view.outcome.detail.length > 10, `${testCase.id}: disposition has no explanation`);
      }
      h.close();
    }
  });
});
