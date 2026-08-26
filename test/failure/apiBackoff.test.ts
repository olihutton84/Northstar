/**
 * API pressure, end to end through the real provider.
 *
 * The unit tests cover the policy's arithmetic. These drive the actual
 * XProvider against a stubbed transport, because the failure that matters is
 * not "the backoff maths is wrong" — it is "the 429 never reached the policy".
 *
 * No credential appears anywhere in this file beyond an obviously fake token,
 * and the assertions check that none reaches the telemetry either.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FixedClock, NullLogger } from '../../src/core/index.js';
import { DEFAULT_OPERATIONS } from '../../src/config/operations.js';
import { openDatabase } from '../../src/persistence/db.js';
import { Store } from '../../src/persistence/store.js';
import { ApiMeter } from '../../src/runtime/ApiMeter.js';
import { PollingPolicy } from '../../src/runtime/PollingPolicy.js';
import { SourceRegistry } from '../../src/providers/social/sourceRegistry.js';
import { SocialProviderError } from '../../src/providers/social/SocialDataProvider.js';
import { XProvider, chunkCursorKey } from '../../src/providers/social/XProvider.js';

const NOW = '2026-03-10T15:00:00.000Z';
const FAKE_TOKEN = 'not-a-real-token';

function harness(responses: Response[]): {
  provider: XProvider;
  meter: ApiMeter;
  policy: PollingPolicy;
  clock: FixedClock;
  calls: { url: string; headers: Record<string, string> }[];
  close: () => void;
} {
  const clock = new FixedClock(NOW);
  const db = openDatabase(':memory:');
  const store = new Store(db, clock);
  const meter = new ApiMeter(store, clock, { x: DEFAULT_OPERATIONS.xDailyRequestSoftCap });
  const policy = new PollingPolicy(DEFAULT_OPERATIONS, clock, new NullLogger(), meter);

  const calls: { url: string; headers: Record<string, string> }[] = [];
  let index = 0;

  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return response.clone();
  }) as typeof fetch;

  const provider = new XProvider({
    bearerToken: FAKE_TOKEN,
    baseUrl: 'https://api.example.test/2',
    clock,
    logger: new NullLogger(),
    registry: new SourceRegistry(),
    fetchImpl,
    meter,
  });

  return { provider, meter, policy, clock, calls, close: () => db.close() };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

const EMPTY_QUERY = {
  tickers: ['NVDA'],
  keywords: ['NVIDIA'],
  since: NOW,
  limit: 50,
};

describe('X rate limiting', () => {
  it('turns a 429 into a typed error carrying the vendor Retry-After', async () => {
    const h = harness([
      new Response('{"title":"Too Many Requests"}', {
        status: 429,
        headers: { 'retry-after': '90', 'x-rate-limit-remaining': '0', 'x-rate-limit-limit': '450' },
      }),
    ]);

    await assert.rejects(
      () => h.provider.fetch(EMPTY_QUERY),
      (e: unknown) => {
        assert.ok(e instanceof SocialProviderError);
        assert.equal(e.kind, 'RATE_LIMIT');
        assert.equal(e.retryAfterSeconds, 90, 'the vendor asked for 90 seconds');
        return true;
      },
    );
    h.close();
  });

  it('records the 429 in telemetry, with the advertised headroom', async () => {
    const h = harness([
      new Response('{}', {
        status: 429,
        headers: { 'retry-after': '30', 'x-rate-limit-remaining': '0', 'x-rate-limit-limit': '450' },
      }),
    ]);

    await h.provider.fetch(EMPTY_QUERY).catch(() => null);

    const usage = h.meter.usage('x');
    assert.equal(usage.requests, 1);
    assert.equal(usage.rateLimited, 1);
    assert.equal(usage.rateLimitRemaining, 0);
    assert.equal(usage.rateLimitLimit, 450);
    h.close();
  });

  it('waits a full window when X gives no guidance at all', async () => {
    // X's recent-search limit resets on a 15-minute window, so a 429 with no
    // headers is assumed to be one. Guessing shorter would poll straight back
    // into the limit.
    const h = harness([new Response('{}', { status: 429 })]);

    await assert.rejects(
      () => h.provider.fetch(EMPTY_QUERY),
      (e: unknown) => e instanceof SocialProviderError && e.retryAfterSeconds === 900,
    );
    h.close();
  });

  it('backs off further on each consecutive rate limit', async () => {
    const h = harness([
      new Response('{}', { status: 429, headers: { 'retry-after': '10' } }),
    ]);

    const waits: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await h.provider.fetch(EMPTY_QUERY);
      } catch (e) {
        const retry = e instanceof SocialProviderError ? e.retryAfterSeconds : null;
        // The vendor is asking for only 10s; the bot's own ladder is longer
        // and wins, because repeated 429s mean the vendor's advice is not
        // working.
        waits.push(h.policy.recordRateLimit(retry));
      }
    }

    assert.deepEqual(waits, [300, 600, 900], 'doubling, then capped');
    assert.equal(h.policy.status().state, 'API_PRESSURE');
    assert.equal(h.policy.inBackoff(), true);
    h.close();
  });

  it('recovers to the baseline cadence after a successful scan', async () => {
    const h = harness([new Response('{}', { status: 429 })]);

    await h.provider.fetch(EMPTY_QUERY).catch(() => null);
    h.policy.recordRateLimit(null);
    assert.equal(h.policy.status().state, 'API_PRESSURE');

    h.policy.recordSuccess();
    // Pressure derived from the meter's own 429 recency also has to age out,
    // otherwise recovery is impossible after any rate limit.
    h.clock.advanceMinutes(20);
    assert.equal(h.policy.status().state, 'NORMAL');
    assert.equal(h.policy.nextIntervalSeconds(), 120);
    h.close();
  });

  it('classifies an auth failure as auth, not as pressure', async () => {
    const h = harness([new Response('{}', { status: 401 })]);

    await assert.rejects(
      () => h.provider.fetch(EMPTY_QUERY),
      (e: unknown) => e instanceof SocialProviderError && e.kind === 'AUTH',
    );

    assert.equal(h.meter.usage('x').unauthorized, 1);
    // Backing off on a bad token would hide a configuration error behind what
    // looks like a busy API.
    assert.equal(h.policy.status().state, 'NORMAL');
    h.close();
  });
});

describe('X request economy', () => {
  it('sends a since_id once a cursor exists, instead of a time window', async () => {
    const h = harness([
      jsonResponse({ data: [], meta: { result_count: 0, newest_id: '1900000000000000002' } }),
    ]);

    await h.provider.fetch({ ...EMPTY_QUERY, sinceIds: { [chunkCursorKey(0)]: '1900000000000000001' } });

    const url = h.calls[0]!.url;
    assert.ok(url.includes('since_id=1900000000000000001'), `expected a cursor query, got ${url}`);
    assert.ok(!url.includes('start_time'), 'a cursor makes the time window redundant');
    h.close();
  });

  it('falls back to a time window only on a cold start', async () => {
    const h = harness([jsonResponse({ data: [], meta: { result_count: 0 } })]);

    await h.provider.fetch(EMPTY_QUERY);
    const url = h.calls[0]!.url;
    assert.ok(url.includes('start_time='), 'with no cursor there is nothing else to bound on');
    assert.ok(!url.includes('since_id='), url);
    h.close();
  });

  it('returns the newest id so the cursor can advance', async () => {
    const h = harness([
      jsonResponse({ data: [], meta: { result_count: 0, newest_id: '1900000000000000009' } }),
    ]);

    const result = await h.provider.fetch(EMPTY_QUERY);
    assert.equal(result.newestIds[chunkCursorKey(0)], '1900000000000000009');
    assert.equal(result.requestCount, 1);
    h.close();
  });

  it('reports the requests a fetch actually cost', async () => {
    const h = harness([jsonResponse({ data: [], meta: { result_count: 0 } })]);
    const result = await h.provider.fetch(EMPTY_QUERY);

    assert.equal(result.requestCount, h.calls.length, 'the reported cost is the real cost');
    assert.equal(h.meter.usage('x').requests, h.calls.length);
    h.close();
  });

  it('never lets the bearer token reach telemetry', async () => {
    const h = harness([new Response('{}', { status: 401 })]);
    await h.provider.fetch(EMPTY_QUERY).catch(() => null);

    // The token travels in the Authorization header, where it belongs…
    assert.ok(h.calls[0]!.headers['authorization']?.includes(FAKE_TOKEN));

    // …and nowhere near what gets recorded or displayed.
    const serialised = JSON.stringify(h.meter.usage('x'));
    assert.ok(!serialised.includes(FAKE_TOKEN));
    assert.ok(!/bearer/i.test(serialised));
    h.close();
  });
});
