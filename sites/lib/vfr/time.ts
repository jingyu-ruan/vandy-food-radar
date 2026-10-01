/**
 * Timezone arithmetic for a named IANA zone, correct across DST transitions.
 *
 * Workers have no Node `Date` timezone facilities beyond `Intl`, so every
 * conversion here is derived from `Intl.DateTimeFormat` offsets rather than
 * from a fixed hour count. That matters because the target day is a *local*
 * day: in `America/Chicago` a spring-forward day is 23 hours long and a
 * fall-back day is 25, and an event's local wall-clock time cannot be
 * recovered from its UTC instant by subtracting a constant.
 */

const PART_KEYS = [
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
] as const;

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export class TimeZoneError extends Error {}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw new TimeZoneError(`unknown event timezone: ${timeZone}`);
  }
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** Assert that `timeZone` is a zone this runtime can resolve. */
export function assertTimeZone(timeZone: string): void {
  formatterFor(timeZone);
}

/** Break an absolute instant into local calendar/clock parts in `timeZone`. */
export function toZonedParts(epochMs: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const found: Partial<Record<(typeof PART_KEYS)[number], number>> = {};
  for (const part of parts) {
    if ((PART_KEYS as readonly string[]).includes(part.type)) {
      found[part.type as (typeof PART_KEYS)[number]] = Number(part.value);
    }
  }
  for (const key of PART_KEYS) {
    if (found[key] === undefined || Number.isNaN(found[key])) {
      throw new TimeZoneError(`could not resolve local ${key} in ${timeZone}`);
    }
  }
  return found as ZonedParts;
}

/** Offset in milliseconds (local minus UTC) that `timeZone` uses at `epochMs`. */
export function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const p = toZonedParts(epochMs, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // `epochMs` may carry sub-second precision that the formatter discards.
  return asIfUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Resolve a local wall-clock time in `timeZone` to an absolute instant.
 *
 * The first guess uses the offset in effect at the same clock reading treated
 * as UTC, then re-checks the offset actually in effect at the candidate
 * instant. That second pass is what makes DST boundaries come out right. A
 * wall-clock time skipped by a spring-forward transition has no real instant;
 * it resolves forward to the first instant after the gap, which is the
 * conventional interpretation and never silently lands on the wrong day.
 */
export function zonedTimeToEpochMs(
  parts: ZonedParts,
  timeZone: string,
): number {
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const firstOffset = zoneOffsetMs(asIfUtc, timeZone);
  let candidate = asIfUtc - firstOffset;
  const secondOffset = zoneOffsetMs(candidate, timeZone);
  if (secondOffset !== firstOffset) {
    candidate = asIfUtc - secondOffset;
    // Re-derive the clock reading. When the requested time falls inside a
    // spring-forward gap the two offsets keep disagreeing; take the later of
    // the two candidates so the result is the first instant past the gap.
    const check = toZonedParts(candidate, timeZone);
    if (check.hour !== parts.hour || check.minute !== parts.minute) {
      candidate = Math.max(candidate, asIfUtc - firstOffset);
    }
  }
  return candidate;
}

/** Parse a `YYYY-MM-DD` string into its numeric components. */
export function parseIsoDate(
  value: string,
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject values like 2025-02-30 that survive the range check.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** Render `YYYY-MM-DD` for a local date. */
export function formatIsoDate(parts: {
  year: number;
  month: number;
  day: number;
}): string {
  const y = String(parts.year).padStart(4, "0");
  const m = String(parts.month).padStart(2, "0");
  const d = String(parts.day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Render local `HH:MM` for an instant in `timeZone`. */
export function formatLocalTime(epochMs: number, timeZone: string): string {
  const p = toZonedParts(epochMs, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** The local calendar date (`YYYY-MM-DD`) of an instant in `timeZone`. */
export function localDateOf(epochMs: number, timeZone: string): string {
  return formatIsoDate(toZonedParts(epochMs, timeZone));
}

/** Shift a `YYYY-MM-DD` local date by whole days, staying calendar-correct. */
export function shiftIsoDate(isoDate: string, days: number): string {
  const parsed = parseIsoDate(isoDate);
  if (!parsed) throw new TimeZoneError(`invalid date: ${isoDate}`);
  const shifted = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day + days),
  );
  return formatIsoDate({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

export type DayBounds = {
  /** First instant of the local day. */
  startMs: number;
  /** First instant of the following local day (exclusive upper bound). */
  endMs: number;
};

/**
 * The absolute bounds of a local calendar day.
 *
 * Both edges are resolved independently, so the span is 23, 24, or 25 hours
 * exactly as the zone dictates instead of assuming a fixed-length day.
 */
export function localDayBounds(isoDate: string, timeZone: string): DayBounds {
  const parsed = parseIsoDate(isoDate);
  if (!parsed) throw new TimeZoneError(`invalid target date: ${isoDate}`);
  const next = parseIsoDate(shiftIsoDate(isoDate, 1));
  if (!next) throw new TimeZoneError(`invalid target date: ${isoDate}`);
  const midnight = { hour: 0, minute: 0, second: 0 };
  return {
    startMs: zonedTimeToEpochMs({ ...parsed, ...midnight }, timeZone),
    endMs: zonedTimeToEpochMs({ ...next, ...midnight }, timeZone),
  };
}

/** Render an instant as a UTC ISO-8601 string with a `Z` suffix. */
export function toUtcIso(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Render an instant in the compact UTC form iCalendar requires. */
export function toIcsUtcStamp(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/**
 * Parse an ISO-8601 timestamp, requiring an explicit timezone designator.
 *
 * A naive timestamp is rejected rather than guessed at: an event whose start
 * has no zone cannot be placed on a local day with any confidence.
 */
export function parseAwareTimestamp(value: unknown): number {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("missing event timestamp");
  }
  const text = value.trim();
  if (!/(?:Z|z|[+-]\d{2}:?\d{2})$/.test(text)) {
    throw new TypeError("event timestamp has no timezone");
  }
  // Date.parse normalizes impossible dates such as February 30. Validate the
  // source calendar and clock before using it, matching Python's strict parser.
  const iso = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:[Zz]|([+-])(\d{2}):?(\d{2}))$/.exec(text);
  if (
    !iso || !parseIsoDate(iso[1]) ||
    Number(iso[2]) > 23 || Number(iso[3]) > 59 ||
    Number(iso[4] ?? 0) > 59 ||
    Number(iso[6] ?? 0) > 23 || Number(iso[7] ?? 0) > 59
  ) {
    throw new TypeError("event timestamp has an invalid calendar date or clock");
  }
  const epochMs = Date.parse(text);
  if (Number.isNaN(epochMs)) {
    throw new TypeError("event timestamp is not a valid instant");
  }
  return epochMs;
}
