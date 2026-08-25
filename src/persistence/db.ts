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
    this.raw.exec(SCHEMA_SQL);
    this.raw
      .prepare('INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('schema_version', String(SCHEMA_VERSION));
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
