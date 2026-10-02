/**
 * Durable schema for Vandy Food Radar.
 *
 * The published feed is the only thing the read paths ever look at. A refresh
 * computes an entire target day in memory and swaps it in through one D1
 * batch, so a partially ingested day can never become visible.
 *
 * Tables mirror the reference application's persistence model: canonical
 * events, the raw per-source rows they were built from, per-field provenance,
 * detected conflicts, the ranking breakdown, per-event history, and the
 * cross-run change classification.
 */

import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * One row per successfully published target day.
 *
 * The presence of a row is what distinguishes "this day has never been
 * ingested" (no row -> uninitialized) from "the source genuinely returned no
 * matching events" (row with eventCount 0).
 */
export const feeds = sqliteTable("feeds", {
  targetDate: text("target_date").primaryKey(),
  timezone: text("timezone").notNull(),
  targetWindow: text("target_window").notNull(),
  eventCount: integer("event_count").notNull(),
  publishedAt: text("published_at").notNull(),
  sourceTotal: integer("source_total").notNull().default(0),
  pagesFetched: integer("pages_fetched").notNull().default(0),
});

/** Canonical, verified, ranked events belonging to a published feed. */
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    feedDate: text("feed_date").notNull(),
    identityKey: text("identity_key").notNull(),
    dedupKey: text("dedup_key").notNull(),
    anchorlinkId: text("anchorlink_id"),
    title: text("title").notNull(),
    eventDate: text("event_date").notNull(),
    startTime: text("start_time"),
    endTime: text("end_time"),
    startUtc: text("start_utc"),
    endUtc: text("end_utc"),
    endsNextDay: integer("ends_next_day").notNull().default(0),
    location: text("location"),
    organizer: text("organizer"),
    rsvpRequired: integer("rsvp_required"),
    rsvpUrl: text("rsvp_url"),
    rsvpLinkOk: integer("rsvp_link_ok"),
    eventUrl: text("event_url"),
    foodConfirmed: text("food_confirmed").notNull(),
    foodCategory: text("food_category").notNull(),
    foodDescription: text("food_description"),
    verificationState: text("verification_state").notNull(),
    confidence: real("confidence"),
    scoreTotal: real("score_total"),
    explanation: text("explanation"),
    walkingLabel: text("walking_label").notNull(),
    rank: integer("rank").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("events_feed_date_idx").on(table.feedDate),
    index("events_anchorlink_id_idx").on(table.anchorlinkId),
    // The identity is the key `event_changes` is keyed on and the key change
    // detection and history look events up by, so a duplicate identity within a
    // day is a real data fault, not a cosmetic one: it would collapse two events
    // into one change badge and one history stream. The refresh derives the
    // identity from the provider-native event id, so this uniqueness holds; the
    // constraint is here to make a violation fail loudly instead of silently.
    uniqueIndex("events_feed_identity_idx").on(table.feedDate, table.identityKey),
  ],
);

/** Untouched source payloads retained for provenance and auditing. */
export const sourceRecords = sqliteTable(
  "source_records",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    feedDate: text("feed_date").notNull(),
    sourceId: text("source_id").notNull(),
    sourceUrl: text("source_url"),
    rawPayload: text("raw_payload"),
    parsedFields: text("parsed_fields"),
    checkedAt: text("checked_at"),
    parseStatus: text("parse_status").notNull(),
    sourceUpdatedAt: text("source_updated_at"),
  },
  (table) => [
    index("source_records_event_idx").on(table.eventId),
    index("source_records_feed_idx").on(table.feedDate),
  ],
);

/** How each canonical field value was chosen. */
export const fieldProvenance = sqliteTable(
  "field_provenance",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    feedDate: text("feed_date").notNull(),
    fieldName: text("field_name").notNull(),
    chosenValue: text("chosen_value"),
    chosenSourceId: text("chosen_source_id"),
    agreement: text("agreement").notNull(),
  },
  (table) => [
    index("field_provenance_event_idx").on(table.eventId),
    index("field_provenance_feed_idx").on(table.feedDate),
  ],
);

/** Preserved disagreements between sources, losing values included. */
export const conflicts = sqliteTable(
  "conflicts",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    feedDate: text("feed_date").notNull(),
    fieldName: text("field_name").notNull(),
    competingValues: text("competing_values").notNull(),
    resolution: text("resolution"),
  },
  (table) => [
    index("conflicts_event_idx").on(table.eventId),
    index("conflicts_feed_idx").on(table.feedDate),
  ],
);

/** Per-factor ranking breakdown so a score is always explainable. */
export const scoreComponents = sqliteTable(
  "score_components",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    feedDate: text("feed_date").notNull(),
    factor: text("factor").notNull(),
    rawValue: real("raw_value"),
    weight: real("weight").notNull(),
    contribution: real("contribution").notNull(),
    note: text("note"),
    position: integer("position").notNull(),
  },
  (table) => [
    index("score_components_event_idx").on(table.eventId),
    index("score_components_feed_idx").on(table.feedDate),
  ],
);

/**
 * Cross-run change classification for a published day, keyed on the stable
 * source identity. Written only by a refresh; reads never mutate it.
 */
export const eventChanges = sqliteTable(
  "event_changes",
  {
    feedDate: text("feed_date").notNull(),
    identityKey: text("identity_key").notNull(),
    kind: text("kind").notNull(),
    detail: text("detail"),
    detectedAt: text("detected_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.feedDate, table.identityKey] })],
);

/**
 * Append-only record of tracked detail changes. Retained across refreshes and
 * bounded by age so the table cannot grow without limit.
 */
export const eventHistory = sqliteTable(
  "event_history",
  {
    id: text("id").primaryKey(),
    identityKey: text("identity_key").notNull(),
    feedDate: text("feed_date").notNull(),
    changedAt: text("changed_at").notNull(),
    fieldName: text("field_name").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    reason: text("reason"),
  },
  (table) => [
    index("event_history_identity_idx").on(table.identityKey),
    index("event_history_changed_idx").on(table.changedAt),
  ],
);

/** Outcome of every refresh attempt, successful or not. Bounded retention. */
export const refreshRuns = sqliteTable(
  "refresh_runs",
  {
    id: text("id").primaryKey(),
    targetDate: text("target_date").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at").notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    trigger: text("trigger").notNull(),
    fetched: integer("fetched").notNull().default(0),
    published: integer("published").notNull().default(0),
    pagesFetched: integer("pages_fetched").notNull().default(0),
    changesJson: text("changes_json"),
    error: text("error"),
  },
  (table) => [index("refresh_runs_finished_idx").on(table.finishedAt)],
);

/**
 * Single-row advisory lease. A refresh claims it with an expiry so a crashed
 * or timed-out worker cannot block refreshes forever, and a conditional claim
 * keeps two overlapping refreshes from publishing over each other.
 */
export const refreshLease = sqliteTable("refresh_lease", {
  name: text("name").primaryKey(),
  holder: text("holder").notNull(),
  acquiredAt: text("acquired_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

/** Small key/value table for durable operational markers. */
export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
