/**
 * API efficiency and rate control.
 *
 * These tests exist because every one of them protects a property that is
 * invisible until the day it costs the whole session: a cursor that regresses
 * re-downloads the window, a cache that launders staleness prices a trade on a
 * dead quote, a backoff that resets polls straight back into a rate limit.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FixedClock, NullLogger } from '../../src/core/index.js';
import { DEFAULT_OPERATIONS, estimateDailyXRequests, loadOperations } from '../../src/config/operations.js';
import { ApiMeter, parseRateLimitHeaders } from '../../src/runtime/ApiMeter.js';
import { PollingPolicy } from '../../src/runtime/PollingPolicy.js';
import { CachingMarketDataProvider } from '../../src/providers/marketdata/CachingMarketDataProvider.js';
import { isNewerCursor, Store } from '../../src/persistence/store.js';
import { openDatabase } from '../../src/persistence/db.js';
import type { MarketDataProvider } from '../../src/providers/marketdata/MarketDataProvider.js';
import type { MarketCalendarStatus, PriceBar, Quote } from '../../src/domain/types.js';

const NOW = '2026-03-10T15:00:00.000Z';

function makeStore(clock: FixedClock): { store: Store; close: () => void } {
  const db = openDatabase(':memory:');
  const store = new Store(db, clock);
  return { store, close: () => db.close() };
}

/* --------------------------------------------------------------- meter */

describe('api meter', () => {
  it('counts outcomes per provider per day', () => {
    const clock = new FixedClock(NOW);
    const { store, close } = makeStore(clock);
    const meter = new ApiMeter(store, clock, { x: 400 });

    meter.record('x', 'SUCCESS');
    meter.record('x', 'SUCCESS');
    meter.record('x', 'RATE_LIMITED', 'search -> 429');
    meter.record('tiingo', 'SUCCESS');

    const x = meter.usage('x');
    assert.equal(x.requests, 3);
    assert.equal(x.successes, 2);
    assert.equal(x.rateLimited, 1);
    assert.equal(x.lastErrorKind, 'RATE_LIMITED');
    assert.equal(meter.usage('tiingo').requests, 1);
    // Alpaca was never called, and must read as zero rather than be absent.
    assert.equal(meter.usage('alpaca').requests, 0);
    close();
  });

  it('never stores anything but status codes and vendor text', () => {
    const clock = new FixedClock(NOW);
    const { store, close } = makeStore(clock);
    const meter = new ApiMeter(store, clock);

    meter.record('x', 'UNAUTHORIZED', '/2/tweets/search/recent -> 401');
    const serialised = JSON.stringify(meter.usage('x'));

    // The detail the provider passes is a path and a status; a token or key
    // has no path into this class at all.
    assert.ok(!/Bearer/i.test(serialised));
    assert.ok(serialised.includes('401'));
    close();
  });

  it('classifies HTTP status codes', () => {
    assert.equal(ApiMeter.outcomeForStatus(200), 'SUCCESS');
    assert.equal(ApiMeter.outcomeForStatus(401), 'UNAUTHORIZED');
    assert.equal(ApiMeter.outcomeForStatus(403), 'FORBIDDEN');
    assert.equal(ApiMeter.outcomeForStatus(429), 'RATE_LIMITED');
    assert.equal(ApiMeter.outcomeForStatus(503), 'SERVER_ERROR');
    assert.equal(ApiMeter.outcomeForStatus(418), 'OTHER_ERROR');
  });

  it('detects pressure from low headroom, not only from a 429', () => {
    const clock = new FixedClock(NOW);
    const { store, close } = makeStore(clock);
    const meter = new ApiMeter(store, clock, { x: 400 });

    meter.record('x', 'SUCCESS', null, { remaining: 100, limit: 450, resetAt: null });
    assert.equal(meter.underPressure('x').pressured, false, '22% headroom is fine');

    meter.record('x', 'SUCCESS', null, { remaining: 20, limit: 450, resetAt: null });
    const pressure = meter.underPressure('x');
    assert.equal(pressure.pressured, true, 'under 15% headroom is pressure');
    assert.match(pressure.reason, /20 of 450/);
    close();
  });

  it('detects pressure when the daily soft cap is consumed', () => {
    const clock = new FixedClock(NOW);
    const { store, close } = makeStore(clock);
    const meter = new ApiMeter(store, clock, { x: 3 });

    for (let i = 0; i < 3; i += 1) meter.record('x', 'SUCCESS');
    assert.equal(meter.underPressure('x').pressured, true);
    assert.match(meter.underPressure('x').reason, /soft cap/);
    close();
  });

  it('parses both epoch and delta rate-limit resets', () => {
    const clock = new FixedClock(NOW);
    const nowSeconds = Math.floor(clock.nowMs() / 1000);

    const epoch = parseRateLimitHeaders(
      new Headers({ 'x-rate-limit-remaining': '42', 'x-rate-limit-limit': '450', 'x-rate-limit-reset': String(nowSeconds + 600) }),
      clock,
    );
    assert.equal(epoch.remaining, 42);
    assert.equal(epoch.resetAt, new Date((nowSeconds + 600) * 1000).toISOString());

    // Some vendors send seconds-until-reset instead. Treating 600 as an epoch
    // would place the reset in 1970.
    const delta = parseRateLimitHeaders(new Headers({ 'x-ratelimit-reset': '600' }), clock);
    assert.equal(delta.resetAt, new Date(clock.nowMs() + 600_000).toISOString());

    const absent = parseRateLimitHeaders(new Headers(), clock);
    assert.equal(absent.remaining, null);
    assert.equal(absent.resetAt, null);
  });
});

/* ------------------------------------------------------------- polling */

describe('polling policy', () => {
  function policy(clock: FixedClock, meter: ApiMeter | null = null): PollingPolicy {
    return new PollingPolicy(DEFAULT_OPERATIONS, clock, new NullLogger(), meter);
  }

  it('runs at the baseline cadence with nothing happening', () => {
    const p = policy(new FixedClock(NOW));
    const status = p.status();
    assert.equal(status.state, 'NORMAL');
    assert.equal(status.intervalSeconds, 120);
  });

  it('speeds up for a strong new event, and only for a strong one', () => {
    const clock = new FixedClock(NOW);
    const p = policy(clock);

    p.watch('NVDA', 20);
    assert.equal(p.status().state, 'NORMAL', 'a weak signal must not change cadence');

    p.watch('NVDA', 62);
    const watching = p.status();
    assert.equal(watching.state, 'EVENT_WATCH');
    assert.equal(watching.intervalSeconds, 60);
    assert.equal(watching.watching[0]?.ticker, 'NVDA');
  });

  it('lets an event watch expire back to baseline', () => {
    const clock = new FixedClock(NOW);
    const p = policy(clock);
    p.watch('NVDA', 70);
    assert.equal(p.status().state, 'EVENT_WATCH');

    clock.advanceMinutes(DEFAULT_OPERATIONS.xEventWatchMinutes + 1);
    assert.equal(p.status().state, 'NORMAL');
    assert.equal(p.isWatching('NVDA'), false);
  });

  it('backs off exponentially and honours a longer Retry-After', () => {
    const clock = new FixedClock(NOW);
    const p = policy(clock);

    assert.equal(p.recordRateLimit(null), 300, 'first 429 waits one pressure interval');
    assert.equal(p.recordRateLimit(null), 600, 'second doubles');
    assert.equal(p.recordRateLimit(null), 1200 > 900 ? 900 : 1200, 'third is capped');

    // The vendor asking for longer wins; asking for less does not shorten it.
    assert.equal(p.recordRateLimit(3600), 3600);
    assert.equal(p.recordRateLimit(5), 900);
  });

  it('puts pressure ahead of event watch', () => {
    const clock = new FixedClock(NOW);
    const p = policy(clock);
    p.watch('NVDA', 80);
    p.recordRateLimit(null);

    const status = p.status();
    assert.equal(status.state, 'API_PRESSURE', 'never poll faster into a rate limit');
    assert.ok(status.intervalSeconds >= 300);
  });

  it('clears the ladder on a successful poll', () => {
    const clock = new FixedClock(NOW);
    const p = policy(clock);
    p.recordRateLimit(null);
    p.recordRateLimit(null);
    p.recordSuccess();

    assert.equal(p.status().state, 'NORMAL');
    assert.equal(p.backoffSeconds(), 0);
    assert.equal(p.inBackoff(), false);
  });

  it('starts a fresh ladder after a long quiet period', () => {
    const clock = new FixedClock(NOW);
    const p = policy(clock);
    p.recordRateLimit(null);
    p.recordRateLimit(null);
    assert.equal(p.backoffSeconds(), 600);

    // A 429 an hour later is a new incident, not an escalation of the old one.
    clock.advanceMinutes(DEFAULT_OPERATIONS.xBackoffResetAfterMinutes + 5);
    assert.equal(p.recordRateLimit(null), 300);
  });

  it('reads pressure from the meter even with no 429 of its own', () => {
    const clock = new FixedClock(NOW);
    const { store, close } = makeStore(clock);
    const meter = new ApiMeter(store, clock, { x: 400 });
    meter.record('x', 'SUCCESS', null, { remaining: 5, limit: 450, resetAt: null });

    const p = policy(clock, meter);
    assert.equal(p.status().state, 'API_PRESSURE');
    close();
  });
});

/* -------------------------------------------------------------- cursors */

describe('polling cursors', () => {
  it('advances only forwards over ordered ids', () => {
    assert.equal(isNewerCursor('100', '99'), true);
    assert.equal(isNewerCursor('99', '100'), false);
    // The case string comparison gets wrong: more digits is a larger snowflake.
    assert.equal(isNewerCursor('1000000000000000000', '999999999999999999'), true);
  });

  it('refuses to regress a stored cursor', () => {
    const clock = new FixedClock(NOW);
    const { store, close } = makeStore(clock);

    assert.equal(store.cursors.advance('x:chunk:0', '5000'), true);
    assert.equal(store.cursors.advance('x:chunk:0', '4000'), false, 'a regression re-downloads the window');
    assert.equal(store.cursors.get('x:chunk:0')?.value, '5000');

    assert.equal(store.cursors.advance('x:chunk:0', '6000'), true);
    assert.equal(store.cursors.get('x:chunk:0')?.value, '6000');
    close();
  });

  it('returns cursors shaped for a social query, scoped by prefix', () => {
    const clock = new FixedClock(NOW);
    const { store, close } = makeStore(clock);
    store.cursors.advance('x:chunk:0', '111');
    store.cursors.advance('x:chunk:1', '222');
    store.cursors.advance('other:thing', '333');

    assert.deepEqual(store.cursors.all('x:'), { 'x:chunk:0': '111', 'x:chunk:1': '222' });
    close();
  });
});

/* ---------------------------------------------------------------- cache */

class CountingMarketData implements MarketDataProvider {
  readonly providerId = 'counting';
  quoteCalls = 0;
  barCalls = 0;
  price = 100;
  asOf = NOW;

  async healthCheck(): Promise<{ healthy: boolean; detail: string }> {
    return { healthy: true, detail: 'ok' };
  }

  async getQuote(ticker: string): Promise<Quote> {
    const map = await this.getQuotes([ticker]);
    return map.get(ticker.toUpperCase())!;
  }

  async getQuotes(tickers: string[]): Promise<Map<string, Quote>> {
    this.quoteCalls += 1;
    const out = new Map<string, Quote>();
    for (const t of tickers) {
      out.set(t.toUpperCase(), {
        ticker: t.toUpperCase(),
        price: this.price,
        asOf: this.asOf,
        ageMinutes: 0,
        stale: false,
      });
    }
    return out;
  }

  async getDailyBars(ticker: string, fromIso: string, toIso: string): Promise<PriceBar[]> {
    this.barCalls += 1;
    const bars: PriceBar[] = [];
    for (let i = 0; i < 10; i += 1) {
      const at = new Date(new Date(fromIso).getTime() + i * 86_400_000).toISOString();
      if (at > toIso) break;
      bars.push({ ticker: ticker.toUpperCase(), at, open: 100, high: 101, low: 99, close: 100, volume: 1000 });
    }
    return bars;
  }

  async getIntradayBars(): Promise<PriceBar[]> {
    return [];
  }

  async getMarketStatus(): Promise<MarketCalendarStatus> {
    return { isOpen: true, asOf: this.asOf, nextOpen: null, nextClose: null, reason: 'test' };
  }
}

describe('market data cache', () => {
  function caching(clock: FixedClock, delegate: CountingMarketData): CachingMarketDataProvider {
    return new CachingMarketDataProvider({
      delegate,
      clock,
      logger: new NullLogger(),
      quoteCacheSeconds: 45,
      historyRefreshMinutes: 60,
      staleAfterMinutes: 30,
    });
  }

  it('serves a repeated quote without a second vendor call', async () => {
    const clock = new FixedClock(NOW);
    const delegate = new CountingMarketData();
    const cache = caching(clock, delegate);

    await cache.getQuote('NVDA');
    await cache.getQuote('NVDA');
    await cache.getQuote('nvda');

    assert.equal(delegate.quoteCalls, 1, 'three lookups, one request');
    assert.equal(cache.stats().quoteHits, 2);
  });

  it('asks the vendor only for the tickers it does not already hold', async () => {
    const clock = new FixedClock(NOW);
    const delegate = new CountingMarketData();
    const cache = caching(clock, delegate);

    await cache.getQuotes(['NVDA', 'AAPL']);
    await cache.getQuotes(['NVDA', 'AAPL', 'TSLA']);

    assert.equal(delegate.quoteCalls, 2);
    assert.equal(cache.stats().quoteHits, 2, 'NVDA and AAPL came from cache the second time');
  });

  it('refetches once the quote TTL has passed', async () => {
    const clock = new FixedClock(NOW);
    const delegate = new CountingMarketData();
    const cache = caching(clock, delegate);

    await cache.getQuote('NVDA');
    clock.advanceMs(46_000);
    await cache.getQuote('NVDA');

    assert.equal(delegate.quoteCalls, 2);
  });

  it('never lets a cached quote look fresher than it is', async () => {
    const clock = new FixedClock(NOW);
    const delegate = new CountingMarketData();
    const cache = new CachingMarketDataProvider({
      delegate,
      clock,
      logger: new NullLogger(),
      // A deliberately long TTL: the point is that age is recomputed, not that
      // the entry expires.
      quoteCacheSeconds: 3600,
      historyRefreshMinutes: 60,
      staleAfterMinutes: 30,
    });

    const fresh = await cache.getQuote('NVDA');
    assert.equal(fresh.ageMinutes, 0);
    assert.equal(fresh.stale, false);

    clock.advanceMinutes(45);
    const cached = await cache.getQuote('NVDA');

    assert.equal(delegate.quoteCalls, 1, 'still served from cache');
    assert.ok(cached.ageMinutes >= 44.9, 'age is recomputed from the vendor asOf');
    assert.equal(cached.stale, true, 'a 45-minute-old mark is stale however it was served');
  });

  it('slices a narrower bar range out of a wider cached one', async () => {
    const clock = new FixedClock(NOW);
    const delegate = new CountingMarketData();
    const cache = caching(clock, delegate);

    const from = '2026-03-01T00:00:00.000Z';
    const to = '2026-03-10T00:00:00.000Z';
    const wide = await cache.getDailyBars('SPY', from, to);
    assert.ok(wide.length > 0);

    // Every candidate in a scan asks for roughly this window; only the first
    // may reach the vendor.
    const narrow = await cache.getDailyBars('SPY', '2026-03-03T00:00:00.000Z', to);
    assert.equal(delegate.barCalls, 1);
    assert.ok(narrow.length < wide.length, 'the slice really is narrower');
    assert.ok(narrow.every((b) => b.at >= '2026-03-03T00:00:00.000Z'));
  });

  it('goes back to the vendor for a range wider than it holds', async () => {
    const clock = new FixedClock(NOW);
    const delegate = new CountingMarketData();
    const cache = caching(clock, delegate);

    await cache.getDailyBars('SPY', '2026-03-05T00:00:00.000Z', '2026-03-10T00:00:00.000Z');
    await cache.getDailyBars('SPY', '2026-02-01T00:00:00.000Z', '2026-03-10T00:00:00.000Z');
    assert.equal(delegate.barCalls, 2);
  });

  it('reports the underlying vendor, not itself', () => {
    const clock = new FixedClock(NOW);
    const cache = caching(clock, new CountingMarketData());
    // The startup banner and readiness both key off providerId; a wrapper that
    // renamed the provider would make both lie.
    assert.equal(cache.providerId, 'counting');
  });

  it('drops everything on clear, as the market open requires', async () => {
    const clock = new FixedClock(NOW);
    const delegate = new CountingMarketData();
    const cache = caching(clock, delegate);

    await cache.getQuote('NVDA');
    cache.clear();
    await cache.getQuote('NVDA');
    assert.equal(delegate.quoteCalls, 2);
  });
});

/* -------------------------------------------------------- operations */

describe('operations config', () => {
  it('defaults to a 2-minute X scan and a 1-minute position monitor', () => {
    assert.equal(DEFAULT_OPERATIONS.xScanIntervalSeconds, 120);
    assert.equal(DEFAULT_OPERATIONS.xEventWatchIntervalSeconds, 60);
    assert.equal(DEFAULT_OPERATIONS.positionMonitorIntervalSeconds, 60);
    assert.equal(DEFAULT_OPERATIONS.reconciliationIntervalSeconds, 180);
    assert.equal(DEFAULT_OPERATIONS.sameTickerCooldownMinutes, 30);
  });

  it('accepts explicit overrides', () => {
    const ops = loadOperations({ xScanIntervalSeconds: 300 });
    assert.equal(ops.xScanIntervalSeconds, 300);
    assert.equal(ops.positionMonitorIntervalSeconds, 60, 'unrelated cadences are untouched');
  });

  it('estimates a day of X requests that fits a normal plan', () => {
    const estimate = estimateDailyXRequests(DEFAULT_OPERATIONS, { queriesPerScan: 1, hoursActive: 6.5 });
    // 6.5 hours at 120s is ~195 scans; the event-watch fraction adds a little.
    assert.ok(estimate.requests > 150 && estimate.requests < 300, `unexpected estimate ${estimate.requests}`);
    assert.match(estimate.detail, /120s normal/);
  });

  it('scales the estimate with the cadence, not with wishes', () => {
    const slow = estimateDailyXRequests(loadOperations({ xScanIntervalSeconds: 240 }), {
      queriesPerScan: 1,
      hoursActive: 6.5,
    });
    const fast = estimateDailyXRequests(DEFAULT_OPERATIONS, { queriesPerScan: 1, hoursActive: 6.5 });
    assert.ok(slow.requests < fast.requests);
  });
});

/* -------------------------------------------------- configuration wiring */

describe('operational settings are actually wired', () => {
  it('honours the cold-start lookback rather than an internal default', async () => {
    const { createHarness } = await import('../fixtures/harness.js');
    const post = (minutesAgo: number) => ({
      postId: `age-${minutesAgo}`,
      handle: 'nvidia',
      displayName: 'NVIDIA',
      verified: true,
      followerCount: 3_000_000,
      text: 'NVIDIA raises guidance for the third quarter to $32.5B, up 24% sequentially. $NVDA',
      minutesAgo,
      likes: 2500,
      reposts: 800,
      baselineEngagement: 900,
    });

    // A setting that exists, is documented and is environment-overridable must
    // do something. This one was read by nothing: the real lookback was a
    // hard-coded 60 minutes, so NORTHSTAR_X_COLD_START_MINUTES was a lie.
    const wide = createHarness({ posts: [post(90)], operations: { xColdStartLookbackMinutes: 120 } });
    const wideResult = await wide.app.runner.runCycle();
    assert.equal(wideResult.ingested, 1, 'a 90-minute-old post is inside a 120-minute lookback');
    wide.close();

    const narrow = createHarness({ posts: [post(90)], operations: { xColdStartLookbackMinutes: 10 } });
    const narrowResult = await narrow.app.runner.runCycle();
    assert.equal(narrowResult.ingested, 0, 'and outside a 10-minute one');
    narrow.close();
  });

  it('uses the configured default cold-start window', async () => {
    const { createHarness } = await import('../fixtures/harness.js');
    const { DEFAULT_OPERATIONS: OPS } = await import('../../src/config/operations.js');
    const build = (minutesAgo: number) => ({
      postId: `d-${minutesAgo}`,
      handle: 'nvidia',
      displayName: 'NVIDIA',
      verified: true,
      followerCount: 3_000_000,
      text: 'NVIDIA raises guidance for the third quarter to $32.5B, up 24% sequentially. $NVDA',
      minutesAgo,
      likes: 2500,
      reposts: 800,
      baselineEngagement: 900,
    });

    const inside = createHarness({ posts: [build(OPS.xColdStartLookbackMinutes - 10)] });
    assert.equal((await inside.app.runner.runCycle()).ingested, 1);
    inside.close();

    const outside = createHarness({ posts: [build(OPS.xColdStartLookbackMinutes + 10)] });
    assert.equal((await outside.app.runner.runCycle()).ingested, 0);
    outside.close();
  });
});
