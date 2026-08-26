/**
 * Upgrading a database that already has a trading history.
 *
 * A migration bug is not like other bugs. There is one copy of the ledger, it
 * is the record of what actually happened, and the operator finds out it is
 * wrong only after they have run the upgrade. So this suite starts from a
 * database built by the OLD code — schema v2, the last canonical `main` before
 * execution epochs and manual-X ingest — fills it with the kinds of rows a real
 * run leaves behind, and proves every one of them survives.
 *
 * The specific defect that prompted it: the schema blob created its indexes in
 * the same pass as its tables, and ran BEFORE the migrations. An index naming a
 * column that a migration adds therefore could not be created — and because it
 * ran first, it also stopped the migration that would have added the column.
 * The database was stuck, `migrate` could not repair it, and every command that
 * opened it failed with `no such column: source`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../../src/persistence/db.js';
import { SCHEMA_VERSION } from '../../src/persistence/schema.js';
import { SCHEMA_V2_SQL, SCHEMA_V2_VERSION } from '../fixtures/schemaV2.js';
import { ACTIVE_EPOCH, EPOCH_PAPER_50 } from '../../src/config/executionEpochs.js';
import { X_SIGNAL_V1_FINGERPRINT, fingerprintVersion, X_SIGNAL_V1 } from '../../src/config/strategyRegistry.js';

/* ------------------------------------------------------- the old database */

/** Rows a real pre-upgrade run would have left behind. */
const HISTORY = {
  strategy: `INSERT INTO strategies (strategy_id, display_name, version, status, run_state, mode,
      created_at, updated_at, allocated_capital_cents, benchmark_ticker, universe_sources_json,
      risk_limits_json, signal_config_id, description, halt_reason, halted_at)
    VALUES ('x-signal-v1','X Signal','1.0.0','TESTING','RUNNING','PAPER','2026-01-01T00:00:00Z',
      '2026-01-01T00:00:00Z',5000,'SPY','["ALPACA_US_EQUITY"]','{"maxPositionPctOfEquity":20}',
      'x-signal-config-v1','the original $50 run',NULL,NULL)`,

  ledger: `INSERT INTO capital_ledger (strategy_id, starting_capital_cents, cash_cents, reserved_cents,
      positions_value_cents, unrealised_pnl_cents, realised_pnl_cents, fees_paid_cents, equity_cents,
      high_water_equity_cents, updated_at)
    VALUES ('x-signal-v1',5000,4166,0,834,0,-17,3,4983,5000,'2026-02-01T00:00:00Z')`,

  event: `INSERT INTO social_events (event_id, platform, post_id, author_id, author_handle,
      author_display_name, source_class, source_tier, posted_at, captured_at, text, url, kind,
      mentioned_cashtags_json, mentioned_companies_json, resolved_security_ids_json, engagement_json,
      ingest_batch_id)
    VALUES ('evt-hist','X','111','a1','nvidia','NVIDIA','COMPANY_OFFICIAL','TIER_1',
      '2026-02-01T14:00:00Z','2026-02-01T14:01:00Z','historic post $NVDA',
      'https://x.com/nvidia/status/111','ORIGINAL','["NVDA"]','[]','["sec_NVDA"]','{"likes":10}','batch-hist')`,

  signal: `INSERT INTO signals (signal_id, strategy_id, strategy_version, security_id, ticker, score,
      band, uncertainty, generated_at, components_json, contributions_json, signal_config_id,
      triggering_event_ids_json, evidence_json, supporting_evidence_json, contradictory_evidence_json,
      dominant_event_type, price_confirmation_json, explanation, source_count,
      independent_source_count, resolution_confidence)
    VALUES ('sig-hist','x-signal-v1','1.0.0','sec_NVDA','NVDA',72,'STRONG_BULLISH',0.2,
      '2026-02-01T14:02:00Z','{"sentiment":80}','{}','x-signal-config-v1','["evt-hist"]','{}','[]','[]',
      'GUIDANCE',NULL,'the explanation that produced a real trade',2,2,0.95)`,

  proposal: `INSERT INTO trade_proposals (proposal_id, strategy_id, strategy_version, signal_id,
      security_id, ticker, direction, side, proposed_capital_cents, proposed_quantity, fractional,
      reference_price, reference_price_as_of, confidence, rationale, evidence_summary_json, created_at,
      expires_at, status, mode, risk_decision_id, invalidation_condition_json, approval_fingerprint,
      correlation_id)
    VALUES ('prop-hist','x-signal-v1','1.0.0','sig-hist','sec_NVDA','NVDA','BULLISH','BUY',834,0.0695,1,
      120,'2026-02-01T14:03:00Z',0.8,'historic rationale','{}','2026-02-01T14:03:00Z',
      '2026-02-01T14:18:00Z','FILLED','PAPER',NULL,'{}','fp-hist','corr-hist')`,

  order: `INSERT INTO orders (order_id, broker_order_id, strategy_id, proposal_id, position_id,
      security_id, ticker, side, quantity, notional_cents, type, time_in_force, mode, status,
      submitted_at, updated_at, filled_quantity, filled_avg_price, client_order_id, reject_reason,
      intent, correlation_id)
    VALUES ('ord-hist','brk-1','x-signal-v1','prop-hist','pos-hist','sec_NVDA','NVDA','BUY',0.0695,834,
      'MARKET','DAY','PAPER','FILLED','2026-02-01T14:04:00Z','2026-02-01T14:04:30Z',0.0695,120,
      'cli-hist',NULL,'ENTRY','corr-hist')`,
};

const LEDGER_ENTRIES = [
  ['led-1', 'ALLOCATION', 5000, 5000, '2026-01-01T00:00:00Z'],
  ['led-2', 'RESERVE', -834, 4166, '2026-02-01T14:03:00Z'],
  ['led-3', 'BUY', -834, 4166, '2026-02-01T14:04:00Z'],
] as const;

/** Build a database exactly as the pre-epoch, pre-manual-X code left one. */
function buildOldDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_V2_SQL);
  db.prepare(
    'INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('schema_version', String(SCHEMA_V2_VERSION));

  for (const sql of Object.values(HISTORY)) db.exec(sql);
  for (const [id, kind, amount, after, at] of LEDGER_ENTRIES) {
    db.prepare(
      `INSERT INTO ledger_entries (entry_id, strategy_id, at, kind, amount_cents, cash_after_cents,
         reference, note) VALUES (?, 'x-signal-v1', ?, ?, ?, ?, 'ref', 'historic')`,
    ).run(id, at, kind, amount, after);
  }
  db.close();
}

function withOldDatabase<T>(fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'northstar-upgrade-'));
  const path = join(dir, 'northstar.sqlite');
  try {
    buildOldDatabase(path);
    return fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The async twin.
 *
 * Deliberately separate rather than making the above generic over promises: a
 * `finally` in a synchronous helper fires the instant an async callback returns
 * its promise, deleting the database while the test is still using it — and
 * SQLite then quietly creates a fresh empty one, so the test fails claiming the
 * history vanished. It is a confusing way to lose an hour.
 */
async function withOldDatabaseAsync<T>(fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'northstar-upgrade-'));
  const path = join(dir, 'northstar.sqlite');
  try {
    buildOldDatabase(path);
    return await fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Read straight from SQLite, bypassing the app's repositories entirely. */
function inspect<T>(path: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const count = (db: DatabaseSync, table: string): number =>
  Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

const columns = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

/* ============================================== 1. the defect itself ====== */

describe('an old database can be upgraded at all', () => {
  it('starts from a genuine v2 database that lacks the new columns', () => {
    withOldDatabase((path) => {
      inspect(path, (db) => {
        assert.equal(
          (db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value,
          '2',
        );
        assert.ok(!columns(db, 'social_events').includes('source'), 'precondition: no source column');
        assert.ok(!columns(db, 'capital_ledger').includes('epoch_id'), 'precondition: no epoch_id column');
      });
    });
  });

  it('migrates without throwing — the bug was that this could not run at all', () => {
    withOldDatabase((path) => {
      // Before the fix this threw `no such column: source`, from an index that
      // was created before the migration that adds the column.
      assert.doesNotThrow(() => {
        const db = openDatabase(path);
        db.close();
      });
    });
  });

  it('reaches the current schema version', () => {
    withOldDatabase((path) => {
      openDatabase(path).close();
      inspect(path, (db) => {
        assert.equal(
          Number((db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value),
          SCHEMA_VERSION,
        );
      });
    });
  });
});

/* ======================================== 2. nothing historical is lost === */

describe('every historical row survives the upgrade', () => {
  it('keeps the row counts identical', () => {
    withOldDatabase((path) => {
      const before = inspect(path, (db) => ({
        strategies: count(db, 'strategies'),
        ledger: count(db, 'capital_ledger'),
        entries: count(db, 'ledger_entries'),
        events: count(db, 'social_events'),
        signals: count(db, 'signals'),
        proposals: count(db, 'trade_proposals'),
        orders: count(db, 'orders'),
      }));

      openDatabase(path).close();

      const after = inspect(path, (db) => ({
        strategies: count(db, 'strategies'),
        ledger: count(db, 'capital_ledger'),
        entries: count(db, 'ledger_entries'),
        events: count(db, 'social_events'),
        signals: count(db, 'signals'),
        proposals: count(db, 'trade_proposals'),
        orders: count(db, 'orders'),
      }));

      assert.deepEqual(after, before, 'migration must not add or remove a single row');
    });
  });

  it('keeps the CONTENT of each row, not merely the count', () => {
    withOldDatabase((path) => {
      openDatabase(path).close();
      inspect(path, (db) => {
        const signal = db.prepare("SELECT * FROM signals WHERE signal_id = 'sig-hist'").get() as Record<string, unknown>;
        assert.equal(signal['score'], 72);
        assert.equal(signal['band'], 'STRONG_BULLISH');
        assert.equal(signal['explanation'], 'the explanation that produced a real trade');
        assert.equal(signal['triggering_event_ids_json'], '["evt-hist"]');

        const proposal = db.prepare("SELECT * FROM trade_proposals WHERE proposal_id = 'prop-hist'").get() as Record<string, unknown>;
        assert.equal(proposal['proposed_capital_cents'], 834);
        assert.equal(proposal['status'], 'FILLED');

        const order = db.prepare("SELECT * FROM orders WHERE order_id = 'ord-hist'").get() as Record<string, unknown>;
        assert.equal(order['filled_quantity'], 0.0695);
        assert.equal(order['broker_order_id'], 'brk-1', 'the broker order id is the audit link to Alpaca');

        const event = db.prepare("SELECT * FROM social_events WHERE event_id = 'evt-hist'").get() as Record<string, unknown>;
        assert.equal(event['url'], 'https://x.com/nvidia/status/111');
      });
    });
  });

  it('keeps the $50 ledger exactly as it was traded', () => {
    withOldDatabase((path) => {
      openDatabase(path).close();
      inspect(path, (db) => {
        const ledgers = db.prepare('SELECT * FROM capital_ledger').all() as Record<string, unknown>[];
        assert.equal(ledgers.length, 1, 'migration must not invent a second ledger');
        const l = ledgers[0]!;
        assert.equal(l['starting_capital_cents'], 5000);
        assert.equal(l['cash_cents'], 4166);
        assert.equal(l['realised_pnl_cents'], -17);
        assert.equal(l['fees_paid_cents'], 3);
        // Moved into the epoch that produced it, not the new one.
        assert.equal(l['epoch_id'], EPOCH_PAPER_50.epochId);
      });
    });
  });

  it('attributes historical events to the API, never backfilled as manual', () => {
    withOldDatabase((path) => {
      openDatabase(path).close();
      inspect(path, (db) => {
        const event = db.prepare("SELECT * FROM social_events WHERE event_id = 'evt-hist'").get() as Record<string, unknown>;
        assert.equal(event['source'], 'X_API');
        assert.equal(event['provenance'], 'VENDOR_API');
      });
    });
  });

  it('tags historical ledger entries and orders with the epoch that produced them', () => {
    withOldDatabase((path) => {
      openDatabase(path).close();
      inspect(path, (db) => {
        // Mapped to plain objects first: node:sqlite hands back null-prototype
        // rows, which deepEqual refuses to match against object literals.
        const byEpoch = (db.prepare('SELECT epoch_id, COUNT(*) AS n FROM ledger_entries GROUP BY epoch_id')
          .all() as { epoch_id: string; n: number }[])
          .map((r) => ({ epochId: r.epoch_id, n: Number(r.n) }));
        assert.deepEqual(byEpoch, [{ epochId: EPOCH_PAPER_50.epochId, n: LEDGER_ENTRIES.length }]);

        const order = db.prepare("SELECT epoch_id FROM orders WHERE order_id = 'ord-hist'").get() as { epoch_id: string };
        assert.equal(order.epoch_id, EPOCH_PAPER_50.epochId);
      });
    });
  });
});

/* ================================================ 3. the new schema ======= */

describe('the new schema is fully present after the upgrade', () => {
  it('adds every manual-X and epoch structure', () => {
    withOldDatabase((path) => {
      openDatabase(path).close();
      inspect(path, (db) => {
        for (const table of ['manual_observations', 'manual_ingest_windows', 'execution_epochs']) {
          assert.equal(count(db, table), 0, `${table} must exist and be empty`);
        }
        assert.ok(columns(db, 'social_events').includes('source'));
        assert.ok(columns(db, 'social_events').includes('provenance'));
        assert.ok(columns(db, 'capital_ledger').includes('epoch_id'));
        assert.ok(columns(db, 'orders').includes('epoch_id'));
        assert.ok(columns(db, 'positions').includes('epoch_id'));
      });
    });
  });

  it('creates the index that used to break the upgrade', () => {
    withOldDatabase((path) => {
      openDatabase(path).close();
      inspect(path, (db) => {
        const n = Number((db.prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_source'",
        ).get() as { n: number }).n);
        assert.equal(n, 1, 'the index must exist once the column it names does');
      });
    });
  });

  it('rebuilds the ledger primary key so an epoch cannot overwrite the one before it', () => {
    withOldDatabase((path) => {
      openDatabase(path).close();
      inspect(path, (db) => {
        const pk = (db.prepare('PRAGMA table_info(capital_ledger)').all() as { name: string; pk: number }[])
          .filter((c) => c.pk > 0)
          .sort((a, b) => a.pk - b.pk)
          .map((c) => c.name);
        assert.deepEqual(pk, ['strategy_id', 'epoch_id']);
      });
    });
  });
});

/* ==================================================== 4. idempotence ====== */

describe('running the migration twice', () => {
  it('is a no-op the second time', () => {
    withOldDatabase((path) => {
      openDatabase(path).close();
      const snapshot = (p: string): string => inspect(p, (db) => JSON.stringify({
        ledgers: db.prepare('SELECT * FROM capital_ledger ORDER BY epoch_id').all(),
        entries: db.prepare('SELECT * FROM ledger_entries ORDER BY entry_id').all(),
        signals: db.prepare('SELECT * FROM signals ORDER BY signal_id').all(),
        orders: db.prepare('SELECT * FROM orders ORDER BY order_id').all(),
      }));
      const first = snapshot(path);

      openDatabase(path).close();
      const second = snapshot(path);

      assert.equal(second, first, 'a second migration must change nothing at all');
    });
  });

  it('survives being run many times', () => {
    withOldDatabase((path) => {
      for (let i = 0; i < 5; i += 1) openDatabase(path).close();
      inspect(path, (db) => {
        assert.equal(count(db, 'capital_ledger'), 1);
        assert.equal(count(db, 'ledger_entries'), LEDGER_ENTRIES.length);
        assert.equal(count(db, 'signals'), 1);
      });
    });
  });
});

/* ============================================ 5. the app works after ====== */

describe('the application works against an upgraded database', () => {
  it('opens, reads the manual-X window and reports it closed', async () => {
    await withOldDatabaseAsync(async (path) => {
      const { NorthstarApp } = await import('../../src/app.js');
      const { FixedClock, NullLogger } = await import('../../src/core/index.js');
      const { testEnv, TEST_NOW } = await import('../fixtures/harness.js');

      // This is `manual status` in all but name: it was the command that failed.
      const app = new NorthstarApp({
        env: testEnv({ databasePath: path }),
        clock: new FixedClock(TEST_NOW),
        logger: new NullLogger(),
        databasePath: path,
        mode: 'PAPER',
      });

      const window = app.manualWindow();
      assert.equal(window.active, false);
      assert.equal(app.manualIngestPermission().permitted, false);

      // And the historical signal is still readable through the repositories.
      assert.equal(app.store.signals.byId('sig-hist')?.score, 72);
      app.close();
    });
  });

  it('leaves x-signal-v1 frozen and LIVE disabled', () => {
    assert.equal(fingerprintVersion(X_SIGNAL_V1), X_SIGNAL_V1_FINGERPRINT);
    assert.equal(ACTIVE_EPOCH.capitalCents, 100_000);
  });
});

/* ================================================== 6. fresh databases === */

describe('creating a database from nothing still works', () => {
  it('builds the complete current schema in one pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'northstar-fresh-'));
    const path = join(dir, 'fresh.sqlite');
    try {
      openDatabase(path).close();
      inspect(path, (db) => {
        assert.equal(
          Number((db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value),
          SCHEMA_VERSION,
        );
        assert.ok(columns(db, 'social_events').includes('source'));
        assert.ok(columns(db, 'capital_ledger').includes('epoch_id'));
        assert.equal(count(db, 'manual_observations'), 0);
        const idx = Number((db.prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_source'",
        ).get() as { n: number }).n);
        assert.equal(idx, 1);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a database written by a NEWER build rather than corrupting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'northstar-future-'));
    const path = join(dir, 'future.sqlite');
    try {
      openDatabase(path).close();
      const db = new DatabaseSync(path);
      db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 5));
      db.close();

      assert.throws(() => openDatabase(path), /newer version/i,
        'running old migrations over a newer schema is corruption, not an upgrade');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
