/**
 * The universe contract.
 *
 * The bot does not own portfolio, research or watchlist membership — the
 * Northstar Platform does. These tests hold the boundary: a valid snapshot is
 * adopted, a missing one falls back honestly, and a malformed one is refused
 * whole rather than partially applied.
 *
 * The failure this suite exists to prevent is silent: a universe that is
 * quietly narrower or wider than intended changes what the strategy may trade
 * without anything looking wrong.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NullLogger } from '../../src/core/index.js';
import {
  parseUniverseSnapshot,
  snapshotToSecurities,
  universeFingerprint,
  UNIVERSE_SOURCES,
} from '../../src/universe/contract.js';
import { fileUniverseSource, loadUniverse, loadFallbackUniverse } from '../../src/universe/load.js';
import { FALLBACK_UNIVERSE_ID, UNIVERSE_FALLBACK_SEED } from '../../src/universe/seed.js';
import { X_SIGNAL_V1 } from '../../src/config/strategyRegistry.js';

const VALID = {
  version: 'platform-2026-08-26-a',
  generatedAt: '2026-08-26T06:00:00.000Z',
  securities: [
    {
      ticker: 'NVDA',
      companyName: 'NVIDIA Corporation',
      aliases: ['Nvidia', 'NVIDIA'],
      exchange: 'NASDAQ',
      sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_PORTFOLIO'],
    },
    {
      ticker: 'SPY',
      companyName: 'SPDR S&P 500 ETF Trust',
      exchange: 'NYSE',
      sources: ['ALPACA_US_EQUITY', 'TRADING_LAB_UNIVERSE'],
    },
  ],
};

function tempFile(contents: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'northstar-universe-'));
  const path = join(dir, 'universe.json');
  writeFileSync(path, contents, 'utf8');
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/* --------------------------------------------------------------- parsing */

describe('universe snapshot parsing', () => {
  it('accepts a well-formed platform snapshot', () => {
    const result = parseUniverseSnapshot(VALID);
    assert.equal(result.ok, true, result.problems.join('; '));
    assert.equal(result.snapshot!.version, 'platform-2026-08-26-a');
    assert.equal(result.snapshot!.securities.length, 2);
  });

  it('derives a security id when the platform omits one, matching stored ids', () => {
    const securities = snapshotToSecurities(parseUniverseSnapshot(VALID).snapshot!);
    // Positions and orders reference securityId; a different derivation here
    // would orphan everything already stored.
    assert.equal(securities[0]!.securityId, 'sec_NVDA');
  });

  it('honours an explicit security id', () => {
    const snapshot = parseUniverseSnapshot({
      ...VALID,
      securities: [{ ...VALID.securities[0]!, securityId: 'sec_CUSTOM' }],
    }).snapshot!;
    assert.equal(snapshotToSecurities(snapshot)[0]!.securityId, 'sec_CUSTOM');
  });

  const rejections: { name: string; payload: unknown; expect: RegExp }[] = [
    { name: 'not an object', payload: 'nope', expect: /must be a JSON object/ },
    { name: 'missing version', payload: { ...VALID, version: '' }, expect: /`version` is required/ },
    { name: 'missing generatedAt', payload: { ...VALID, generatedAt: undefined }, expect: /`generatedAt` is required/ },
    { name: 'unparsable generatedAt', payload: { ...VALID, generatedAt: 'last tuesday' }, expect: /not a parsable timestamp/ },
    { name: 'securities not an array', payload: { ...VALID, securities: {} }, expect: /must be an array/ },
    { name: 'empty securities', payload: { ...VALID, securities: [] }, expect: /empty/ },
    {
      name: 'missing companyName',
      payload: { ...VALID, securities: [{ ticker: 'NVDA', sources: ['ALPACA_US_EQUITY'] }] },
      expect: /companyName is required/,
    },
    {
      name: 'no sources',
      payload: { ...VALID, securities: [{ ticker: 'NVDA', companyName: 'NVIDIA', sources: [] }] },
      expect: /sources is required/,
    },
    {
      name: 'unrecognised source',
      payload: { ...VALID, securities: [{ ticker: 'NVDA', companyName: 'NVIDIA', sources: ['NORTHSTAR_MYSTERY'] }] },
      expect: /unrecognised source/,
    },
    {
      name: 'implausible ticker',
      payload: { ...VALID, securities: [{ ticker: 'not a ticker!', companyName: 'X', sources: ['ALPACA_US_EQUITY'] }] },
      expect: /not a plausible US equity symbol/,
    },
    {
      name: 'duplicate ticker',
      payload: {
        ...VALID,
        securities: [
          { ticker: 'NVDA', companyName: 'NVIDIA', sources: ['ALPACA_US_EQUITY'] },
          { ticker: 'NVDA', companyName: 'Impostor', sources: ['ALPACA_US_EQUITY'] },
        ],
      },
      expect: /appears more than once/,
    },
    {
      name: 'non-boolean flag',
      payload: {
        ...VALID,
        securities: [{ ticker: 'NVDA', companyName: 'NVIDIA', sources: ['ALPACA_US_EQUITY'], alpacaTradable: 'yes' }],
      },
      expect: /must be a boolean/,
    },
  ];

  for (const c of rejections) {
    it(`rejects: ${c.name}`, () => {
      const result = parseUniverseSnapshot(c.payload);
      assert.equal(result.ok, false, `expected rejection for ${c.name}`);
      assert.equal(result.snapshot, null, 'a rejected snapshot must yield nothing at all');
      assert.ok(
        result.problems.some((p) => c.expect.test(p)),
        `expected a problem matching ${c.expect}, got: ${result.problems.join(' | ')}`,
      );
    });
  }

  it('reports every problem, not merely the first', () => {
    const result = parseUniverseSnapshot({
      version: '',
      generatedAt: 'nonsense',
      securities: [{ ticker: 'NVDA', sources: [] }],
    });
    assert.equal(result.ok, false);
    assert.ok(result.problems.length >= 3, `expected several problems, got ${result.problems.length}`);
  });

  it('never partially ingests a snapshot with one bad entry', () => {
    const result = parseUniverseSnapshot({
      ...VALID,
      securities: [VALID.securities[0]!, { ticker: 'MSFT', sources: ['ALPACA_US_EQUITY'] }],
    });
    // The good entry must NOT survive. A universe that quietly loses or keeps
    // one name changes what the strategy may trade.
    assert.equal(result.ok, false);
    assert.equal(result.snapshot, null);
  });
});

/* ----------------------------------------------------------- fingerprint */

describe('universe fingerprint', () => {
  it('is stable across reordering', () => {
    const a = snapshotToSecurities(parseUniverseSnapshot(VALID).snapshot!);
    const reversed = snapshotToSecurities(
      parseUniverseSnapshot({ ...VALID, securities: [...VALID.securities].reverse() }).snapshot!,
    );
    assert.equal(universeFingerprint(a), universeFingerprint(reversed));
  });

  it('changes when membership changes', () => {
    const a = snapshotToSecurities(parseUniverseSnapshot(VALID).snapshot!);
    const b = snapshotToSecurities(
      parseUniverseSnapshot({
        ...VALID,
        securities: [{ ...VALID.securities[0]!, sources: ['ALPACA_US_EQUITY'] }, VALID.securities[1]!],
      }).snapshot!,
    );
    assert.notEqual(universeFingerprint(a), universeFingerprint(b), 'dropping a source must change the fingerprint');
  });

  it('ignores cosmetic changes that cannot affect eligibility', () => {
    const a = snapshotToSecurities(parseUniverseSnapshot(VALID).snapshot!);
    const renamed = snapshotToSecurities(
      parseUniverseSnapshot({
        ...VALID,
        securities: [{ ...VALID.securities[0]!, companyName: 'NVIDIA Corp.' }, VALID.securities[1]!],
      }).snapshot!,
    );
    assert.equal(universeFingerprint(a), universeFingerprint(renamed));
  });
});

/* --------------------------------------------------------------- loading */

describe('universe loading and provider priority', () => {
  it('uses the platform universe when a valid one is supplied', () => {
    const f = tempFile(JSON.stringify(VALID));
    const loaded = loadUniverse(fileUniverseSource(f.path), new NullLogger());

    assert.equal(loaded.provenance.origin, 'PLATFORM');
    assert.equal(loaded.provenance.version, 'platform-2026-08-26-a');
    assert.equal(loaded.securities.length, 2);
    assert.equal(loaded.provenance.rejection, null);
    assert.match(loaded.provenance.label, /^PLATFORM/);
    f.cleanup();
  });

  it('falls back when no platform universe is configured', () => {
    const loaded = loadUniverse(null, new NullLogger());

    assert.equal(loaded.provenance.origin, 'BOT_FALLBACK');
    assert.equal(loaded.provenance.version, FALLBACK_UNIVERSE_ID);
    assert.equal(loaded.securities.length, UNIVERSE_FALLBACK_SEED.length);
    assert.match(loaded.provenance.label, /BOT FALLBACK/);
    // The label must never read as platform state.
    assert.ok(!loaded.provenance.label.includes('PLATFORM ('));
  });

  it('falls back when the file does not exist, recording why', () => {
    const loaded = loadUniverse(fileUniverseSource('/nonexistent/universe.json'), new NullLogger());

    assert.equal(loaded.provenance.origin, 'BOT_FALLBACK');
    assert.ok(loaded.provenance.rejection, 'the failure must be recorded, not swallowed');
    assert.match(loaded.provenance.rejection!.problems.join(' '), /Could not read/);
  });

  it('falls back when the file is not JSON at all', () => {
    const f = tempFile('this is not json');
    const loaded = loadUniverse(fileUniverseSource(f.path), new NullLogger());

    assert.equal(loaded.provenance.origin, 'BOT_FALLBACK');
    assert.ok(loaded.provenance.rejection);
    f.cleanup();
  });

  it('rejects a malformed snapshot whole and keeps the fallback intact', () => {
    const f = tempFile(
      JSON.stringify({
        ...VALID,
        securities: [VALID.securities[0]!, { ticker: 'MSFT', sources: ['ALPACA_US_EQUITY'] }],
      }),
    );
    const loaded = loadUniverse(fileUniverseSource(f.path), new NullLogger());

    assert.equal(loaded.provenance.origin, 'BOT_FALLBACK');
    assert.equal(loaded.securities.length, UNIVERSE_FALLBACK_SEED.length, 'the fallback must be whole');
    // Not one entry of the corrupt snapshot may leak through.
    assert.equal(loaded.securities.filter((s) => s.ticker === 'NVDA').length, 1);
    assert.ok(loaded.provenance.rejection!.problems.some((p) => /companyName is required/.test(p)));
    assert.match(loaded.provenance.label, /rejected/);
    f.cleanup();
  });

  it('gives the fallback a fingerprint too, so any session is reconstructable', () => {
    const fallback = loadFallbackUniverse();
    assert.match(fallback.provenance.fingerprint, /^[0-9a-f]{16}$/);
    assert.equal(fallback.provenance.fingerprint, universeFingerprint(fallback.securities));
  });
});

/* ---------------------------------------------------- the frozen contract */

describe('the source vocabulary is the integration contract', () => {
  it('recognises exactly the sources the frozen strategy declares', () => {
    for (const source of X_SIGNAL_V1.universeSources) {
      assert.ok(
        UNIVERSE_SOURCES.includes(source),
        `x-signal-v1 declares ${source} but the contract does not recognise it`,
      );
    }
  });

  it('keeps the fallback tagged with the sources the strategy trades on', () => {
    // If the fallback stopped carrying these tags, the strategy would become
    // ineligible to trade anything while looking perfectly healthy.
    const tagged = new Set(UNIVERSE_FALLBACK_SEED.flatMap((e) => e.sources));
    assert.ok(tagged.has('ALPACA_US_EQUITY'));
    assert.ok([...tagged].some((s) => X_SIGNAL_V1.universeSources.includes(s)));
  });
});

/* ------------------------------------------- provenance through the app */

describe('the running bot reports which universe it is on', () => {
  it('labels a platform universe as PLATFORM, end to end', async () => {
    const { createHarness } = await import('../fixtures/harness.js');
    const f = tempFile(JSON.stringify(VALID));
    const h = createHarness({ posts: [], universeSource: fileUniverseSource(f.path) });

    const providers = h.app.describeProviders();
    assert.equal(providers.universe.origin, 'PLATFORM');
    assert.equal(providers.universe.version, 'platform-2026-08-26-a');
    assert.equal(h.app.universe.all().length, 2, 'the platform list replaces the fallback entirely');

    h.close();
    f.cleanup();
  });

  it('labels the fallback as BOT_FALLBACK and never as platform state', async () => {
    const { createHarness } = await import('../fixtures/harness.js');
    const h = createHarness({ posts: [] });

    const universe = h.app.describeProviders().universe;
    assert.equal(universe.origin, 'BOT_FALLBACK');
    assert.equal(universe.version, FALLBACK_UNIVERSE_ID);
    assert.ok(!/^PLATFORM/.test(universe.label));
    h.close();
  });

  it('stores the universe version and fingerprint with the session', async () => {
    const { createHarness } = await import('../fixtures/harness.js');
    const f = tempFile(JSON.stringify(VALID));
    const h = createHarness({ posts: [], universeSource: fileUniverseSource(f.path) });

    h.app.recordRunConfiguration('test');
    const row = h.app.store.log
      .byStage(h.app.spec.strategyId, 'SYSTEM', 10)
      .find((e) => (e.payload as Record<string, unknown>)['universe'] !== undefined);

    assert.ok(row, 'the session record must carry the universe it traded against');
    const universe = (row!.payload as Record<string, unknown>)['universe'] as Record<string, unknown>;
    assert.equal(universe['origin'], 'PLATFORM');
    assert.equal(universe['version'], 'platform-2026-08-26-a');
    assert.equal(universe['fingerprint'], universeFingerprint(h.app.universe.all()));
    assert.equal(universe['securityCount'], 2);

    h.close();
    f.cleanup();
  });

  it('records a rejection in the session, so a fallback day is explainable', async () => {
    const { createHarness } = await import('../fixtures/harness.js');
    const f = tempFile(JSON.stringify({ ...VALID, securities: [{ ticker: 'MSFT', sources: [] }] }));
    const h = createHarness({ posts: [], universeSource: fileUniverseSource(f.path) });

    h.app.recordRunConfiguration('test');
    const row = h.app.store.log
      .byStage(h.app.spec.strategyId, 'SYSTEM', 10)
      .find((e) => (e.payload as Record<string, unknown>)['universe'] !== undefined)!;
    const universe = (row.payload as Record<string, unknown>)['universe'] as Record<string, unknown>;

    assert.equal(universe['origin'], 'BOT_FALLBACK');
    assert.ok(universe['rejection'], 'the reason the platform universe was refused must survive');

    h.close();
    f.cleanup();
  });

  it('does not change x-signal-v1 scoring, whichever universe is active', async () => {
    const { createHarness, bullishTier1Post, corroboratingTier2Post } = await import('../fixtures/harness.js');

    // The same evidence about the same security must score identically whether
    // that security arrived via the platform or via the fallback.
    const onlyNvda = {
      version: 'platform-nvda-only',
      generatedAt: '2026-08-26T06:00:00.000Z',
      securities: [
        {
          ticker: 'NVDA',
          companyName: 'NVIDIA Corporation',
          aliases: ['Nvidia', 'NVIDIA'],
          exchange: 'NASDAQ',
          sources: ['ALPACA_US_EQUITY', 'NORTHSTAR_PORTFOLIO'],
        },
        { ticker: 'SPY', companyName: 'SPDR S&P 500 ETF Trust', exchange: 'NYSE', sources: ['ALPACA_US_EQUITY'] },
      ],
    };

    const fallback = createHarness({ posts: [bullishTier1Post(), corroboratingTier2Post()] });
    await fallback.app.runner.runCycle();
    const a = fallback.app.store.signals.recent(1)[0]!;
    fallback.close();

    const f = tempFile(JSON.stringify(onlyNvda));
    const platform = createHarness({
      posts: [bullishTier1Post(), corroboratingTier2Post()],
      universeSource: fileUniverseSource(f.path),
    });
    await platform.app.runner.runCycle();
    const b = platform.app.store.signals.recent(1)[0]!;
    platform.close();
    f.cleanup();

    assert.equal(b.score, a.score, 'the universe decides eligibility, never the score');
    assert.deepEqual(b.components, a.components);
    assert.equal(b.uncertainty, a.uncertainty);
  });
});
