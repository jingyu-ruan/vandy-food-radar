/**
 * A D1-shaped adapter over Node's built-in `node:sqlite`.
 *
 * D1 is SQLite, so this is what lets the tests execute the generated migrations
 * and the real prepared statements instead of only asserting on a recorded
 * statement list. A mock can show that a statement was issued; only a real
 * engine can show that a transaction rolls back, that a unique constraint
 * holds, and that a `NOT NULL` fence actually aborts a publish.
 *
 * `batch` is a real transaction: BEGIN, run each statement in order, COMMIT, and
 * ROLLBACK on any error. Every statement is executed with `all()` so a read
 * batch returns rows per statement the way D1 does.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import type { D1Like, D1StatementLike } from "../lib/vfr/d1.ts";

const MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle/", import.meta.url));

/** node:sqlite only binds primitives, so normalize what the repository passes. */
export function bindable(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "bigint") return value;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export class SqliteStatement implements D1StatementLike {
  readonly sql: string;
  private values: unknown[] = [];
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...values: unknown[]): D1StatementLike {
    this.values = values;
    return this;
  }

  private args() {
    return this.values.map(bindable);
  }

  /** Execute and return every row, which is also how a batch runs it. */
  rows(): unknown[] {
    return this.db.prepare(this.sql).all(...this.args());
  }

  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args()) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.rows() as T[] };
  }

  async run(): Promise<unknown> {
    return this.db.prepare(this.sql).run(...this.args());
  }
}

export class SqliteD1 implements D1Like {
  protected readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  prepare(query: string): D1StatementLike {
    return new SqliteStatement(this.db, query);
  }

  async batch(statements: D1StatementLike[]): Promise<{ results: unknown[] }[]> {
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement) => ({
        results: (statement as SqliteStatement).rows(),
      }));
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** A database with every generated migration applied, in order. */
export function freshDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(files.length > 0, "no generated migration found");
  for (const file of files) {
    db.exec(readFileSync(`${MIGRATIONS_DIR}${file}`, "utf8"));
  }
  return db;
}
