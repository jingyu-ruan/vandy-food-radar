/**
 * End-to-end checks against a real SQLite engine.
 *
 * Every other test mocks the database, which proves the statement *list* is
 * right but not that the SQL is valid. D1 is SQLite, so the generated migrations
 * and the raw prepared statements are executed here against the real engine. This
 * is what catches the failures that mocks cannot: a reserved word used as a bare
 * column name (`rank`, `trigger`), a malformed `ON CONFLICT ... WHERE` clause, a
 * `RETURNING` that yields nothing, or a retention delete that removes rows it
 * should have kept.
 */

import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { defaultConfig } from "../lib/vfr/config.ts";
import { loadFeedView } from "../lib/vfr/feed.ts";
import { runRefresh } from "../lib/vfr/pipeline.ts";
import { Repository } from "../lib/vfr/repository.ts";
import { anchorRow, fakeFetcher, searchPage } from "./helpers.ts";
import { SqliteD1, freshDatabase } from "./sqlite-d1.ts";

// The feed opens on today, so "now" is on the target day itself.
const NOW = Date.UTC(2025, 2, 12, 18); // 2025-03-12 13:00 America/Chicago
const TARGET = "2025-03-12";

function repositoryFor(db: DatabaseSync) {
  return new Repository(new SqliteD1(db), defaultConfig());
}

test("the generated migrations apply cleanly to SQLite", () => {
  const db = freshDatabase();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
  assert.deepEqual(tables, [
    "app_state",
    "conflicts",
    "event_changes",
    "event_history",
    "events",
    "feeds",
    "field_provenance",
    "refresh_lease",
    "refresh_runs",
    "score_components",
    "source_records",
  ]);

  // The feed identity invariant is a constraint, not just a lookup index.
  const identityIndex = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'events_feed_identity_idx'")
    .get() as { sql: string };
  assert.match(identityIndex.sql, /CREATE UNIQUE INDEX/);

  db.close();
});

test("a refresh publishes and reads back through real SQL", async () => {
  const db = freshDatabase();
  const config = defaultConfig();
  const repository = repositoryFor(db);

  // Nothing published yet: the day must read as uninitialized, not empty.
  const before = await loadFeedView(repository, config, NOW);
  assert.equal(before.state, "uninitialized");

  const result = await runRefresh({
    repository,
    config,
    trigger: "test",
    nowMs: NOW,
    fetcher: fakeFetcher([
      {
        skip: 0,
        body: searchPage([
          anchorRow({ id: 100001, name: "Free Pizza Night" }),
          anchorRow({
            id: 100002,
            name: "Coffee and Cookies",
            description: "Light refreshments.",
            startsOn: "2025-03-12T15:00:00Z",
            endsOn: "2025-03-12T16:00:00Z",
          }),
        ]),
      },
    ]),
  });

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.summary.published, 2);

  const view = await loadFeedView(repository, config, NOW);
  assert.equal(view.state, "ok");
  assert.equal(view.snapshot?.events.length, 2);
  assert.equal(view.stale, false);

  // Ranking is applied and persisted: the full meal outranks the snacks.
  const [first, second] = view.snapshot!.events;
  assert.equal(first.rank, 1);
  assert.equal(first.event.title, "Free Pizza Night");
  assert.equal(second.event.title, "Coffee and Cookies");
  assert.ok((first.event.scoreTotal ?? 0) > (second.event.scoreTotal ?? 0));

  // Everything needed to explain a result survived the round trip.
  assert.equal(first.components.length, 5);
  assert.equal(first.provenance.length, 12);
  assert.equal(first.sources.length, 1);
  assert.equal(first.change?.kind, "new");
  assert.match(first.explanation, /Ranked/);
  // "Sarratt Student Center 216" resolves through the campus dataset, so the
  // walk is a labelled estimate from the reference point rather than unknown.
  assert.match(first.walkingLabel, /^\d+ min walk$/);
  assert.equal(second.walkingLabel, first.walkingLabel);
  assert.equal(first.event.verificationState, "partially_verified");
  assert.equal(first.event.confidence, 0.3);

  // The raw source payload is retained verbatim.
  const raw = db
    .prepare("SELECT raw_payload FROM source_records LIMIT 1")
    .get() as { raw_payload: string };
  assert.ok(JSON.parse(raw.raw_payload).benefitNames.includes("Free Food"));

  // The run was logged with the reserved-word `trigger` column intact.
  const run = await repository.lastRun();
  assert.equal(run?.status, "success");
  assert.equal(run?.trigger, "test");

  db.close();
});

test("re-running a refresh updates in place and classifies the change", async () => {
  const db = freshDatabase();
  const config = defaultConfig();
  const repository = repositoryFor(db);

  const firstFetch = fakeFetcher([{ skip: 0, body: searchPage([anchorRow({ id: 100001 })]) }]);
  await runRefresh({ repository, config, trigger: "first", nowMs: NOW, fetcher: firstFetch });

  const movedFetch = fakeFetcher([
    {
      skip: 0,
      body: searchPage([
        anchorRow({
          id: 100001,
          location: "Alumni Hall 201",
          startsOn: "2025-03-12T23:00:00Z",
          endsOn: "2025-03-13T01:00:00Z",
        }),
      ]),
    },
  ]);
  const second = await runRefresh({
    repository,
    config,
    trigger: "second",
    nowMs: NOW + 60000,
    fetcher: movedFetch,
  });

  assert.ok(second.ok);
  assert.equal(second.summary.changes.venue_changed, 1);

  // One row, not two: the stable identity updated in place.
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE feed_date = ?")
    .get(TARGET) as { n: number };
  assert.equal(count.n, 1);

  const view = await loadFeedView(repository, config, NOW + 60000);
  const stored = view.snapshot!.events[0];
  assert.equal(stored.event.location, "Alumni Hall 201");
  assert.equal(stored.change?.kind, "venue_changed");
  // The venue change is recorded in history and surfaced on the card.
  assert.ok(stored.history.some((entry) => entry.fieldName === "location"));

  db.close();
});

test("a failed refresh leaves the previously published feed untouched", async () => {
  const db = freshDatabase();
  const config = defaultConfig();
  const repository = repositoryFor(db);

  await runRefresh({
    repository,
    config,
    trigger: "first",
    nowMs: NOW,
    fetcher: fakeFetcher([{ skip: 0, body: searchPage([anchorRow({ id: 100001 })]) }]),
  });

  const failed = await runRefresh({
    repository,
    config,
    trigger: "second",
    nowMs: NOW + 60000,
    fetcher: fakeFetcher([{ skip: 0, body: null, ok: false, status: 502 }]),
  });
  assert.equal(failed.ok, false);

  // The feed is intact and still readable.
  const view = await loadFeedView(repository, config, NOW + 60000);
  assert.equal(view.state, "ok");
  assert.equal(view.snapshot?.events.length, 1);
  assert.equal(view.publishedAt, new Date(NOW).toISOString());

  // The failure is visible in the run log without having replaced the feed.
  const run = await repository.lastRun();
  assert.equal(run?.status, "source_error");

  db.close();
});

test("the conditional lease claim blocks an overlapping refresh and expires", async () => {
  const db = freshDatabase();
  const config = defaultConfig();
  const repository = repositoryFor(db);

  assert.equal(await repository.claimLease("worker-a", NOW), true);
  // A live lease cannot be stolen.
  assert.equal(await repository.claimLease("worker-b", NOW + 1000), false);
  // Once it expires, the next worker may claim it, so a crash cannot deadlock.
  assert.equal(await repository.claimLease("worker-b", NOW + config.leaseTtlMs + 1), true);

  // Only the holder may release it.
  await repository.releaseLease("worker-a");
  const stillHeld = db
    .prepare("SELECT holder, expires_at FROM refresh_lease WHERE name = 'refresh'")
    .get() as { holder: string; expires_at: number };
  assert.equal(stillHeld.holder, "worker-b");
  assert.ok(stillHeld.expires_at > 0);

  await repository.releaseLease("worker-b");
  const released = db
    .prepare("SELECT expires_at FROM refresh_lease WHERE name = 'refresh'")
    .get() as { expires_at: number };
  assert.equal(released.expires_at, 0);

  db.close();
});

test("a refresh that cannot claim the lease publishes nothing", async () => {
  const db = freshDatabase();
  const config = defaultConfig();
  const repository = repositoryFor(db);

  await repository.claimLease("other-worker", NOW);
  const result = await runRefresh({
    repository,
    config,
    trigger: "blocked",
    nowMs: NOW,
    fetcher: fakeFetcher([{ skip: 0, body: searchPage([anchorRow()]) }]),
  });

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.kind === "locked");
  const count = db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
  assert.equal(count.n, 0);

  db.close();
});

test("a genuine empty day is distinguishable from a day never published", async () => {
  const db = freshDatabase();
  const config = defaultConfig();
  const repository = repositoryFor(db);

  const result = await runRefresh({
    repository,
    config,
    trigger: "test",
    nowMs: NOW,
    fetcher: fakeFetcher([{ skip: 0, body: searchPage([], 0) }]),
  });
  assert.ok(result.ok);

  const view = await loadFeedView(repository, config, NOW);
  assert.equal(view.state, "empty");
  assert.equal(view.publishedAt, new Date(NOW).toISOString());
  assert.match(view.message, /no approved public AnchorLink events/i);

  db.close();
});

test("retention keeps a bounded rolling window anchored on today", async () => {
  const db = freshDatabase();
  const config = defaultConfig();
  config.retention = { pastDays: 1, futureDays: 2 };
  const repository = new Repository(new SqliteD1(db), config);
  // Publish one day at a time on three consecutive days.
  for (const dayOffset of [0, 1, 2]) {
    const result = await runRefresh({
      repository,
      config,
      trigger: "test",
      nowMs: NOW + dayOffset * 86400000,
      fetcher: fakeFetcher([{ skip: 0, body: searchPage([]) }]),
    });
    assert.ok(result.ok, JSON.stringify(result));
  }
  // Today is 2025-03-14 now; the 12th is outside the one-day past window.
  const dates = () =>
    db
      .prepare("SELECT target_date FROM feeds ORDER BY target_date")
      .all()
      .map((row) => (row as { target_date: string }).target_date);
  assert.deepEqual(dates(), ["2025-03-13", "2025-03-14"]);

  // A requested span is always kept, even beyond the configured future window.
  const wide = await runRefresh({
    repository,
    config,
    trigger: "week",
    days: 7,
    nowMs: NOW + 2 * 86400000,
    fetcher: fakeFetcher([{ skip: 0, body: searchPage([]) }]),
  });
  assert.ok(wide.ok);
  assert.equal(dates().length, 8);
  assert.equal(dates()[0], "2025-03-13");
  assert.equal(dates()[7], "2025-03-20");

  db.close();
});

test("an event is exportable by its AnchorLink id after publication", async () => {
  const db = freshDatabase();
  const config = defaultConfig();
  const repository = repositoryFor(db);

  await runRefresh({
    repository,
    config,
    trigger: "test",
    nowMs: NOW,
    fetcher: fakeFetcher([{ skip: 0, body: searchPage([anchorRow({ id: 100001 })]) }]),
  });

  const found = await repository.findEventByAnchorlinkId("100001");
  assert.ok(found);
  assert.equal(found.anchorlinkId, "100001");
  assert.equal(found.startUtc, "2025-03-12T23:00:00Z");
  assert.equal(await repository.findEventByAnchorlinkId("999999"), null);

  db.close();
});
