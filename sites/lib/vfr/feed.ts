/**
 * Read model for the published feed.
 *
 * Every read path goes through here, and every read path can end in exactly one
 * of four honest states. Collapsing any of them into "no events" would be a lie
 * the user cannot detect, so they stay distinct:
 *
 * - `uninitialized` — no refresh has ever published this day.
 * - `ok` — a published day with at least one event.
 * - `empty` — a published day the source genuinely returned no matches for.
 * - `unavailable` — durable storage could not be read. Nothing is shown as if
 *   it were current, and nothing is substituted for the real data. The visitor
 *   message is deliberately plain; the cause, including a missing schema, stays
 *   in `schemaMissing`, the server log, and the health route.
 *
 * Staleness is reported separately from all of the above: a published feed older
 * than the configured window is still shown, but flagged, because an out-of-date
 * listing presented as current is worse than one labelled as out of date.
 */

import { StorageError } from "./d1.ts";
import type { Config } from "./config.ts";
import type { FeedSnapshot, RefreshRunRecord, Repository } from "./repository.ts";
import { localDateOf, parseIsoDate } from "./time.ts";

export type FeedState = "ok" | "empty" | "uninitialized" | "unavailable";

/**
 * Parse a strict `YYYY-MM-DD` query value, or return `fallback`.
 *
 * Strict by design: a malformed or impossible date falls back to today rather
 * than being coerced into a neighbouring day, so the date shown in the UI
 * always matches the data that was queried.
 */
export function parseSelectedDate(raw: string | null | undefined, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || !parseIsoDate(trimmed)) return fallback;
  return trimmed;
}

export type FeedView = {
  state: FeedState;
  targetDate: string;
  timezone: string;
  /** Local date the server considers "today", for display alongside the target. */
  todayDate: string;
  publishedAt: string | null;
  ageMs: number | null;
  stale: boolean;
  staleAfterMs: number;
  snapshot: FeedSnapshot | null;
  lastRun: RefreshRunRecord | null;
  message: string;
  /** True when the schema has not been applied yet, which is a setup step. */
  schemaMissing: boolean;
};

const UNAVAILABLE_MESSAGE =
  "Event data is temporarily unavailable. The last published listing could not be read.";

/**
 * Load one local day for display: `selectedDate` when given, otherwise today
 * in the configured zone.
 *
 * This never triggers a refresh. A GET must not mutate durable state, so a stale
 * or missing feed is reported as such rather than quietly repaired.
 */
export async function loadFeedView(
  repository: Repository,
  config: Config,
  nowMs: number = Date.now(),
  selectedDate?: string,
): Promise<FeedView> {
  const todayDate = localDateOf(nowMs, config.timezone);
  const targetDate = selectedDate ?? todayDate;

  const base: FeedView = {
    state: "uninitialized",
    targetDate,
    timezone: config.timezone,
    todayDate,
    publishedAt: null,
    ageMs: null,
    stale: false,
    staleAfterMs: config.staleAfterMs,
    snapshot: null,
    lastRun: null,
    message: "",
    schemaMissing: false,
  };

  let snapshot: FeedSnapshot | null;
  let lastRun: RefreshRunRecord | null = null;
  try {
    snapshot = await repository.readFeed(targetDate);
    lastRun = await repository.lastRun();
  } catch (error) {
    // `schemaMissing` is retained for server-side diagnostics and the health
    // route. The visitor is told only that the listing is unavailable, because a
    // deployment step is not something they can act on.
    const schemaMissing = error instanceof StorageError && error.schemaMissing;
    return {
      ...base,
      state: "unavailable",
      schemaMissing,
      message: UNAVAILABLE_MESSAGE,
    };
  }

  if (snapshot === null) {
    return {
      ...base,
      lastRun,
      state: "uninitialized",
      message:
        "No listing has been published for this date yet. Run a refresh to fetch it.",
    };
  }

  const publishedMs = Date.parse(snapshot.publishedAt);
  const ageMs = Number.isNaN(publishedMs) ? null : Math.max(0, nowMs - publishedMs);
  const stale = ageMs !== null && ageMs > config.staleAfterMs;

  return {
    ...base,
    state: snapshot.events.length > 0 ? "ok" : "empty",
    publishedAt: snapshot.publishedAt,
    ageMs,
    stale,
    snapshot,
    lastRun,
    message:
      snapshot.events.length > 0
        ? ""
        : "No approved public AnchorLink events with the Free Food perk were listed for this date.",
  };
}

/** JSON projection of the feed, used by `GET /api/events`. */
export function feedViewToJson(view: FeedView): Record<string, unknown> {
  return {
    state: view.state,
    targetDate: view.targetDate,
    todayDate: view.todayDate,
    timezone: view.timezone,
    publishedAt: view.publishedAt,
    ageSeconds: view.ageMs === null ? null : Math.floor(view.ageMs / 1000),
    stale: view.stale,
    staleAfterSeconds: Math.floor(view.staleAfterMs / 1000),
    message: view.message || null,
    eventCount: view.snapshot?.events.length ?? 0,
    sourceReportedTotal: view.snapshot?.sourceTotal ?? null,
    events: (view.snapshot?.events ?? []).map((stored) => ({
      rank: stored.rank,
      id: stored.event.id,
      anchorlinkId: stored.event.anchorlinkId,
      identityKey: stored.event.identityKey,
      title: stored.event.title,
      eventDate: stored.event.eventDate,
      startTime: stored.event.startTime,
      endTime: stored.event.endTime,
      startUtc: stored.event.startUtc,
      endUtc: stored.event.endUtc,
      endsNextDay: stored.event.endsNextDay,
      location: stored.event.location,
      organizer: stored.event.organizer,
      rsvpRequired: stored.event.rsvpRequired,
      rsvpUrl: stored.event.rsvpUrl,
      eventUrl: stored.event.eventUrl,
      foodConfirmed: stored.event.foodConfirmed,
      foodCategory: stored.event.foodCategory,
      foodDescription: stored.event.foodDescription,
      verificationState: stored.event.verificationState,
      confidence: stored.event.confidence,
      scoreTotal: stored.event.scoreTotal,
      explanation: stored.explanation,
      walking: stored.walkingLabel,
      change: stored.change,
      scoreComponents: stored.components,
      conflicts: stored.conflicts,
      provenance: stored.provenance,
      sources: stored.sources.map((source) => ({
        sourceId: source.sourceId,
        sourceUrl: source.sourceUrl,
        checkedAt: source.checkedAt,
      })),
      calendarUrl: stored.event.anchorlinkId
        ? `/api/calendar/${stored.event.anchorlinkId}?date=${stored.event.eventDate}`
        : null,
    })),
  };
}
