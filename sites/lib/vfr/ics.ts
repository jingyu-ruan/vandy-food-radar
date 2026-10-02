/**
 * Credential-free calendar handoff: an RFC 5545 download and a Google
 * Calendar prefill link.
 *
 * Nothing is ever written to a user's calendar by the server. The `.ics` file is
 * downloaded and imported by the user; the Google link only opens Google's own
 * composer with fields filled in, and the user confirms the save. No calendar
 * credential or OAuth scope exists anywhere in this application.
 *
 * Both paths share one time model (ported from the Python reference,
 * `vandy_food_radar/calendar_links.py`):
 *
 * - When the source published absolute instants they are used directly, so
 *   DST transitions and cross-midnight ends are already exact.
 * - Otherwise a local start resolves through the configured zone. A missing
 *   end gets a 60-minute duration instead of a zero-length entry some clients
 *   drop, and an end at or before the start rolls to the next day.
 * - No start time becomes an all-day entry with the exclusive `DTEND` an
 *   all-day VEVENT requires.
 *
 * Output details: CRLF line endings, TEXT escaping of backslash, semicolon,
 * comma, and newlines, folding at 75 UTF-8 octets on code-point boundaries,
 * and a UID derived from the stable AnchorLink id so a re-import updates the
 * same entry. A cancelled event is emitted with `STATUS:CANCELLED`, so
 * importing it updates a previously saved copy instead of leaving it active.
 */

import type { Event } from "./models.ts";
import { VerificationState } from "./models.ts";
import { parseIsoDate, shiftIsoDate, toIcsUtcStamp, zonedTimeToEpochMs } from "./time.ts";

const CRLF = "\r\n";
const MAX_OCTETS = 75;
const UID_DOMAIN = "vandy-food-radar";

export const DEFAULT_DURATION_MINUTES = 60;
export const GOOGLE_CALENDAR_TEMPLATE_URL = "https://calendar.google.com/calendar/render";

/** Escape a TEXT value per RFC 5545 section 3.3.11. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n/g, "\\n")
    .replace(/[\r\n]/g, "\\n");
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Fold one content line to at most 75 octets per physical line. Continuation
 * lines spend one octet on their leading space.
 */
export function foldIcsLine(line: string): string {
  if (utf8Length(line) <= MAX_OCTETS) return line;
  const segments: string[] = [];
  let current = "";
  let currentBytes = 0;
  let limit = MAX_OCTETS;
  for (const char of line) {
    const charBytes = utf8Length(char);
    if (currentBytes + charBytes > limit) {
      segments.push(current);
      current = char;
      currentBytes = charBytes;
      limit = MAX_OCTETS - 1;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  if (current) segments.push(current);
  return segments.map((segment, index) => (index === 0 ? segment : ` ${segment}`)).join(CRLF);
}

/** The stable UID for an event, derived from its AnchorLink id. */
export function icsUid(event: Event): string {
  const base = event.anchorlinkId ?? event.identityKey;
  return `anchorlink-${base}@${UID_DOMAIN}`;
}

/**
 * A download filename safe for a `Content-Disposition` header, built only from
 * the numeric source id so no untrusted text can reach the header.
 */
export function icsFilename(event: Event): string {
  const numeric = (event.anchorlinkId ?? "").replace(/[^0-9]/g, "");
  return `vandy-food-radar-${numeric || "event"}.ics`;
}

export type CalendarWindow =
  | { allDay: true; startDate: string; endDate: string; crossesMidnight: false }
  | { allDay: false; startMs: number; endMs: number; crossesMidnight: boolean };

function localInstant(isoDate: string, hhmm: string, timeZone: string): number | null {
  const date = parseIsoDate(isoDate);
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!date || !match) return null;
  return zonedTimeToEpochMs(
    { ...date, hour: Number(match[1]), minute: Number(match[2]), second: 0 },
    timeZone,
  );
}

/** Resolve an event into a calendar window (see the module comment). */
export function resolveWindow(
  event: Event,
  timeZone: string,
  defaultDurationMinutes = DEFAULT_DURATION_MINUTES,
): CalendarWindow {
  const startMs = event.startUtc ? Date.parse(event.startUtc) : NaN;
  const endMs = event.endUtc ? Date.parse(event.endUtc) : NaN;
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
    return { allDay: false, startMs, endMs, crossesMidnight: event.endsNextDay };
  }

  const localStart = event.startTime ? localInstant(event.eventDate, event.startTime, timeZone) : null;
  if (localStart === null) {
    return {
      allDay: true,
      startDate: event.eventDate,
      // All-day DTEND is exclusive.
      endDate: parseIsoDate(event.eventDate) ? shiftIsoDate(event.eventDate, 1) : event.eventDate,
      crossesMidnight: false,
    };
  }
  if (!event.endTime) {
    return {
      allDay: false,
      startMs: localStart,
      endMs: localStart + defaultDurationMinutes * 60000,
      crossesMidnight: false,
    };
  }
  let localEnd = localInstant(event.eventDate, event.endTime, timeZone);
  let crosses = false;
  if (localEnd === null) {
    localEnd = localStart + defaultDurationMinutes * 60000;
  } else if (localEnd <= localStart) {
    localEnd = localInstant(shiftIsoDate(event.eventDate, 1), event.endTime, timeZone)!;
    crosses = true;
  }
  return { allDay: false, startMs: localStart, endMs: localEnd, crossesMidnight: crosses };
}

function safeLink(value: string | null): string | null {
  if (!value || /[\r\n]/.test(value)) return null;
  try {
    const url = new URL(value.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && url.host
      ? value.trim()
      : null;
  } catch {
    return null;
  }
}

/** A short, source-grounded description shared by both handoff paths. */
export function eventDescription(event: Event): string {
  const parts: string[] = [];
  if (event.foodDescription) parts.push(event.foodDescription);
  if (event.organizer) parts.push(`Organizer: ${event.organizer}`);
  if (event.rsvpRequired) parts.push("RSVP required.");
  const rsvp = safeLink(event.rsvpUrl);
  if (rsvp) parts.push(`RSVP: ${rsvp}`);
  const source = safeLink(event.eventUrl);
  if (source) parts.push(`Source: ${source}`);
  return parts.join("\n");
}

export type CalendarOptions = {
  timezone: string;
  /** Location text to use, e.g. the resolved building plus room detail. */
  location?: string | null;
};

/**
 * A Google Calendar prefill URL. It only opens Google's composer; the user
 * still confirms the save, so the server needs no calendar scope.
 */
export function googleCalendarUrl(event: Event, options: CalendarOptions): string {
  const window = resolveWindow(event, options.timezone);
  const dates = window.allDay
    ? `${window.startDate.replace(/-/g, "")}/${window.endDate.replace(/-/g, "")}`
    : `${toIcsUtcStamp(window.startMs)}/${toIcsUtcStamp(window.endMs)}`;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: event.title,
    dates,
    details: eventDescription(event),
    ctz: options.timezone,
  });
  const location = options.location ?? event.location;
  if (location) params.set("location", location);
  return `${GOOGLE_CALENDAR_TEMPLATE_URL}?${params.toString()}`;
}

export type IcsOptions = CalendarOptions & {
  /** Stamp for `DTSTAMP`; injected so output is deterministic in tests. */
  nowMs: number;
};

/** Build a complete single-event iCalendar document. */
export function buildEventIcs(event: Event, options: IcsOptions): string {
  const window = resolveWindow(event, options.timezone);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${UID_DOMAIN}//Vandy Food Radar//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(icsUid(event))}`,
    `DTSTAMP:${toIcsUtcStamp(options.nowMs)}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
  ];

  if (window.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${window.startDate.replace(/-/g, "")}`);
    lines.push(`DTEND;VALUE=DATE:${window.endDate.replace(/-/g, "")}`);
  } else {
    // UTC instants stay correct across DST without a VTIMEZONE component.
    lines.push(`DTSTART:${toIcsUtcStamp(window.startMs)}`);
    lines.push(`DTEND:${toIcsUtcStamp(window.endMs)}`);
  }

  const location = options.location ?? event.location;
  if (location) lines.push(`LOCATION:${escapeIcsText(location)}`);
  if (event.organizer) lines.push(`X-VFR-ORGANIZER:${escapeIcsText(event.organizer)}`);

  const description = [eventDescription(event), `Times shown in ${options.timezone}.`]
    .filter(Boolean)
    .join("\n\n");
  lines.push(`DESCRIPTION:${escapeIcsText(description)}`);

  const source = safeLink(event.eventUrl);
  if (source) lines.push(`URL:${escapeIcsText(source)}`);
  lines.push(
    event.verificationState === VerificationState.CANCELLED
      ? "STATUS:CANCELLED"
      : "STATUS:CONFIRMED",
  );
  if (window.allDay) lines.push("X-VFR-TIME-UNKNOWN:TRUE");
  if (window.crossesMidnight) lines.push("X-VFR-OVERNIGHT:TRUE");

  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}
