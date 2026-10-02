/**
 * Shared test doubles.
 *
 * A fake D1 that records the statements a publish issues, plus a fake HTTP
 * fetcher that serves canned AnchorLink pages, so the whole refresh path can be
 * exercised without a Workers runtime or any network access.
 */

import type { D1Like, D1StatementLike } from "../lib/vfr/d1.ts";
import type { FetchResult, HttpFetcher } from "../lib/vfr/anchorlink.ts";

export type RecordedStatement = { sql: string; values: unknown[] };

export type FakeDbOptions = {
  /** Rows returned for a `first()` call, matched by substring of the SQL. */
  firstRows?: { match: string; row: unknown }[];
  /** Rows returned for an `all()` call, matched by substring of the SQL. */
  allRows?: { match: string; rows: unknown[] }[];
  /** Throw on any statement whose SQL contains this substring. */
  failOn?: string;
  failWith?: Error;
};

class FakeStatement implements D1StatementLike {
  values: unknown[] = [];
  readonly sql: string;
  private readonly db: FakeDb;

  constructor(sql: string, db: FakeDb) {
    this.sql = sql;
    this.db = db;
  }

  bind(...values: unknown[]): D1StatementLike {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    this.db.throwIfFailing(this.sql);
    this.db.executed.push({ sql: this.sql, values: this.values });
    for (const entry of this.db.options.firstRows ?? []) {
      if (this.sql.includes(entry.match)) return entry.row as T;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    this.db.throwIfFailing(this.sql);
    this.db.executed.push({ sql: this.sql, values: this.values });
    for (const entry of this.db.options.allRows ?? []) {
      if (this.sql.includes(entry.match)) return { results: entry.rows as T[] };
    }
    return { results: [] };
  }

  async run(): Promise<unknown> {
    this.db.throwIfFailing(this.sql);
    this.db.executed.push({ sql: this.sql, values: this.values });
    return { success: true };
  }
}

export class FakeDb implements D1Like {
  readonly executed: RecordedStatement[] = [];
  readonly batches: RecordedStatement[][] = [];

  readonly options: FakeDbOptions;

  constructor(options: FakeDbOptions = {}) {
    this.options = options;
  }

  throwIfFailing(sql: string): void {
    if (this.options.failOn && sql.includes(this.options.failOn)) {
      throw this.options.failWith ?? new Error("D1 failure");
    }
  }

  prepare(query: string): D1StatementLike {
    return new FakeStatement(query, this);
  }

  /** Canned rows for a statement, matched the same way as `all`/`first`. */
  rowsFor(sql: string): unknown[] {
    for (const entry of this.options.allRows ?? []) {
      if (sql.includes(entry.match)) return entry.rows;
    }
    for (const entry of this.options.firstRows ?? []) {
      if (sql.includes(entry.match)) return [entry.row];
    }
    return [];
  }

  async batch(statements: D1StatementLike[]): Promise<{ results: unknown[] }[]> {
    const recorded = statements.map((statement) => {
      const fake = statement as FakeStatement;
      return { sql: fake.sql, values: fake.values };
    });
    for (const entry of recorded) this.throwIfFailing(entry.sql);
    this.batches.push(recorded);
    this.executed.push(...recorded);
    // A read batch returns rows per statement, exactly as D1 does.
    return recorded.map((entry) => ({ results: this.rowsFor(entry.sql) }));
  }
}

/** Serve canned JSON pages keyed by the `skip` offset in the request URL. */
export function fakeFetcher(
  pages: { skip: number; body: unknown; ok?: boolean; status?: number }[],
): HttpFetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(url: string): Promise<FetchResult> {
      calls.push(url);
      const skip = Number(new URL(url).searchParams.get("skip") ?? "0");
      const page = pages.find((candidate) => candidate.skip === skip);
      if (!page) {
        return { ok: false, status: 404, text: null, error: "no canned page" };
      }
      if (page.ok === false) {
        return {
          ok: false,
          status: page.status ?? 500,
          text: null,
          error: `HTTP ${page.status ?? 500}`,
        };
      }
      return {
        ok: true,
        status: 200,
        text: typeof page.body === "string" ? page.body : JSON.stringify(page.body),
        error: null,
      };
    },
  };
}

/** A valid AnchorLink discovery row for the Vanderbilt Free Food facet. */
export function anchorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 100001,
    institutionId: 24,
    branchId: 56623,
    name: "Free Pizza Night",
    description: "<p>Free <b>pizza</b> and salad provided.</p>",
    location: "Sarratt Student Center 216",
    organizationName: "Student Life",
    startsOn: "2025-03-12T23:00:00Z",
    endsOn: "2025-03-13T01:00:00Z",
    benefitNames: ["Free Food"],
    visibility: "Public",
    status: "Approved",
    ...overrides,
  };
}

export function searchPage(rows: unknown[], total = rows.length) {
  return { "@odata.count": total, value: rows };
}
