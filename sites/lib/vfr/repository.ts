/**
 * Durable repository for published feeds.
 *
 * Read and write paths are deliberately asymmetric:
 *
 * - Reads only ever return what was published. There is no fallback corpus and
 *   no sample data; if nothing has been published the caller is told exactly
 *   that, and a storage failure surfaces as a failure rather than as an empty
 *   page.
 * - A write replaces every requested target day wholesale inside a single D1
 *   batch, which D1 executes as one transaction. The caller computes all of the
 *   days first, so a half-ingested day is never visible, a failed run leaves the
 *   previously published feed exactly as it was, and a day that was not part of
 *   the refresh is never touched.
 *
 * Retention is bounded on every successful publish: days outside the rolling
 * `[today - pastDays, today + futureDays]` window (requested days are always
 * kept), old history rows, and old refresh-run rows are trimmed so the database
 * cannot grow without limit.
 */

import type { ChangeRecord } from "./changes.ts";
import type { Config } from "./config.ts";
import { AI_KEY_PREFIX } from "./intelligence.ts";
import type { AiState } from "./intelligence.ts";
import {
  batchRows,
  boolToInt,
  buildInsertStatements,
  intToBool,
  withStorage,
} from "./d1.ts";
import type { ColumnSpec, D1Like, D1StatementLike } from "./d1.ts";
import type {
  ChangeKind,
  Conflict,
  Event,
  EventHistoryEntry,
  FieldAgreement,
  FieldProvenance,
  FoodCategory,
  FoodConfirmed,
  ParseStatus,
  ScoreComponent,
  ScoreFactor,
  SourceId,
  SourceRecord,
  VerificationState,
} from "./models.ts";
import { shiftIsoDate } from "./time.ts";

const LEASE_NAME = "refresh";

/**
 * Operational key written by every publish.
 *
 * Its value comes from a scalar sub-select of the publisher's own lease row, and
 * `app_state.value` is `NOT NULL`, so a publisher that no longer holds the lease
 * writes NULL and the whole batch is rolled back. See `publishFeed`.
 */
const PUBLISH_FENCE_KEY = "refresh:publisher";

/** Operational key recording the last complete successful refresh. */
export const LAST_SUCCESS_KEY = "refresh:last_success";

export type LastSuccess = { at: string; days: string[] };

/** One source row as read back for display. */
export type StoredSource = {
  sourceId: SourceId;
  sourceUrl: string | null;
  checkedAt: string | null;
  rawPayload: string | null;
  parsedFields: Record<string, unknown>;
};

/** Everything one published event carries, assembled for display or export. */
export type StoredEvent = {
  event: Event;
  rank: number;
  explanation: string;
  walkingLabel: string;
  components: ScoreComponent[];
  conflicts: Conflict[];
  provenance: FieldProvenance[];
  sources: StoredSource[];
  change: ChangeRecord | null;
  history: EventHistoryEntry[];
};

export type FeedSnapshot = {
  targetDate: string;
  timezone: string;
  targetWindow: string;
  publishedAt: string;
  eventCount: number;
  sourceTotal: number;
  events: StoredEvent[];
};

/** One fully computed target day inside a publication. */
export type DayPublication = {
  targetDate: string;
  sourceTotal: number;
  pagesFetched: number;
  events: {
    event: Event;
    rank: number;
    explanation: string;
    walkingLabel: string;
    components: ScoreComponent[];
    conflicts: Conflict[];
    provenance: FieldProvenance[];
    sources: SourceRecord[];
    /** `detectedAt` is carried forward while a change warning is still live. */
    change: ChangeRecord & { detectedAt: string };
    createdAt: string;
  }[];
  history: EventHistoryEntry[];
};

/** Every requested day of one refresh, ready to be swapped in atomically. */
export type PublishPayload = {
  timezone: string;
  targetWindow: string;
  publishedAt: string;
  /** Local "today" the retention window is anchored on. */
  todayDate: string;
  /**
   * The refresh lease holder that produced this payload. Validated inside the
   * publish transaction so a superseded run cannot overwrite a newer feed.
   */
  leaseHolder: string;
  days: DayPublication[];
  run: RefreshRunRecord;
};

/** A published event plus what change detection needs from the last run. */
export type PreviousEvent = {
  event: Event;
  createdAt: string;
  change: ChangeRecord | null;
};

export type RefreshRunRecord = {
  id: string;
  targetDate: string;
  status: "success" | "source_error" | "storage_error" | "skipped";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  trigger: string;
  fetched: number;
  published: number;
  pagesFetched: number;
  changesJson: string | null;
  error: string | null;
};

type EventRow = {
  id: string;
  feed_date: string;
  identity_key: string;
  dedup_key: string;
  anchorlink_id: string | null;
  title: string;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  start_utc: string | null;
  end_utc: string | null;
  ends_next_day: number;
  location: string | null;
  organizer: string | null;
  rsvp_required: number | null;
  rsvp_url: string | null;
  rsvp_link_ok: number | null;
  event_url: string | null;
  food_confirmed: string;
  food_category: string;
  food_description: string | null;
  verification_state: string;
  confidence: number | null;
  score_total: number | null;
  explanation: string | null;
  walking_label: string;
  rank: number;
  created_at: string;
  updated_at: string;
};

type ComponentRow = {
  event_id: string;
  factor: string;
  raw_value: number | null;
  weight: number;
  contribution: number;
  note: string | null;
};

type ConflictRow = {
  event_id: string;
  field_name: string;
  competing_values: string;
  resolution: string | null;
};

type ProvenanceRow = {
  event_id: string;
  field_name: string;
  chosen_value: string | null;
  chosen_source_id: string | null;
  agreement: string;
};

type SourceRow = {
  event_id: string;
  source_id: string;
  source_url: string | null;
  checked_at: string | null;
  raw_payload: string | null;
  parsed_fields: string | null;
};

type ChangeRow = {
  identity_key: string;
  kind: string;
  detail: string | null;
  detected_at: string | null;
};

function changeFromRow(row: ChangeRow): ChangeRecord {
  return { kind: row.kind as ChangeKind, detail: row.detail, detectedAt: row.detected_at };
}

type FeedRow = {
  target_date: string;
  timezone: string;
  target_window: string;
  event_count: number;
  published_at: string;
  source_total: number;
};

function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    dedupKey: row.dedup_key,
    identityKey: row.identity_key,
    anchorlinkId: row.anchorlink_id,
    title: row.title,
    eventDate: row.event_date,
    startTime: row.start_time,
    endTime: row.end_time,
    startUtc: row.start_utc,
    endUtc: row.end_utc,
    endsNextDay: row.ends_next_day !== 0,
    location: row.location,
    locationGeo: null,
    organizer: row.organizer,
    rsvpRequired: intToBool(row.rsvp_required),
    rsvpUrl: row.rsvp_url,
    rsvpLinkOk: intToBool(row.rsvp_link_ok),
    eventUrl: row.event_url,
    foodConfirmed: row.food_confirmed as FoodConfirmed,
    foodCategory: row.food_category as FoodCategory,
    foodDescription: row.food_description,
    verificationState: row.verification_state as VerificationState,
    confidence: row.confidence,
    scoreTotal: row.score_total,
  };
}

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Group rows by the event they belong to, preserving query order. */
function groupByEvent<Row extends { event_id: string }>(rows: Row[]): Map<string, Row[]> {
  const map = new Map<string, Row[]>();
  for (const row of rows) {
    const bucket = map.get(row.event_id);
    if (bucket) bucket.push(row);
    else map.set(row.event_id, [row]);
  }
  return map;
}

export class Repository {
  private readonly db: D1Like;
  private readonly config: Config;

  constructor(db: D1Like, config: Config) {
    this.db = db;
    this.config = config;
  }

  async readAiState(date: string): Promise<AiState | null> {
    const row = await this.db.prepare("SELECT value FROM app_state WHERE key = ?")
      .bind(`${AI_KEY_PREFIX}${date}`).first<{value: string}>();
    return safeJsonParse<AiState | null>(row?.value ?? null, null);
  }

  /** Persist attempts before inference, fenced by the existing refresh lease. */
  async saveAiState(date: string, state: AiState, holder: string): Promise<void> {
    await this.db.batch([
      this.db.prepare(`INSERT INTO app_state (key,value,updated_at)
        VALUES (?, (SELECT holder FROM refresh_lease WHERE name = ? AND holder = ? AND expires_at > 0), ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(PUBLISH_FENCE_KEY,LEASE_NAME,holder,state.attemptedAt),
      this.db.prepare(`INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(`${AI_KEY_PREFIX}${date}`,JSON.stringify(state),state.attemptedAt),
    ]);
  }

  /** Lightweight connectivity probe used by the health route. */
  async probe(): Promise<{ feedCount: number; lastPublishedAt: string | null }> {
    return withStorage("probe durable storage", async () => {
      const row = await this.db
        .prepare(
          "SELECT COUNT(*) AS feed_count, MAX(published_at) AS last_published_at FROM feeds",
        )
        .first<{ feed_count: number; last_published_at: string | null }>();
      return {
        feedCount: row?.feed_count ?? 0,
        lastPublishedAt: row?.last_published_at ?? null,
      };
    });
  }

  /** The most recent successful or failed refresh attempt, if any. */
  async lastRun(): Promise<RefreshRunRecord | null> {
    return withStorage("read refresh history", async () => {
      const row = await this.db
        .prepare(
          `SELECT id, target_date, status, started_at, finished_at, duration_ms,
                  "trigger", fetched, published, pages_fetched, changes_json, error
             FROM refresh_runs
            ORDER BY finished_at DESC, id DESC
            LIMIT 1`,
        )
        .first<{
          id: string;
          target_date: string;
          status: string;
          started_at: string;
          finished_at: string;
          duration_ms: number;
          trigger: string;
          fetched: number;
          published: number;
          pages_fetched: number;
          changes_json: string | null;
          error: string | null;
        }>();
      if (!row) return null;
      return {
        id: row.id,
        targetDate: row.target_date,
        status: row.status as RefreshRunRecord["status"],
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        durationMs: row.duration_ms,
        trigger: row.trigger,
        fetched: row.fetched,
        published: row.published,
        pagesFetched: row.pages_fetched,
        changesJson: row.changes_json,
        error: row.error,
      };
    });
  }

  /**
   * Canonical events of a published day plus their creation stamps, for change
   * detection and for carrying `createdAt` forward across refreshes.
   *
   * The existence check and the rows are read in one batch, so a publish that
   * commits mid-read cannot make this report a day as published while returning
   * another publication's events.
   */
  async readPublishedEvents(targetDate: string): Promise<PreviousEvent[] | null> {
    return withStorage("read published events", async () => {
      const [feedRows, eventRows, changeRows] = batchRows(
        await this.db.batch([
          this.db
            .prepare("SELECT target_date FROM feeds WHERE target_date = ?")
            .bind(targetDate),
          this.db
            .prepare("SELECT * FROM events WHERE feed_date = ? ORDER BY `rank` ASC")
            .bind(targetDate),
          this.db
            .prepare(
              "SELECT identity_key, kind, detail, detected_at FROM event_changes WHERE feed_date = ?",
            )
            .bind(targetDate),
        ]),
      );
      if (feedRows.length === 0) return null;
      const changes = new Map(
        (changeRows as ChangeRow[]).map((row) => [row.identity_key, changeFromRow(row)]),
      );
      return (eventRows as EventRow[]).map((row) => ({
        event: rowToEvent(row),
        createdAt: row.created_at,
        change: changes.get(row.identity_key) ?? null,
      }));
    });
  }

  /** The last complete successful refresh, if one has been recorded. */
  async lastSuccess(): Promise<LastSuccess | null> {
    return withStorage("read refresh metadata", async () => {
      const row = await this.db
        .prepare("SELECT value FROM app_state WHERE key = ?")
        .bind(LAST_SUCCESS_KEY)
        .first<{ value: string }>();
      const parsed = safeJsonParse<unknown>(row?.value ?? null, null);
      if (typeof parsed !== "object" || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      if (typeof record.at !== "string" || !Array.isArray(record.days)) return null;
      return {
        at: record.at,
        days: record.days.filter((day): day is string => typeof day === "string"),
      };
    });
  }

  /**
   * Load a complete published day.
   *
   * The metadata and every child table a card needs are read in one D1 batch,
   * which D1 runs as a transaction. A refresh committing concurrently therefore
   * cannot produce a view that mixes one publication's metadata with another's
   * cards, scores, or provenance.
   *
   * Retained history is read separately and deliberately: it is an append-only
   * advisory list spanning many publications, so its contents do not affect
   * whether the displayed day is internally consistent.
   *
   * Returns `null` when the day has never been published, which the routes
   * report as uninitialized rather than as an empty result.
   */
  async readFeed(
    targetDate: string,
    options: { history?: boolean } = {},
  ): Promise<FeedSnapshot | null> {
    return withStorage("read published feed", async () => {
      const [
        feedRows,
        eventRows,
        componentRows,
        conflictRows,
        provenanceRows,
        sourceRows,
        changeRows,
      ] = batchRows(
        await this.db.batch([
          this.db
            .prepare(
              `SELECT target_date, timezone, target_window, event_count, published_at, source_total
                 FROM feeds WHERE target_date = ?`,
            )
            .bind(targetDate),
          this.db
            .prepare("SELECT * FROM events WHERE feed_date = ? ORDER BY `rank` ASC")
            .bind(targetDate),
          this.db
            .prepare(
              `SELECT event_id, factor, raw_value, weight, contribution, note
                 FROM score_components WHERE feed_date = ? ORDER BY event_id, position ASC`,
            )
            .bind(targetDate),
          this.db
            .prepare(
              `SELECT event_id, field_name, competing_values, resolution
                 FROM conflicts WHERE feed_date = ? ORDER BY event_id, field_name`,
            )
            .bind(targetDate),
          this.db
            .prepare(
              `SELECT event_id, field_name, chosen_value, chosen_source_id, agreement
                 FROM field_provenance WHERE feed_date = ? ORDER BY event_id, rowid`,
            )
            .bind(targetDate),
          this.db
            .prepare(
              `SELECT event_id, source_id, source_url, checked_at, raw_payload, parsed_fields
                 FROM source_records WHERE feed_date = ? ORDER BY event_id, source_id`,
            )
            .bind(targetDate),
          this.db
            .prepare(
              "SELECT identity_key, kind, detail, detected_at FROM event_changes WHERE feed_date = ?",
            )
            .bind(targetDate),
        ]),
      );

      const feed = (feedRows as FeedRow[])[0];
      if (feed === undefined) return null;

      const events = eventRows as EventRow[];
      const componentsByEvent = groupByEvent(componentRows as ComponentRow[]);
      const conflictsByEvent = groupByEvent(conflictRows as ConflictRow[]);
      const provenanceByEvent = groupByEvent(provenanceRows as ProvenanceRow[]);
      const sourcesByEvent = groupByEvent(sourceRows as SourceRow[]);

      const changeByIdentity = new Map<string, ChangeRecord>();
      for (const row of changeRows as ChangeRow[]) {
        changeByIdentity.set(row.identity_key, changeFromRow(row));
      }

      const historyByIdentity =
        options.history === false
          ? new Map<string, EventHistoryEntry[]>()
          : await this.readHistoryFor(events.map((row) => row.identity_key));

      const stored: StoredEvent[] = events.map((row) => ({
        event: rowToEvent(row),
        rank: row.rank,
        explanation: row.explanation ?? "",
        walkingLabel: row.walking_label,
        components: (componentsByEvent.get(row.id) ?? []).map((c) => ({
          factor: c.factor as ScoreFactor,
          rawValue: c.raw_value ?? 0,
          weight: c.weight,
          contribution: c.contribution,
          note: c.note ?? "",
        })),
        conflicts: (conflictsByEvent.get(row.id) ?? []).map((c) => ({
          fieldName: c.field_name,
          competingValues: safeJsonParse(c.competing_values, []),
          resolution: c.resolution,
        })),
        provenance: (provenanceByEvent.get(row.id) ?? []).map((p) => ({
          fieldName: p.field_name,
          chosenValue: safeJsonParse<unknown>(p.chosen_value, null),
          chosenSourceId: (p.chosen_source_id as SourceId | null) ?? null,
          agreement: p.agreement as FieldAgreement,
        })),
        sources: (sourcesByEvent.get(row.id) ?? []).map((s) => ({
          sourceId: s.source_id as SourceId,
          sourceUrl: s.source_url,
          checkedAt: s.checked_at,
          rawPayload: s.raw_payload,
          parsedFields: safeJsonParse<Record<string, unknown>>(s.parsed_fields, {}),
        })),
        change: changeByIdentity.get(row.identity_key) ?? null,
        history: historyByIdentity.get(row.identity_key) ?? [],
      }));

      return {
        targetDate: feed.target_date,
        timezone: feed.timezone,
        targetWindow: feed.target_window,
        publishedAt: feed.published_at,
        eventCount: feed.event_count,
        sourceTotal: feed.source_total,
        events: stored,
      };
    });
  }

  private async readHistoryFor(
    identityKeys: string[],
  ): Promise<Map<string, EventHistoryEntry[]>> {
    const byIdentity = new Map<string, EventHistoryEntry[]>();
    if (identityKeys.length === 0) return byIdentity;
    const unique = [...new Set(identityKeys)];
    // Chunked so the IN list never exceeds the bound-parameter limit.
    for (let offset = 0; offset < unique.length; offset += 50) {
      const chunk = unique.slice(offset, offset + 50);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = await this.db
        .prepare(
          `SELECT identity_key, changed_at, field_name, old_value, new_value, reason
             FROM event_history
            WHERE identity_key IN (${placeholders})
            ORDER BY changed_at DESC
            LIMIT 200`,
        )
        .bind(...chunk)
        .all<{
          identity_key: string;
          changed_at: string;
          field_name: string;
          old_value: string | null;
          new_value: string | null;
          reason: string | null;
        }>();
      for (const row of rows.results) {
        const entry: EventHistoryEntry = {
          identityKey: row.identity_key,
          changedAt: row.changed_at,
          fieldName: row.field_name,
          oldValue: row.old_value,
          newValue: row.new_value,
          reason: row.reason ?? "",
        };
        const bucket = byIdentity.get(row.identity_key);
        if (bucket) bucket.push(entry);
        else byIdentity.set(row.identity_key, [entry]);
      }
    }
    return byIdentity;
  }

  /**
   * Find a published event by its AnchorLink id. With `feedDate` the lookup is
   * scoped to that one published day and never crosses into another; without
   * it the newest published day wins.
   */
  async findEventByAnchorlinkId(
    anchorlinkId: string,
    feedDate?: string,
  ): Promise<Event | null> {
    return withStorage("look up event", async () => {
      const statement = feedDate
        ? this.db
            .prepare("SELECT * FROM events WHERE anchorlink_id = ? AND feed_date = ? LIMIT 1")
            .bind(anchorlinkId, feedDate)
        : this.db
            .prepare(
              "SELECT * FROM events WHERE anchorlink_id = ? ORDER BY feed_date DESC LIMIT 1",
            )
            .bind(anchorlinkId);
      const row = await statement.first<EventRow>();
      return row ? rowToEvent(row) : null;
    });
  }

  /**
   * Claim the refresh lease.
   *
   * The claim is conditional in SQL: it succeeds only when no lease row exists
   * or the existing one has expired. Two overlapping refreshes therefore cannot
   * both proceed and publish over each other, and because the lease carries an
   * expiry, a worker that dies mid-refresh cannot block refreshes permanently.
   */
  async claimLease(holder: string, nowMs: number): Promise<boolean> {
    return withStorage("claim refresh lease", async () => {
      const expiresAt = nowMs + this.config.leaseTtlMs;
      const row = await this.db
        .prepare(
          `INSERT INTO refresh_lease (name, holder, acquired_at, expires_at)
                VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE
                  SET holder = excluded.holder,
                      acquired_at = excluded.acquired_at,
                      expires_at = excluded.expires_at
                WHERE refresh_lease.expires_at <= ?
             RETURNING holder`,
        )
        .bind(LEASE_NAME, holder, new Date(nowMs).toISOString(), expiresAt, nowMs)
        .first<{ holder: string }>();
      return row?.holder === holder;
    });
  }

  /** Release the lease, but only if this holder still owns it. */
  async releaseLease(holder: string): Promise<void> {
    await withStorage("release refresh lease", async () => {
      await this.db
        .prepare("UPDATE refresh_lease SET expires_at = 0 WHERE name = ? AND holder = ?")
        .bind(LEASE_NAME, holder)
        .run();
      return null;
    });
  }

  /** When the current lease expires, or `null` if none is held. */
  async leaseExpiresAt(): Promise<number | null> {
    return withStorage("read refresh lease", async () => {
      const row = await this.db
        .prepare("SELECT expires_at FROM refresh_lease WHERE name = ?")
        .bind(LEASE_NAME)
        .first<{ expires_at: number }>();
      return row?.expires_at ?? null;
    });
  }

  /**
   * Record a refresh attempt that produced no publication.
   *
   * Only the run log is touched, so the previously published feed survives a
   * source outage or a storage write failure untouched.
   */
  async recordRun(run: RefreshRunRecord): Promise<void> {
    await withStorage("record refresh run", async () => {
      await this.db.batch([
        ...this.runInsertStatements(run),
        ...this.runRetentionStatements(),
      ]);
      return null;
    });
  }

  /**
   * Replace every requested day with its fully computed feed in a single
   * transaction.
   *
   * The first statement is a fence: it writes `app_state.value` from a scalar
   * sub-select of this publisher's own lease row. `app_state.value` is NOT NULL,
   * so if the lease has been taken over by another holder or released, the
   * sub-select yields NULL and the statement fails, rolling the entire batch
   * back before anything is deleted or inserted. A refresh that overran its
   * lease therefore cannot overwrite the newer feed that superseded it.
   *
   * Then, for each requested day only, the day's existing rows are deleted and
   * the new ones inserted. A day outside the request is never deleted here; it
   * can only age out through the bounded retention window. Finally the
   * last-success marker, the run, and retention are written. D1 executes a
   * batch as one transaction, so either every requested day is swapped in or
   * nothing changes.
   */
  async publishFeed(payload: PublishPayload): Promise<void> {
    if (payload.days.length === 0) throw new Error("refusing to publish an empty refresh");
    const dates = new Set<string>();
    for (const day of payload.days) {
      if (dates.has(day.targetDate)) {
        throw new Error(`refusing to publish ${day.targetDate} twice in one refresh`);
      }
      dates.add(day.targetDate);
      if (day.events.length > this.config.maxEventsPerFeed) {
        throw new Error(
          `refusing to publish ${day.events.length} events for ${day.targetDate}; ` +
            `cap is ${this.config.maxEventsPerFeed}`,
        );
      }
    }

    await withStorage("publish feed", async () => {
      const db = this.db;
      const statements: D1StatementLike[] = [this.leaseFenceStatement(payload)];

      for (const day of payload.days) {
        const date = day.targetDate;
        for (const table of [
          "events",
          "source_records",
          "field_provenance",
          "conflicts",
          "score_components",
          "event_changes",
        ]) {
          statements.push(db.prepare(`DELETE FROM ${table} WHERE feed_date = ?`).bind(date));
        }

        statements.push(
          db
            .prepare(
              `INSERT INTO feeds (target_date, timezone, target_window, event_count,
                                  published_at, source_total, pages_fetched)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(target_date) DO UPDATE
                      SET timezone = excluded.timezone,
                          target_window = excluded.target_window,
                          event_count = excluded.event_count,
                          published_at = excluded.published_at,
                          source_total = excluded.source_total,
                          pages_fetched = excluded.pages_fetched`,
            )
            .bind(
              date,
              payload.timezone,
              payload.targetWindow,
              day.events.length,
              payload.publishedAt,
              day.sourceTotal,
              day.pagesFetched,
            ),
        );

        statements.push(...this.eventInsertStatements(payload, day));
        statements.push(...this.sourceInsertStatements(day));
        statements.push(...this.provenanceInsertStatements(day));
        statements.push(...this.conflictInsertStatements(day));
        statements.push(...this.componentInsertStatements(day));
        statements.push(...this.changeInsertStatements(day));
        statements.push(...this.historyInsertStatements(payload, day));
      }

      statements.push(
        db
          .prepare(
            `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE
                    SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .bind(
            LAST_SUCCESS_KEY,
            JSON.stringify({ at: payload.publishedAt, days: [...dates].sort() }),
            payload.publishedAt,
          ),
      );
      statements.push(...this.runInsertStatements(payload.run));
      statements.push(...this.retentionStatements(payload, [...dates]));

      await db.batch(statements);
      return null;
    });
  }

  /**
   * Transaction-fatal ownership check.
   *
   * `value` is a scalar sub-select of the lease row still held by this holder.
   * No matching row yields NULL, which violates `app_state.value NOT NULL` and
   * aborts the batch. `expires_at > 0` excludes a released lease; an expired but
   * never-superseded, never-released lease is still allowed to finish.
   */
  private leaseFenceStatement(payload: PublishPayload): D1StatementLike {
    return this.db
      .prepare(
        `INSERT INTO app_state (key, value, updated_at)
              VALUES (
                ?,
                (SELECT holder FROM refresh_lease
                   WHERE name = ? AND holder = ? AND expires_at > 0),
                ?
              )
         ON CONFLICT(key) DO UPDATE
                SET value = excluded.value,
                    updated_at = excluded.updated_at`,
      )
      .bind(PUBLISH_FENCE_KEY, LEASE_NAME, payload.leaseHolder, payload.publishedAt);
  }

  private eventInsertStatements(payload: PublishPayload, day: DayPublication): D1StatementLike[] {
    type Row = DayPublication["events"][number];
    const columns: ColumnSpec<Row>[] = [
      { name: "id", value: (r) => r.event.id },
      { name: "feed_date", value: () => day.targetDate },
      { name: "identity_key", value: (r) => r.event.identityKey },
      { name: "dedup_key", value: (r) => r.event.dedupKey },
      { name: "anchorlink_id", value: (r) => r.event.anchorlinkId },
      { name: "title", value: (r) => r.event.title },
      { name: "event_date", value: (r) => r.event.eventDate },
      { name: "start_time", value: (r) => r.event.startTime },
      { name: "end_time", value: (r) => r.event.endTime },
      { name: "start_utc", value: (r) => r.event.startUtc },
      { name: "end_utc", value: (r) => r.event.endUtc },
      { name: "ends_next_day", value: (r) => (r.event.endsNextDay ? 1 : 0) },
      { name: "location", value: (r) => r.event.location },
      { name: "organizer", value: (r) => r.event.organizer },
      { name: "rsvp_required", value: (r) => boolToInt(r.event.rsvpRequired) },
      { name: "rsvp_url", value: (r) => r.event.rsvpUrl },
      { name: "rsvp_link_ok", value: (r) => boolToInt(r.event.rsvpLinkOk) },
      { name: "event_url", value: (r) => r.event.eventUrl },
      { name: "food_confirmed", value: (r) => r.event.foodConfirmed },
      { name: "food_category", value: (r) => r.event.foodCategory },
      { name: "food_description", value: (r) => r.event.foodDescription },
      { name: "verification_state", value: (r) => r.event.verificationState },
      { name: "confidence", value: (r) => r.event.confidence },
      { name: "score_total", value: (r) => r.event.scoreTotal },
      { name: "explanation", value: (r) => r.explanation },
      { name: "walking_label", value: (r) => r.walkingLabel },
      { name: "`rank`", value: (r) => r.rank },
      { name: "created_at", value: (r) => r.createdAt },
      { name: "updated_at", value: () => payload.publishedAt },
    ];
    return buildInsertStatements(this.db, "events", columns, day.events);
  }

  private sourceInsertStatements(payload: DayPublication): D1StatementLike[] {
    type Row = { eventId: string; record: SourceRecord };
    const rows: Row[] = payload.events.flatMap((entry) =>
      entry.sources.map((record) => ({ eventId: entry.event.id, record })),
    );
    const columns: ColumnSpec<Row>[] = [
      { name: "id", value: (r) => `${payload.targetDate}:${r.record.id}` },
      { name: "event_id", value: (r) => r.eventId },
      { name: "feed_date", value: () => payload.targetDate },
      { name: "source_id", value: (r) => r.record.sourceId },
      { name: "source_url", value: (r) => r.record.sourceUrl },
      { name: "raw_payload", value: (r) => r.record.rawPayload },
      { name: "parsed_fields", value: (r) => JSON.stringify(r.record.parsedFields) },
      { name: "checked_at", value: (r) => r.record.checkedAt },
      { name: "parse_status", value: (r) => r.record.parseStatus satisfies ParseStatus },
      { name: "source_updated_at", value: (r) => r.record.sourceUpdatedAt },
    ];
    return buildInsertStatements(this.db, "source_records", columns, rows);
  }

  private provenanceInsertStatements(payload: DayPublication): D1StatementLike[] {
    type Row = { eventId: string; index: number; provenance: FieldProvenance };
    const rows: Row[] = payload.events.flatMap((entry) =>
      entry.provenance.map((provenance, index) => ({
        eventId: entry.event.id,
        index,
        provenance,
      })),
    );
    const columns: ColumnSpec<Row>[] = [
      { name: "id", value: (r) => `${payload.targetDate}:${r.eventId}:prov:${r.index}` },
      { name: "event_id", value: (r) => r.eventId },
      { name: "feed_date", value: () => payload.targetDate },
      { name: "field_name", value: (r) => r.provenance.fieldName },
      { name: "chosen_value", value: (r) => JSON.stringify(r.provenance.chosenValue ?? null) },
      { name: "chosen_source_id", value: (r) => r.provenance.chosenSourceId },
      { name: "agreement", value: (r) => r.provenance.agreement },
    ];
    return buildInsertStatements(this.db, "field_provenance", columns, rows);
  }

  private conflictInsertStatements(payload: DayPublication): D1StatementLike[] {
    type Row = { eventId: string; index: number; conflict: Conflict };
    const rows: Row[] = payload.events.flatMap((entry) =>
      entry.conflicts.map((conflict, index) => ({
        eventId: entry.event.id,
        index,
        conflict,
      })),
    );
    const columns: ColumnSpec<Row>[] = [
      { name: "id", value: (r) => `${payload.targetDate}:${r.eventId}:conf:${r.index}` },
      { name: "event_id", value: (r) => r.eventId },
      { name: "feed_date", value: () => payload.targetDate },
      { name: "field_name", value: (r) => r.conflict.fieldName },
      {
        name: "competing_values",
        value: (r) => JSON.stringify(r.conflict.competingValues),
      },
      { name: "resolution", value: (r) => r.conflict.resolution },
    ];
    return buildInsertStatements(this.db, "conflicts", columns, rows);
  }

  private componentInsertStatements(payload: DayPublication): D1StatementLike[] {
    type Row = { eventId: string; index: number; component: ScoreComponent };
    const rows: Row[] = payload.events.flatMap((entry) =>
      entry.components.map((component, index) => ({
        eventId: entry.event.id,
        index,
        component,
      })),
    );
    const columns: ColumnSpec<Row>[] = [
      { name: "id", value: (r) => `${payload.targetDate}:${r.eventId}:score:${r.index}` },
      { name: "event_id", value: (r) => r.eventId },
      { name: "feed_date", value: () => payload.targetDate },
      { name: "factor", value: (r) => r.component.factor },
      { name: "raw_value", value: (r) => r.component.rawValue },
      { name: "weight", value: (r) => r.component.weight },
      { name: "contribution", value: (r) => r.component.contribution },
      { name: "note", value: (r) => r.component.note },
      { name: "position", value: (r) => r.index },
    ];
    return buildInsertStatements(this.db, "score_components", columns, rows);
  }

  private changeInsertStatements(payload: DayPublication): D1StatementLike[] {
    type Row = { identityKey: string; change: DayPublication["events"][number]["change"] };
    const rows: Row[] = payload.events.map((entry) => ({
      identityKey: entry.event.identityKey,
      change: entry.change,
    }));
    const columns: ColumnSpec<Row>[] = [
      { name: "feed_date", value: () => payload.targetDate },
      { name: "identity_key", value: (r) => r.identityKey },
      { name: "kind", value: (r) => r.change.kind },
      { name: "detail", value: (r) => r.change.detail },
      { name: "detected_at", value: (r) => r.change.detectedAt },
    ];
    // Keyed on (feed_date, identity_key), which the schema also enforces as
    // unique on `events`. `OR REPLACE` keeps a replayed publish of the same day
    // idempotent rather than aborting it.
    return buildInsertStatements(this.db, "event_changes", columns, rows, {
      orReplace: true,
    });
  }

  private historyInsertStatements(
    payload: PublishPayload,
    day: DayPublication,
  ): D1StatementLike[] {
    type Row = { index: number; entry: EventHistoryEntry };
    const rows: Row[] = day.history.map((entry, index) => ({ index, entry }));
    const columns: ColumnSpec<Row>[] = [
      // Deterministic within a publish, so replaying the same publish updates
      // rather than duplicating, and a long identity key cannot collide through
      // truncation.
      {
        name: "id",
        value: (r) =>
          `${payload.publishedAt}:${day.targetDate}:${r.index}:${r.entry.fieldName}`,
      },
      { name: "identity_key", value: (r) => r.entry.identityKey },
      { name: "feed_date", value: () => day.targetDate },
      { name: "changed_at", value: (r) => r.entry.changedAt },
      { name: "field_name", value: (r) => r.entry.fieldName },
      { name: "old_value", value: (r) => r.entry.oldValue },
      { name: "new_value", value: (r) => r.entry.newValue },
      { name: "reason", value: (r) => r.entry.reason },
    ];
    // A replayed publish for the same instant must not abort the batch.
    return buildInsertStatements(this.db, "event_history", columns, rows, {
      orReplace: true,
    });
  }

  private runInsertStatements(run: RefreshRunRecord): D1StatementLike[] {
    return [
      this.db
        .prepare(
          `INSERT OR REPLACE INTO refresh_runs
             (id, target_date, status, started_at, finished_at, duration_ms, "trigger",
              fetched, published, pages_fetched, changes_json, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          run.id,
          run.targetDate,
          run.status,
          run.startedAt,
          run.finishedAt,
          run.durationMs,
          run.trigger,
          run.fetched,
          run.published,
          run.pagesFetched,
          run.changesJson,
          run.error,
        ),
    ];
  }

  private runRetentionStatements(): D1StatementLike[] {
    return [
      this.db
        .prepare(
          `DELETE FROM refresh_runs
            WHERE id NOT IN (
                  SELECT id FROM refresh_runs ORDER BY finished_at DESC, id DESC LIMIT ?
            )`,
        )
        .bind(this.config.refreshRunRetention),
    ];
  }

  /**
   * Trim days outside the rolling window, orphaned child rows, old history, and
   * old run rows. Requested days are always kept, so a refresh can never
   * discard what it just published.
   */
  private retentionStatements(payload: PublishPayload, keep: string[]): D1StatementLike[] {
    const oldest = shiftIsoDate(payload.todayDate, -this.config.retention.pastDays);
    const newest = shiftIsoDate(payload.todayDate, this.config.retention.futureDays);
    const placeholders = keep.map(() => "?").join(", ");
    const statements: D1StatementLike[] = [
      this.db
        .prepare(
          `DELETE FROM feeds
            WHERE (target_date < ? OR target_date > ?)
              AND target_date NOT IN (${placeholders})`,
        )
        .bind(oldest, newest, ...keep),
    ];
    const asOfIso = payload.publishedAt;
    statements.push(this.db.prepare("DELETE FROM app_state WHERE key LIKE 'ai:day:%' AND substr(key,8) NOT IN (SELECT target_date FROM feeds)"));
    for (const table of [
      "events",
      "source_records",
      "field_provenance",
      "conflicts",
      "score_components",
      "event_changes",
    ]) {
      statements.push(
        this.db.prepare(
          `DELETE FROM ${table} WHERE feed_date NOT IN (SELECT target_date FROM feeds)`,
        ),
      );
    }
    // Anchored on the publish instant rather than the wall clock, so retention
    // is deterministic and can never discard history the same batch just wrote.
    const historyCutoff = `${shiftIsoDate(
      asOfIso.slice(0, 10),
      -this.config.historyRetentionDays,
    )}T00:00:00.000Z`;
    statements.push(
      this.db.prepare("DELETE FROM event_history WHERE changed_at < ?").bind(historyCutoff),
    );
    statements.push(...this.runRetentionStatements());
    return statements;
  }
}
