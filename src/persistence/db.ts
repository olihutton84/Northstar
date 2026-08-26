/**
 * SQLite persistence, using Node's built-in `node:sqlite` (Node >= 22.5).
 *
 * No external driver, no ORM: the schema is small, the queries are explicit,
 * and the decision log must survive a dependency-free environment.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_INDEXES_SQL, SCHEMA_PRAGMAS, SCHEMA_TABLES_SQL, SCHEMA_VERSION } from './schema.js';

export type Row = Record<string, unknown>;

/**
 * node:sqlite only binds null | number | bigint | string | Uint8Array.
 * `undefined` and booleans are common in domain objects, so normalise here
 * rather than at every call site (a missed conversion is a runtime throw).
 */
function normalise(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

export class Database {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON;');
  }

  /**
   * Bring the database to the current schema, whatever age it is.
   *
   * Three phases, and the ORDER is the whole point:
   *
   *   1. TABLES    `CREATE TABLE IF NOT EXISTS` — creates what is missing and
   *                leaves every existing table untouched, including tables
   *                missing columns that later versions added.
   *   2. MIGRATE   the forward steps that add those columns and reshape tables.
   *   3. INDEXES   created last, so an index can safely name a column that
   *                phase 2 has only just added.
   *
   * Phases 1 and 3 used to be one blob that ran BEFORE phase 2. That made the
   * bootstrap depend on a migration that had not run yet: upgrading a database
   * created before manual-X ingest died on
   * `CREATE INDEX ... ON social_events(source)`, and — because that statement
   * ran ahead of the migration adding `source` — `migrate` could not repair it
   * either. The database was stuck, and every command that opened it failed the
   * same way.
   *
   * The whole thing is one transaction, so a migration that fails half way
   * leaves the database exactly as it was rather than partly upgraded. The
   * recorded version moves inside that transaction too: a version claiming an
   * upgrade that did not finish is worse than no version at all.
   */
  migrate(): void {
    // Outside the transaction, and first: journal_mode cannot be set inside one
    // and foreign_keys is silently ignored inside one.
    this.raw.exec(SCHEMA_PRAGMAS);

    const before = this.schemaVersion();

    /*
     * Refuse to touch a database written by a NEWER build.
     *
     * Running old migrations over a newer schema is not an upgrade, it is
     * corruption with a success message. Stopping costs an operator one
     * confusing minute; the alternative costs them their ledger.
     */
    if (before !== null && before > SCHEMA_VERSION) {
      throw new Error(
        `This database is at schema v${before}, but this build only understands v${SCHEMA_VERSION}. ` +
        'It was written by a newer version of the bot. Update the code rather than downgrading the data.',
      );
    }

    this.transaction(() => {
      this.raw.exec(SCHEMA_TABLES_SQL);
      this.upgradeFrom(before);
      this.raw.exec(SCHEMA_INDEXES_SQL);
      this.raw
        .prepare(
          'INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('schema_version', String(SCHEMA_VERSION));
    });
  }

  /** The version recorded in the file, or null when the file is new. */
  private schemaVersion(): number | null {
    try {
      const row = this.raw
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get() as { value?: string } | undefined;
      return row?.value === undefined ? null : Number(row.value);
    } catch {
      // No schema_meta table: the database has not been created yet.
      return null;
    }
  }

  /**
   * Forward migrations for databases created by an earlier version.
   *
   * Each step is idempotent and additive. Nothing here deletes a row: an
   * existing run's ledger, orders and positions are carried into the new shape
   * rather than replaced, because they are the record of what actually traded.
   */
  private upgradeFrom(before: number | null): void {
    if (before === null) return; // fresh database; the table phase already built it

    if (before < 3) {
      /*
       * v3 introduces execution epochs.
       *
       * Capital moved out of the frozen strategy version and into an epoch, so
       * the ledger is now keyed by (strategy_id, epoch_id) rather than by
       * strategy alone. Everything already recorded belongs to the epoch that
       * produced it — the original $50 run — and is labelled as such rather
       * than being discarded or silently re-attributed to the new one.
       */
      const legacy = 'paper-50-v1';

      for (const [table, column] of [
        ['orders', 'epoch_id'],
        ['positions', 'epoch_id'],
        ['ledger_entries', 'epoch_id'],
      ] as const) {
        if (!this.hasColumn(table, column)) {
          this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
        }
        this.raw.exec(`UPDATE ${table} SET ${column} = '${legacy}' WHERE ${column} = ''`);
      }

      // SQLite cannot alter a primary key in place, so the ledger is rebuilt.
      if (!this.hasColumn('capital_ledger', 'epoch_id')) {
        this.raw.exec(`
          ALTER TABLE capital_ledger RENAME TO capital_ledger_v2;
          CREATE TABLE capital_ledger (
            strategy_id             TEXT NOT NULL,
            epoch_id                TEXT NOT NULL DEFAULT '',
            starting_capital_cents  INTEGER NOT NULL,
            cash_cents              INTEGER NOT NULL,
            reserved_cents          INTEGER NOT NULL DEFAULT 0,
            positions_value_cents   INTEGER NOT NULL DEFAULT 0,
            unrealised_pnl_cents    INTEGER NOT NULL DEFAULT 0,
            realised_pnl_cents      INTEGER NOT NULL DEFAULT 0,
            fees_paid_cents         INTEGER NOT NULL DEFAULT 0,
            equity_cents            INTEGER NOT NULL,
            high_water_equity_cents INTEGER NOT NULL,
            updated_at              TEXT NOT NULL,
            PRIMARY KEY (strategy_id, epoch_id)
          );
          INSERT INTO capital_ledger
            SELECT strategy_id, '${legacy}', starting_capital_cents, cash_cents,
                   reserved_cents, positions_value_cents, unrealised_pnl_cents,
                   realised_pnl_cents, fees_paid_cents, equity_cents,
                   high_water_equity_cents, updated_at
            FROM capital_ledger_v2;
          DROP TABLE capital_ledger_v2;
        `);
      }
    }

    if (before < 4) {
      /*
       * v4 adds provenance to social events.
       *
       * Everything already stored came from the vendor API or a fixture, and
       * the column default says so. Backfilling it as manual would be a lie
       * about where the evidence for those trades came from.
       */
      for (const [column, fallback] of [
        ['source', 'X_API'],
        ['provenance', 'VENDOR_API'],
      ] as const) {
        if (!this.hasColumn('social_events', column)) {
          this.raw.exec(
            `ALTER TABLE social_events ADD COLUMN ${column} TEXT NOT NULL DEFAULT '${fallback}'`);
        }
      }
    }

    if (before < 5) {
      /*
       * v5 records WHY an incident was closed.
       *
       * Existing rows get an empty note rather than an invented one: nobody
       * wrote a reason at the time, and pretending otherwise would put words in
       * an operator's mouth in the audit trail.
       */
      if (!this.hasColumn('health_incidents', 'resolution_note')) {
        this.raw.exec("ALTER TABLE health_incidents ADD COLUMN resolution_note TEXT NOT NULL DEFAULT ''");
      }
    }
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.raw.prepare(`PRAGMA table_info(${table})`).all() as { name?: string }[];
    return rows.some((r) => r.name === column);
  }

  run(sql: string, ...params: unknown[]): void {
    this.raw.prepare(sql).run(...(normalise(params) as never[]));
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...(normalise(params) as never[])) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...(normalise(params) as never[])) as T[];
  }

  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (e) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        /* rollback of an already-closed transaction is not itself an error */
      }
      throw e;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export function openDatabase(path: string): Database {
  const db = new Database(path);
  db.migrate();
  return db;
}

/* ------------------------------------------------------------- helpers */

export function jsonParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function boolToInt(b: boolean): number {
  return b ? 1 : 0;
}

export function intToBool(v: unknown): boolean {
  return v === 1 || v === true || v === '1';
}

export function nullableBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  return intToBool(v);
}

export function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}
