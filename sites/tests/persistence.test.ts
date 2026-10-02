/**
 * Persistence regressions that only a real engine can establish.
 *
 * Each case here is a correctness failure a visitor could not detect:
 *
 * - A refresh that overran its lease silently overwriting the newer feed that
 *   replaced it.
 * - A page showing one publication's metadata beside another publication's
 *   cards and score breakdowns.
 * - Two genuinely different AnchorLink events collapsing into one row, so one
 *   of them loses its sources, provenance, score breakdown, and calendar link.
 *
 * These run against `node:sqlite` with the generated migrations applied, because
 * rollback, uniqueness, and the `NOT NULL` publish fence are properties of the
 * engine, not of a recorded statement list.
 */

import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { defaultConfig } from "../lib/vfr/config.ts";
import type { D1StatementLike } from "../lib/vfr/d1.ts";
import { loadFeedView } from "../lib/vfr/feed.ts";
import { runRefresh } from "../lib/vfr/pipeline.ts";
import { Repository } from "../lib/vfr/repository.ts";
import type { PublishPayload } from "../lib/vfr/repository.ts";
import { anchorRow, fakeFetcher, searchPage } from "./helpers.ts";
import { SqliteD1, bindable, freshDatabase } from "./sqlite-d1.ts";

// The feed opens on today, so "now" is on the target day itself.
const NOW = Date.UTC(2025, 2, 12, 18); // 2025-03-12 13:00 America/Chicago
const TARGET = "2025-03-12";

type Recorded = { sql: string; values: unknown[] };

/** Captures each payload handed to `publishFeed`, then publishes normally. */
class CapturingRepository extends Repository {
  readonly published: PublishPayload[] = [];

  async publishFeed(payload: PublishPayload): Promise<void> {
    this.published.push(payload);
    await super.publishFeed(payload);
  }
}

/**
 * A D1 that holds back the publish batch instead of committing it, so the exact
 * statements a real publish would run can be replayed later, at a chosen moment.
 */
class DeferredPublishD1 extends SqliteD1 {
  readonly deferred: Recorded[] = [];

  async batch(statements: D1StatementLike[]): Promise<{ results: unknown[] }[]> {
    const recorded = statements.map((statement) => {
      const raw = statement as unknown as { sql: string; values: unknown[] };
      return { sql: raw.sql, values: raw.values };
    });
    if (recorded.some((entry) => entry.sql.startsWith("INSERT INTO feeds"))) {
      this.deferred.push(...recorded);
      return recorded.map(() => ({ results: [] }));
    }
    return super.batch(statements);
  }
}

/** Runs a callback immediately before each batch, and records read shapes. */
class HookedSqliteD1 extends SqliteD1 {
  beforeBatch: (() => void) | null = null;
  readonly batchedSql: string[][] = [];
  readonly standaloneSql: string[] = [];

  prepare(query: string): D1StatementLike {
    const statement = super.prepare(query);
    const standalone = this.standaloneSql;
    const originalFirst = statement.first.bind(statement);
    const originalAll = statement.all.bind(statement);
    statement.first = async <T>() => {
      standalone.push(query);
      return originalFirst<T>();
    };
    statement.all = async <T>() => {
      standalone.push(query);
      return originalAll<T>();
    };
    return statement;
  }

  async batch(statements: D1StatementLike[]): Promise<{ results: unknown[] }[]> {
    this.beforeBatch?.();
    this.batchedSql.push(
      statements.map((statement) => (statement as unknown as { sql: string }).sql),
    );
    return super.batch(statements);
  }
}

/** Replay a captured publish as one real transaction. */
function replay(db: DatabaseSync, statements: Recorded[]): void {
  db.exec("BEGIN");
  try {
    for (const entry of statements) {
      db.prepare(entry.sql).run(...entry.values.map(bindable));
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function refresh(options: {
  db: DatabaseSync;
  holder: string;
  nowMs: number;
  trigger: string;
  rows: unknown[];
  adapter?: SqliteD1;
}) {
  const config = defaultConfig();
  const repository = new CapturingRepository(
    options.adapter ?? new SqliteD1(options.db),
    config,
  );
  return {
    repository,
    result: runRefresh({
      repository,
      config,
      trigger: options.trigger,
      nowMs: options.nowMs,
      holder: options.holder,
      fetcher: fakeFetcher([{ skip: 0, body: searchPage(options.rows) }]),
    }),
  };
}

test("a refresh that lost its lease cannot overwrite the newer published feed", async () => {
  const db = freshDatabase();
  const config = defaultConfig();

  // Worker A publishes while holding the lease. Its payload is captured so the
  // same completed work can be replayed later, as a slow holder would.
  const first = refresh({
    db,
    holder: "worker-a",
    nowMs: NOW,
    trigger: "a",
    rows: [anchorRow({ id: 100001, name: "Free Pizza Night" })],
  });
  assert.ok((await first.result).ok);
  const payloadA = first.repository.published[0];
  assert.equal(payloadA.leaseHolder, "worker-a");

  // A's lease expires. Worker B claims it legitimately and publishes newer data.
  const laterMs = NOW + config.leaseTtlMs + 1000;
  const second = refresh({
    db,
    holder: "worker-b",
    nowMs: laterMs,
    trigger: "b",
    rows: [anchorRow({ id: 100002, name: "Taco Tuesday" })],
  });
  assert.ok((await second.result).ok);

  // A finally finishes and tries to publish the day it computed long ago. The
  // fence inside the publish transaction rejects it: A no longer holds the
  // lease, so its ownership sub-select is NULL against a NOT NULL column.
  const repositoryA = new Repository(new SqliteD1(db), config);
  await assert.rejects(() => repositoryA.publishFeed(payloadA), /publish feed/);

  // B's feed is intact and complete; nothing of A's was deleted or inserted.
  const view = await loadFeedView(repositoryA, config, laterMs);
  assert.equal(view.state, "ok");
  assert.equal(view.publishedAt, new Date(laterMs).toISOString());
  assert.equal(view.snapshot?.events.length, 1);
  assert.equal(view.snapshot?.events[0].event.title, "Taco Tuesday");
  assert.equal(view.snapshot?.events[0].components.length, 8);

  const titles = db
    .prepare("SELECT title FROM events WHERE feed_date = ?")
    .all(TARGET)
    .map((row) => (row as { title: string }).title);
  assert.deepEqual(titles, ["Taco Tuesday"]);

  db.close();
});

test("an expired but unsuperseded lease may still finish its publish", async () => {
  const db = freshDatabase();
  const config = defaultConfig();

  const first = refresh({
    db,
    holder: "worker-a",
    nowMs: NOW,
    trigger: "a",
    rows: [anchorRow({ id: 100001 })],
  });
  assert.ok((await first.result).ok);
  const payload = first.repository.published[0];

  // Expired, but still held by A and never taken over: the work is still the
  // latest, so finishing late is allowed rather than discarded.
  db.exec("UPDATE refresh_lease SET holder = 'worker-a', expires_at = 1 WHERE name = 'refresh'");
  const repository = new Repository(new SqliteD1(db), config);
  const republishedAt = new Date(NOW + 1000).toISOString();
  await repository.publishFeed({ ...payload, publishedAt: republishedAt });
  assert.equal((await loadFeedView(repository, config, NOW + 2000)).publishedAt, republishedAt);

  // A released lease is a finished run. Replaying it is rejected.
  db.exec("UPDATE refresh_lease SET expires_at = 0 WHERE name = 'refresh'");
  await assert.rejects(() => repository.publishFeed(payload), /publish feed/);

  db.close();
});

test("a feed read cannot mix one publication's metadata with another's rows", async () => {
  const db = freshDatabase();
  const config = defaultConfig();

  const first = refresh({
    db,
    holder: "worker-a",
    nowMs: NOW,
    trigger: "a",
    rows: [anchorRow({ id: 100001, name: "Free Pizza Night" })],
  });
  assert.ok((await first.result).ok);

  // Build, but do not commit, a second real publication for the same day.
  const deferred = new DeferredPublishD1(db);
  const second = refresh({
    db,
    adapter: deferred,
    holder: "worker-b",
    nowMs: NOW + 60000,
    trigger: "b",
    rows: [
      anchorRow({ id: 100002, name: "Taco Tuesday" }),
      anchorRow({
        id: 100003,
        name: "Dessert Social",
        startsOn: "2025-03-12T20:00:00Z",
        endsOn: "2025-03-12T21:00:00Z",
      }),
    ],
  });
  assert.ok((await second.result).ok);
  assert.ok(deferred.deferred.length > 0);

  const hooked = new HookedSqliteD1(db);
  const repository = new Repository(hooked, config);

  // Commit that publication at the last possible instant before the read, so a
  // two-phase read would see old metadata and new rows.
  let committed = false;
  hooked.beforeBatch = () => {
    if (committed) return;
    committed = true;
    db.exec(
      "UPDATE refresh_lease SET holder = 'worker-b', expires_at = 1 WHERE name = 'refresh'",
    );
    replay(db, deferred.deferred);
  };

  const snapshot = await repository.readFeed(TARGET);
  hooked.beforeBatch = null;
  assert.ok(snapshot);

  // Metadata and rows describe one publication: the one that had committed.
  assert.equal(snapshot.publishedAt, new Date(NOW + 60000).toISOString());
  assert.equal(snapshot.eventCount, snapshot.events.length);
  assert.deepEqual(
    snapshot.events.map((stored) => stored.event.title).sort(),
    ["Dessert Social", "Taco Tuesday"],
  );
  // Every card carries its own complete scoring and provenance.
  for (const stored of snapshot.events) {
    assert.equal(stored.components.length, 8);
    assert.equal(stored.sources.length, 1);
    assert.ok(stored.provenance.length > 0);
    assert.notEqual(stored.explanation, "");
  }

  // The metadata and every child table were read in one batch, not separately.
  const readBatch = hooked.batchedSql.find((sqls) =>
    sqls.some((sql) => sql.includes("FROM feeds WHERE target_date")),
  );
  assert.ok(readBatch, "the feed metadata was not read inside a batch");
  for (const table of [
    "FROM events",
    "FROM score_components",
    "FROM conflicts",
    "FROM field_provenance",
    "FROM source_records",
    "FROM event_changes",
  ]) {
    assert.ok(
      readBatch.some((sql) => sql.includes(table)),
      `${table} was not read in the same batch as the metadata`,
    );
  }
  // Only the advisory history list is read outside the batch.
  assert.deepEqual(
    hooked.standaloneSql.filter(
      (sql) => sql.includes("FROM events") || sql.includes("FROM feeds"),
    ),
    [],
  );

  db.close();
});

test("two AnchorLink events with identical fields keep their own metadata", async () => {
  const db = freshDatabase();
  const config = defaultConfig();
  const repository = new Repository(new SqliteD1(db), config);

  // Same title, venue, organizer, and start time; different native event ids.
  // These are two real events, so both must publish and neither may lose its
  // own source record, provenance, or score breakdown.
  const result = await runRefresh({
    repository,
    config,
    trigger: "test",
    nowMs: NOW,
    fetcher: fakeFetcher([
      {
        skip: 0,
        body: searchPage([
          anchorRow({ id: 100001, description: "Free pizza provided." }),
          anchorRow({ id: 100002, description: "Free pizza provided." }),
        ]),
      },
    ]),
  });

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.summary.published, 2);

  const view = await loadFeedView(repository, config, NOW);
  assert.equal(view.snapshot?.events.length, 2);
  const events = view.snapshot!.events;

  // Distinct physical ids, distinct identities, distinct AnchorLink ids.
  assert.equal(new Set(events.map((e) => e.event.id)).size, 2);
  assert.equal(new Set(events.map((e) => e.event.identityKey)).size, 2);
  assert.deepEqual(
    events.map((e) => e.event.anchorlinkId).sort(),
    ["100001", "100002"],
  );
  // The dedup fingerprint is shared, which is exactly why it cannot be the id.
  assert.equal(new Set(events.map((e) => e.event.dedupKey)).size, 1);
  // Neither identity carries a disambiguation suffix: both are provider-native.
  for (const stored of events) {
    assert.equal(stored.event.identityKey, `source|anchorlink:${stored.event.anchorlinkId}`);
    assert.equal(stored.event.id, `${TARGET}|${stored.event.identityKey}`);
  }

  for (const stored of events) {
    assert.equal(stored.components.length, 8, "score breakdown lost");
    assert.equal(stored.sources.length, 1, "source record lost");
    assert.equal(
      stored.sources[0].sourceUrl,
      `https://anchorlink.vanderbilt.edu/event/${stored.event.anchorlinkId}`,
    );
    assert.ok(stored.provenance.length > 0, "provenance lost");
    assert.equal(stored.change?.kind, "new");
    // Each event is independently downloadable as a calendar file.
    const found = await repository.findEventByAnchorlinkId(stored.event.anchorlinkId!);
    assert.equal(found?.anchorlinkId, stored.event.anchorlinkId);
  }

  // Raw payloads are retained per event, not deduplicated away.
  const rawCount = db
    .prepare("SELECT COUNT(DISTINCT event_id) AS n FROM source_records WHERE feed_date = ?")
    .get(TARGET) as { n: number };
  assert.equal(rawCount.n, 2);

  db.close();
});

test("a live row with an impossible timestamp fails the refresh and keeps the feed", async () => {
  const db = freshDatabase();
  const config = defaultConfig();
  const repository = new Repository(new SqliteD1(db), config);
  // 2025-03-02 12:00 America/Chicago, so today's target is 2025-03-02.
  const nowMs = Date.UTC(2025, 2, 2, 18);
  const target = "2025-03-02";

  const good = await runRefresh({
    repository,
    config,
    trigger: "first",
    nowMs,
    fetcher: fakeFetcher([
      {
        skip: 0,
        body: searchPage([
          anchorRow({
            id: 100001,
            name: "Sunday Supper",
            startsOn: "2025-03-02T18:00:00Z",
            endsOn: "2025-03-02T20:00:00Z",
          }),
        ]),
      },
    ]),
  });
  assert.ok(good.ok, JSON.stringify(good));

  // February 30 does not exist. Date.parse rolls it forward to March 2, which is
  // exactly the target date, so a lenient parser would publish this row as if
  // the source had stated a real instant.
  assert.equal(new Date(Date.parse("2025-02-30T18:00:00Z")).toISOString().slice(0, 10), target);

  const failed = await runRefresh({
    repository,
    config,
    trigger: "second",
    nowMs: nowMs + 60000,
    fetcher: fakeFetcher([
      {
        skip: 0,
        body: searchPage([
          anchorRow({
            id: 100002,
            name: "Impossible Date",
            startsOn: "2025-02-30T18:00:00Z",
            endsOn: "2025-03-02T20:00:00Z",
          }),
        ]),
      },
    ]),
  });

  assert.equal(failed.ok, false);
  assert.ok(!failed.ok && failed.kind === "source");

  // The whole refresh failed, so the previously published day is untouched.
  const view = await loadFeedView(repository, config, nowMs + 60000);
  assert.equal(view.state, "ok");
  assert.equal(view.publishedAt, new Date(nowMs).toISOString());
  assert.deepEqual(
    view.snapshot?.events.map((stored) => stored.event.title),
    ["Sunday Supper"],
  );
  assert.equal((await repository.lastRun())?.status, "source_error");

  db.close();
});

test("a duplicate feed identity is rejected by the schema rather than merged", () => {  const db = freshDatabase();
  db.exec(
    `INSERT INTO feeds (target_date, timezone, target_window, event_count, published_at,
                        source_total, pages_fetched)
          VALUES ('${TARGET}', 'America/Chicago', 'today', 0, '2025-03-11T18:00:00Z', 0, 1)`,
  );
  const insert = (id: string) =>
    db.exec(
      `INSERT INTO events (id, feed_date, identity_key, dedup_key, title, event_date,
                           ends_next_day, food_confirmed, food_category, verification_state,
                           walking_label, "rank", created_at, updated_at)
            VALUES ('${id}', '${TARGET}', 'source|anchorlink:1', 'k', 'T', '${TARGET}',
                    0, 'confirmed', 'full_meal', 'partially_verified', 'n/a', 1,
                    '2025-03-11T18:00:00Z', '2025-03-11T18:00:00Z')`,
    );
  insert("a");
  assert.throws(() => insert("b"), /UNIQUE constraint failed/);
  db.close();
});
