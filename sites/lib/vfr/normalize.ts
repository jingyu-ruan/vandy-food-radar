/**
 * Per-source normalizer.
 *
 * Maps one source record's shallow `parsedFields` into canonical field values.
 * Normalization is non-lossy: the per-source originals are preserved verbatim
 * on the result so later stages can explain how the canonical record was
 * produced and resolve conflicts against the raw values. The input record is
 * never mutated.
 */

import { classifyFood } from "./food.ts";
import type { FoodClassification } from "./food.ts";
import { FoodCategory, FoodConfirmed, ParseStatus } from "./models.ts";
import type { ParseStatus as ParseStatusT, SourceId, SourceRecord } from "./models.ts";
import { asBool, asText } from "./text.ts";
import { parseIsoDate } from "./time.ts";

/** Marker that may appear in a title to signal a cancelled event. */
export const CANCELLED_MARKER = "[cancelled]";

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type NormalizedRecord = {
  sourceId: SourceId;
  sourceRecordId: string;
  parseStatus: ParseStatusT;

  title: string | null;
  eventDate: string | null;
  startTime: string | null;
  endTime: string | null;
  startUtc: string | null;
  endUtc: string | null;
  endsNextDay: boolean;
  location: string | null;
  organizer: string | null;
  rsvpRequired: boolean | null;
  rsvpUrl: string | null;
  eventUrl: string | null;
  anchorlinkId: string | null;
  /** Stable provider-native identity, when the adapter supplied one. */
  sourceIdentity: string | null;

  foodConfirmed: FoodConfirmed;
  foodCategory: FoodCategory;
  foodDescription: string | null;
  foodClassification: FoodClassification;

  cancelled: boolean;

  /** True when the source supplied a value that could not be parsed. */
  dateFlagged: boolean;
  startTimeFlagged: boolean;
  endTimeFlagged: boolean;

  originalFields: Record<string, unknown>;
};

function parseLocalDate(raw: unknown): { ok: boolean; value: string | null } {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, value: null };
  const parsed = parseIsoDate(raw);
  return parsed ? { ok: true, value: raw.trim() } : { ok: false, value: null };
}

function parseLocalTime(raw: unknown): { ok: boolean; value: string | null } {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, value: null };
  const trimmed = raw.trim();
  return TIME_PATTERN.test(trimmed)
    ? { ok: true, value: trimmed }
    : { ok: false, value: null };
}

/**
 * Derive a per-record cancellation signal.
 *
 * Sourced from an explicit boolean, a `status` of "cancelled", or a
 * `[CANCELLED]` marker in the title. Absence of an event from a later fetch is
 * deliberately *not* a signal; a disappearance is not proof of cancellation.
 */
function detectCancelled(
  fields: Record<string, unknown>,
  title: string | null,
): boolean {
  if (asBool(fields["cancelled"]) === true) return true;
  const status = asText(fields["status"]);
  if (status !== null && status.toLowerCase() === "cancelled") return true;
  if (title !== null && title.toLowerCase().includes(CANCELLED_MARKER)) return true;
  return false;
}

function resolveFoodCategory(
  fields: Record<string, unknown>,
  derived: FoodCategory,
): FoodCategory {
  const raw = asText(fields["food_category"]);
  if (raw === null) return derived;
  const valid = Object.values(FoodCategory) as string[];
  return valid.includes(raw) ? (raw as FoodCategory) : derived;
}

function resolveFoodConfirmed(
  fields: Record<string, unknown>,
  derived: FoodConfirmed,
): FoodConfirmed {
  const raw = asText(fields["food_confirmed"]);
  if (raw === null) return derived;
  const valid = Object.values(FoodConfirmed) as string[];
  return valid.includes(raw) ? (raw as FoodConfirmed) : derived;
}

/**
 * Normalize one source record.
 *
 * A record whose parse status is not `ok` still yields a normalized record
 * (empty canonical fields, originals preserved) so failures degrade gracefully
 * instead of aborting the run.
 */
export function normalize(record: SourceRecord): NormalizedRecord {
  const fields: Record<string, unknown> = { ...record.parsedFields };

  const title = asText(fields["title"]);
  const parsedDate = parseLocalDate(fields["event_date"]);
  const parsedStart = parseLocalTime(fields["start_time"]);
  const parsedEnd = parseLocalTime(fields["end_time"]);

  const foodDescription = asText(fields["food_description"]);
  const classification = classifyFood(foodDescription);

  return {
    sourceId: record.sourceId,
    sourceRecordId: record.id,
    parseStatus: record.parseStatus,
    title,
    eventDate: parsedDate.value,
    startTime: parsedStart.value,
    endTime: parsedEnd.value,
    startUtc: asText(fields["start_utc"]),
    endUtc: asText(fields["end_utc"]),
    endsNextDay: asBool(fields["ends_next_day"]) === true,
    location: asText(fields["location"]),
    organizer: asText(fields["organizer"]),
    rsvpRequired: asBool(fields["rsvp_required"]),
    rsvpUrl: asText(fields["rsvp_url"]),
    eventUrl: asText(fields["event_url"]),
    anchorlinkId: asText(fields["anchorlink_id"]),
    sourceIdentity: asText(fields["source_identity"]),
    foodConfirmed: resolveFoodConfirmed(fields, classification.confirmed),
    foodCategory: resolveFoodCategory(fields, classification.category),
    foodDescription,
    foodClassification: classification,
    cancelled: detectCancelled(fields, title),
    dateFlagged: !parsedDate.ok && fields["event_date"] !== undefined,
    startTimeFlagged: !parsedStart.ok && fields["start_time"] !== undefined,
    endTimeFlagged: !parsedEnd.ok && fields["end_time"] !== undefined,
    originalFields: fields,
  };
}

export { ParseStatus };
