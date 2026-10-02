/**
 * iCalendar (RFC 5545) export for a single selected event.
 *
 * This replaces the reference application's optional Google Calendar service
 * account write. That integration was always optional and disabled by default;
 * here the export is a user-driven download instead, which removes the need to
 * hold a third-party write credential at all. Nothing is ever written to a
 * user's calendar automatically — the user downloads a file and decides whether
 * to import it.
 *
 * Output details that matter for interoperability:
 * - CRLF line endings, including after the final `END:VCALENDAR`.
 * - `TEXT` values escape backslash, semicolon, comma, and newlines.
 * - Content lines are folded to 75 octets, counted in UTF-8 bytes and split
 *   only on code-point boundaries so multi-byte characters survive.
 * - `DTSTART`/`DTEND` are absolute UTC instants, which stay correct across
 *   daylight-saving transitions and for cross-midnight events.
 * - `UID` is derived from the stable AnchorLink event id, so re-importing
 *   updates the same calendar entry rather than duplicating it.
 */

import type { Event } from "./models.ts";
import { toIcsUtcStamp } from "./time.ts";

const CRLF = "\r\n";
const MAX_OCTETS = 75;
const UID_DOMAIN = "vandy-food-radar";

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
 * Fold one content line to at most 75 octets per physical line.
 *
 * Continuation lines are prefixed with a single space, which itself counts
 * toward the limit, so continuations carry at most 74 octets of payload.
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
      // Every line after the first spends one octet on the leading space.
      limit = MAX_OCTETS - 1;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  if (current) segments.push(current);
  return segments
    .map((segment, index) => (index === 0 ? segment : ` ${segment}`))
    .join(CRLF);
}

/** The stable UID for an event, derived from its AnchorLink id. */
export function icsUid(event: Event): string {
  const base = event.anchorlinkId ?? event.identityKey;
  return `anchorlink-${base}@${UID_DOMAIN}`;
}

/**
 * A download filename safe for a `Content-Disposition` header.
 *
 * Built only from the numeric source id, so no title text, quote, newline, or
 * path separator from an untrusted description can reach the header.
 */
export function icsFilename(event: Event): string {
  const numeric = (event.anchorlinkId ?? "").replace(/[^0-9]/g, "");
  return `vandy-food-radar-${numeric || "event"}.ics`;
}

export type IcsOptions = {
  /** Stamp for `DTSTAMP`; injected so output is deterministic in tests. */
  nowMs: number;
  timezone: string;
};

/** Build a complete single-event iCalendar document. */
export function buildEventIcs(event: Event, options: IcsOptions): string {
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

  if (event.startUtc && event.endUtc) {
    lines.push(`DTSTART:${toIcsUtcStamp(Date.parse(event.startUtc))}`);
    lines.push(`DTEND:${toIcsUtcStamp(Date.parse(event.endUtc))}`);
  } else {
    // No absolute instants were published for this event. An all-day entry on
    // the local event date is honest; inventing clock times would not be.
    const compact = event.eventDate.replace(/-/g, "");
    lines.push(`DTSTART;VALUE=DATE:${compact}`);
  }

  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  if (event.organizer) {
    lines.push(`X-VFR-ORGANIZER:${escapeIcsText(event.organizer)}`);
  }

  const descriptionParts: string[] = [];
  if (event.foodDescription) descriptionParts.push(event.foodDescription);
  if (event.eventUrl) descriptionParts.push(event.eventUrl);
  descriptionParts.push(`Times shown in ${options.timezone}.`);
  lines.push(`DESCRIPTION:${escapeIcsText(descriptionParts.join("\n\n"))}`);

  if (event.eventUrl) lines.push(`URL:${escapeIcsText(event.eventUrl)}`);

  lines.push("END:VEVENT", "END:VCALENDAR");

  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}
