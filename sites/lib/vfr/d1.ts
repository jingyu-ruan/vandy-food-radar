/**
 * Minimal D1 surface plus raw prepared-statement helpers.
 *
 * The schema is declared with Drizzle (see `db/schema.ts`) and migrations are
 * generated from it, but every runtime query here is a raw prepared statement.
 * That keeps the hot read path to a fixed number of round trips and makes the
 * atomic publish an explicit, auditable statement list.
 *
 * All values are bound as parameters; no query is assembled from source data.
 *
 * The structural types mean a fake database can be injected in tests without a
 * Workers runtime, while the real `D1Database` binding satisfies them directly.
 */

/** Hard D1 limit on bound parameters per statement. */
export const MAX_BOUND_PARAMS = 100;

export type D1StatementLike = {
  bind(...values: unknown[]): D1StatementLike;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
};

/** What one statement of a batch returns. D1 populates `results` for reads. */
export type D1BatchResultLike = { results?: unknown[] };

export type D1Like = {
  prepare(query: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<D1BatchResultLike[]>;
};

/**
 * Row lists from a batch, in statement order.
 *
 * A batch is one transaction, so a multi-statement read returns a single
 * consistent snapshot instead of several independently-timed reads.
 */
export function batchRows(results: D1BatchResultLike[]): unknown[][] {
  return results.map((entry) => (Array.isArray(entry?.results) ? entry.results : []));
}

/** Raised for any durable-storage failure the caller must surface honestly. */
export class StorageError extends Error {
  /** True when the cause is a missing table, i.e. migrations not yet applied. */
  readonly schemaMissing: boolean;

  constructor(message: string, schemaMissing: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
    this.schemaMissing = schemaMissing;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
    return `${error.message}${cause}`;
  }
  return "unexpected storage error";
}

/** Whether a failure means the schema has not been applied yet. */
export function isSchemaMissing(error: unknown): boolean {
  return /no such table|no such column/i.test(describe(error));
}

/** Wrap a storage operation so callers see one error type. */
export async function withStorage<T>(
  what: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new StorageError(`${what}: ${describe(error)}`, isSchemaMissing(error), {
      cause: error,
    });
  }
}

export type ColumnSpec<Row> = {
  name: string;
  value: (row: Row) => unknown;
};

/**
 * Build chunked multi-row `INSERT` statements.
 *
 * Rows are packed per statement up to the bound-parameter limit, which keeps a
 * full day's publish to a few dozen statements instead of several hundred, while
 * still fitting inside one atomic batch.
 */
export function buildInsertStatements<Row>(
  db: D1Like,
  table: string,
  columns: ColumnSpec<Row>[],
  rows: Row[],
  options: { orReplace?: boolean } = {},
): D1StatementLike[] {
  if (rows.length === 0) return [];
  const perRow = columns.length;
  const rowsPerStatement = Math.max(1, Math.floor(MAX_BOUND_PARAMS / perRow));
  const columnList = columns.map((column) => column.name).join(", ");
  const placeholderGroup = `(${columns.map(() => "?").join(", ")})`;
  const verb = options.orReplace ? "INSERT OR REPLACE INTO" : "INSERT INTO";
  const statements: D1StatementLike[] = [];

  for (let offset = 0; offset < rows.length; offset += rowsPerStatement) {
    const chunk = rows.slice(offset, offset + rowsPerStatement);
    const sql =
      `${verb} ${table} (${columnList}) VALUES ` +
      chunk.map(() => placeholderGroup).join(", ");
    const values: unknown[] = [];
    for (const row of chunk) {
      for (const column of columns) values.push(column.value(row));
    }
    statements.push(db.prepare(sql).bind(...values));
  }
  return statements;
}

/** Encode a tri-state boolean for SQLite storage. */
export function boolToInt(value: boolean | null): number | null {
  return value === null ? null : value ? 1 : 0;
}

/** Decode a tri-state boolean read back from SQLite. */
export function intToBool(value: number | null): boolean | null {
  if (value === null || value === undefined) return null;
  return value !== 0;
}
