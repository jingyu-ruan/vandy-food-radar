/**
 * Refresh lifecycle: atomicity, retention on failure, leasing, and change
 * classification across runs.
 *
 * The behaviours exercised here are the ones a user would never notice going
 * wrong until the page showed something false: a half-published day, a feed
 * wiped out by an upstream outage, two refreshes overwriting each other, or an
 * event quietly marked cancelled because it stopped being listed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { detectChanges, diffHistory } from "../lib/vfr/changes.ts";
import { defaultConfig } from "../lib/vfr/config.ts";
import { FoodCategory, FoodConfirmed, VerificationState } from "../lib/vfr/models.ts";
import type { Event } from "../lib/vfr/models.ts";
import { runRefresh } from "../lib/vfr/pipeline.ts";
import { Repository } from "../lib/vfr/repository.ts";
import { FakeDb, anchorRow, fakeFetcher, searchPage } from "./helpers.ts";

const NOW = Date.UTC(2025, 2, 12, 18); // 2025-03-12 13:00 local
const TARGET = "2025-03-12"; // the feed opens on today
const CHICAGO = "America/Chicago";

function config() {
  const base = defaultConfig();
  base.locationProvider = "haversine";
  return base;
}

function storedEventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "source|anchorlink:100001",
    feed_date: TARGET,
    identity_key: "source|anchorlink:100001",
    dedup_key: "k",
    anchorlink_id: "100001",
    title: "Free Pizza Night",
    event_date: TARGET,
    start_time: "18:00",
    end_time: "20:00",
    start_utc: "2025-03-12T23:00:00Z",
    end_utc: "2025-03-13T01:00:00Z",
    ends_next_day: 0,
    location: "Sarratt Student Center 216",
    organizer: "Student Life",
    rsvp_required: null,
    rsvp_url: null,
    rsvp_link_ok: null,
    event_url: "https://anchorlink.vanderbilt.edu/event/100001",
    food_confirmed: "confirmed",
    food_category: "full_meal",
    food_description: "Free pizza and salad provided.",
    verification_state: "partially_verified",
    confidence: 0.3,
    score_total: 0.755,
    explanation: "Ranked high",
    walking_label: "Walking time unavailable",
    rank: 1,
    created_at: "2025-03-11T06:00:00Z",
    updated_at: "2025-03-11T06:00:00Z",
    ...overrides,
  };
}

function statementsIn(db: FakeDb, fragment: string) {
  return db.batches.flat().filter((entry) => entry.sql.includes(fragment));
}

test("a successful refresh publishes the whole day in one atomic batch", async () => {
  const db = new FakeDb();
  db.prepare = patchLease(db);

  const repository = new Repository(db, config());
  const result = await runRefresh({
    repository,
    config: config(),
    trigger: "test",
    nowMs: NOW,
    fetcher: fakeFetcher([
      { skip: 0, body: searchPage([anchorRow({ id: 100001 }), anchorRow({ id: 100002 })]) },
    ]),
  });

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.summary.targetDate, TARGET);
  assert.equal(result.summary.published, 2);
  // Both events are brand new, because nothing had been published for the day.
  assert.equal(result.summary.changes.new, 2);

  // Exactly one publish batch, so the swap is a single transaction. Read batches
  // are separate and do not write.
  const publishBatches = db.batches.filter((entries) =>
    entries.some((entry) => entry.sql.startsWith("INSERT INTO feeds")),
  );
  assert.equal(publishBatches.length, 1);
  const batch = publishBatches[0];

  // Ownership of the refresh lease is re-checked inside the publish transaction,
  // before anything is deleted.
  assert.ok(batch[0].sql.startsWith("INSERT INTO app_state"));
  assert.ok(batch[0].sql.includes("FROM refresh_lease"));

  // The day is cleared before the new rows go in, inside the same batch.
  const deleteIndex = batch.findIndex((s) => s.sql.startsWith("DELETE FROM events"));
  const insertIndex = batch.findIndex((s) => s.sql.startsWith("INSERT INTO events"));
  assert.ok(deleteIndex >= 0 && insertIndex > deleteIndex);

  // Every table that makes a result explainable is written.
  for (const table of [
    "INSERT INTO events",
    "INSERT INTO source_records",
    "INSERT INTO field_provenance",
    "INSERT INTO score_components",
    "INSERT OR REPLACE INTO event_changes",
    "INSERT INTO feeds",
  ]) {
    assert.ok(statementsIn(db, table).length > 0, `missing ${table}`);
  }

  // Raw source JSON is preserved, not discarded after parsing.
  const sourceInsert = statementsIn(db, "INSERT INTO source_records")[0];
  assert.ok(
    sourceInsert.values.some(
      (value) => typeof value === "string" && value.includes('"benefitNames"'),
    ),
  );

  // Retention is bounded on every publish.
  assert.ok(statementsIn(db, "DELETE FROM feeds").length > 0);
  assert.ok(statementsIn(db, "DELETE FROM event_history WHERE changed_at <").length > 0);
  assert.ok(statementsIn(db, "DELETE FROM refresh_runs").length > 0);

  // No statement exceeds D1's bound-parameter limit.
  for (const statement of batch) {
    assert.ok(
      statement.values.length <= 100,
      `${statement.values.length} bound params in: ${statement.sql.slice(0, 60)}`,
    );
  }
});

test("a source failure keeps the previous feed and writes no publish batch", async () => {
  const db = new FakeDb();
  db.prepare = patchLease(db);

  const repository = new Repository(db, config());
  const result = await runRefresh({
    repository,
    config: config(),
    trigger: "test",
    nowMs: NOW,
    fetcher: fakeFetcher([{ skip: 0, body: null, ok: false, status: 503 }]),
  });

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.kind === "source");

  // Nothing touched the feed; the only batch is the failure log plus retention.
  assert.equal(statementsIn(db, "DELETE FROM events").length, 0);
  assert.equal(statementsIn(db, "INSERT INTO events").length, 0);
  assert.equal(statementsIn(db, "INSERT INTO feeds").length, 0);
  const runRows = statementsIn(db, "INSERT OR REPLACE INTO refresh_runs");
  assert.equal(runRows.length, 1);
  assert.ok(runRows[0].values.includes("source_error"));
});

test("a malformed row fails the refresh instead of publishing a shortened day", async () => {
  const db = new FakeDb();
  db.prepare = patchLease(db);
  const repository = new Repository(db, config());

  const result = await runRefresh({
    repository,
    config: config(),
    trigger: "test",
    nowMs: NOW,
    fetcher: fakeFetcher([
      { skip: 0, body: searchPage([anchorRow({ id: 1 }), anchorRow({ id: "not-a-number" })]) },
    ]),
  });

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.kind === "source");
  assert.equal(statementsIn(db, "INSERT INTO events").length, 0);
});

test("a second refresh cannot claim a held lease", async () => {
  // The conditional claim writes nothing while the lease is live, so RETURNING
  // yields no row and the holder comparison fails.
  const db = new FakeDb({
    firstRows: [
      { match: "SELECT expires_at FROM refresh_lease", row: { expires_at: NOW + 120000 } },
    ],
  });
  const repository = new Repository(db, config());

  const result = await runRefresh({
    repository,
    config: config(),
    trigger: "test",
    nowMs: NOW,
    fetcher: fakeFetcher([{ skip: 0, body: searchPage([anchorRow()]) }]),
  });

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.kind === "locked");
  assert.ok(!result.ok && result.kind === "locked" && result.retryAfterSeconds > 0);
  // A blocked refresh must not fetch the source or write anything.
  assert.equal(statementsIn(db, "INSERT INTO events").length, 0);
});

test("the lease is released after a successful refresh", async () => {
  const db = new FakeDb();
  db.prepare = patchLease(db);
  const repository = new Repository(db, config());

  await runRefresh({
    repository,
    config: config(),
    trigger: "test",
    nowMs: NOW,
    fetcher: fakeFetcher([{ skip: 0, body: searchPage([]) }]),
  });

  const release = db.executed.filter((entry) =>
    entry.sql.includes("UPDATE refresh_lease SET expires_at = 0"),
  );
  assert.equal(release.length, 1);
  // Only the holder that claimed it may release it.
  assert.equal(release[0].values.length, 2);
});

test("a genuine zero-match day publishes an empty feed rather than failing", async () => {
  const db = new FakeDb();
  db.prepare = patchLease(db);
  const repository = new Repository(db, config());

  const result = await runRefresh({
    repository,
    config: config(),
    trigger: "test",
    nowMs: NOW,
    fetcher: fakeFetcher([{ skip: 0, body: searchPage([], 0) }]),
  });

  assert.ok(result.ok);
  assert.equal(result.summary.published, 0);
  // The feed row still exists, which is what makes "empty" distinguishable from
  // "never published".
  const feedInsert = statementsIn(db, "INSERT INTO feeds");
  assert.equal(feedInsert.length, 1);
  assert.ok(feedInsert[0].values.includes(0));
  assert.equal(statementsIn(db, "INSERT INTO events").length, 0);
});

test("a time change is classified and recorded without creating a duplicate", async () => {
  const db = new FakeDb({
    firstRows: [{ match: "SELECT target_date FROM feeds", row: { target_date: TARGET } }],
    allRows: [{ match: "SELECT * FROM events WHERE feed_date", rows: [storedEventRow()] }],
  });
  db.prepare = patchLease(db);
  const repository = new Repository(db, config());

  const result = await runRefresh({
    repository,
    config: config(),
    trigger: "test",
    nowMs: NOW,
    fetcher: fakeFetcher([
      {
        skip: 0,
        body: searchPage([
          anchorRow({
            id: 100001,
            // Moved an hour later than the stored publication.
            startsOn: "2025-03-13T00:00:00Z",
            endsOn: "2025-03-13T02:00:00Z",
          }),
        ]),
      },
    ]),
  });

  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.summary.published, 1);
  assert.equal(result.summary.changes.time_changed, 1);
  assert.equal(result.summary.changes.new, 0);

  const changeRows = statementsIn(db, "INSERT OR REPLACE INTO event_changes");
  assert.equal(changeRows.length, 1);
  assert.ok(changeRows[0].values.includes("time_changed"));

  // The change is also recorded in history, keyed on the stable identity.
  const historyRows = statementsIn(db, "INSERT OR REPLACE INTO event_history");
  assert.equal(historyRows.length, 1);
  assert.ok(historyRows[0].values.includes("startTime"));

  // The creation stamp carries forward, so this is an update rather than a new
  // event that happens to look similar.
  const eventInsert = statementsIn(db, "INSERT INTO events")[0];
  assert.ok(eventInsert.values.includes("2025-03-11T06:00:00Z"));
});

test("an event that stops being listed is not treated as cancelled", async () => {
  const stored: Event = {
    id: "source|anchorlink:1",
    dedupKey: "k",
    identityKey: "source|anchorlink:1",
    anchorlinkId: "1",
    title: "Gone",
    eventDate: TARGET,
    startTime: "18:00",
    endTime: "20:00",
    startUtc: null,
    endUtc: null,
    endsNextDay: false,
    location: "Hall",
    locationGeo: null,
    organizer: null,
    rsvpRequired: null,
    rsvpUrl: null,
    rsvpLinkOk: null,
    eventUrl: null,
    foodConfirmed: FoodConfirmed.CONFIRMED,
    foodCategory: FoodCategory.FULL_MEAL,
    foodDescription: null,
    verificationState: VerificationState.PARTIALLY_VERIFIED,
    confidence: 0.3,
    scoreTotal: 0.7,
  };

  // The fresh run contains nothing. Change detection only classifies events that
  // are present, so a disappearance produces no classification at all, and
  // certainly not a cancellation.
  const changes = detectChanges([], [stored]);
  assert.equal(changes.size, 0);
  assert.equal(changes.get(stored.identityKey), undefined);
});

test("change classification follows the documented precedence", () => {
  const base: Event = {
    id: "a",
    dedupKey: "k",
    identityKey: "source|anchorlink:1",
    anchorlinkId: "1",
    title: "Event",
    eventDate: TARGET,
    startTime: "18:00",
    endTime: "20:00",
    startUtc: null,
    endUtc: null,
    endsNextDay: false,
    location: "Hall A",
    locationGeo: null,
    organizer: null,
    rsvpRequired: null,
    rsvpUrl: null,
    rsvpLinkOk: null,
    eventUrl: null,
    foodConfirmed: FoodConfirmed.CONFIRMED,
    foodCategory: FoodCategory.FULL_MEAL,
    foodDescription: null,
    verificationState: VerificationState.PARTIALLY_VERIFIED,
    confidence: 0.3,
    scoreTotal: 0.7,
  };

  assert.equal(detectChanges([base], null).get(base.identityKey)!.kind, "new");
  assert.equal(detectChanges([base], []).get(base.identityKey)!.kind, "new");
  assert.equal(detectChanges([base], [base]).get(base.identityKey)!.kind, "unchanged");
  assert.equal(
    detectChanges([{ ...base, startTime: "19:00" }], [base]).get(base.identityKey)!.kind,
    "time_changed",
  );
  assert.equal(
    detectChanges([{ ...base, location: "Hall B" }], [base]).get(base.identityKey)!.kind,
    "venue_changed",
  );
  // Cancellation outranks a simultaneous time change.
  assert.equal(
    detectChanges(
      [
        {
          ...base,
          startTime: "19:00",
          verificationState: VerificationState.CANCELLED,
        },
      ],
      [base],
    ).get(base.identityKey)!.kind,
    "cancelled",
  );

  // The verification-state field is left to the dedicated cancellation marker.
  const entries = diffHistory(
    base,
    { ...base, verificationState: VerificationState.CANCELLED },
    "2025-03-11T18:00:00Z",
  );
  assert.equal(entries.length, 0);
});

test("a refresh span starts today in local time and covers the requested days", async () => {
  // 2025-03-12 04:30 UTC is still the evening of March 11 in Chicago, so "today"
  // is the local date, not the UTC one.
  const lateEvening = Date.UTC(2025, 2, 12, 4, 30);
  for (const [days, expected] of [
    [1, ["2025-03-11"]],
    [2, ["2025-03-11", "2025-03-12"]],
    [7, ["2025-03-11", "2025-03-12", "2025-03-13", "2025-03-14", "2025-03-15", "2025-03-16", "2025-03-17"]],
  ] as const) {
    const db = new FakeDb();
    db.prepare = patchLease(db);
    const fetcher = fakeFetcher([{ skip: 0, body: searchPage([]) }]);
    const result = await runRefresh({
      repository: new Repository(db, config()),
      config: config(),
      trigger: "test",
      days,
      nowMs: lateEvening,
      fetcher,
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.summary.targetDate, "2025-03-11");
    assert.deepEqual(result.summary.days, expected);
    // One source query per requested day, and exactly one publish batch.
    assert.equal(fetcher.calls.length, days);
    const publishBatches = db.batches.filter((entries) =>
      entries.some((entry) => entry.sql.startsWith("INSERT INTO feeds")),
    );
    assert.equal(publishBatches.length, 1);
    assert.equal(
      publishBatches[0].filter((entry) => entry.sql.startsWith("INSERT INTO feeds")).length,
      days,
    );
  }
  assert.equal(config().timezone, CHICAGO);
});

/**
 * Make the fake conditional lease claim behave like the real one: succeed and
 * return the holder that was just bound.
 */
function patchLease(db: FakeDb) {
  const originalPrepare = db.prepare.bind(db);
  return (query: string) => {
    const statement = originalPrepare(query);
    if (query.includes("INSERT INTO refresh_lease")) {
      const originalFirst = statement.first.bind(statement);
      statement.first = async <T>() => {
        await originalFirst<T>();
        return { holder: (statement as unknown as { values: unknown[] }).values[1] } as T;
      };
    }
    return statement;
  };
}
