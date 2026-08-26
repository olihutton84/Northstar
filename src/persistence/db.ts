/**
 * SQLite persistence, using Node's built-in `node:sqlite` (Node >= 22.5).
 *
 * No external driver, no ORM: the schema is small, the queries are explicit,
 * and the decision log must survive a dependency-free environment.
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

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

  migrate(): void {
    // Schema first, so a fresh database is complete before anything reads it.
    // An EXISTING database is not touched by CREATE TABLE IF NOT EXISTS, so
    // structural changes need the forward steps below as well.
    const before = this.schemaVersion();
    this.raw.exec(SCHEMA_SQL);
    this.upgradeFrom(before);
    this.raw
      .prepare('INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', String(SCHEMA_VERSION));
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
    if (before === null) return; // fresh database; SCHEMA_SQL already built it

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
