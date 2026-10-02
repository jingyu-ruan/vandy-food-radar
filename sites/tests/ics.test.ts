/**
 * iCalendar output.
 *
 * Calendar clients are unforgiving about these details: an unescaped comma turns
 * one property into two, an over-long line is rejected outright, and splitting a
 * multi-byte character mid-sequence corrupts the file. Each is checked directly
 * rather than inferred from the document parsing "well enough".
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildEventIcs, escapeIcsText, foldIcsLine, icsFilename, icsUid } from "../lib/vfr/ics.ts";
import { FoodCategory, FoodConfirmed, VerificationState } from "../lib/vfr/models.ts";
import type { Event } from "../lib/vfr/models.ts";

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: "source|anchorlink:100001",
    dedupKey: "k",
    identityKey: "source|anchorlink:100001",
    anchorlinkId: "100001",
    title: "Pizza, Salad; and \\Snacks\\",
    eventDate: "2025-03-12",
    startTime: "18:00",
    endTime: "20:00",
    startUtc: "2025-03-12T23:00:00Z",
    endUtc: "2025-03-13T01:00:00Z",
    endsNextDay: false,
    location: "Sarratt Student Center, Room 216",
    locationGeo: null,
    organizer: "Student Life",
    rsvpRequired: null,
    rsvpUrl: null,
    rsvpLinkOk: null,
    eventUrl: "https://anchorlink.vanderbilt.edu/event/100001",
    foodConfirmed: FoodConfirmed.CONFIRMED,
    foodCategory: FoodCategory.FULL_MEAL,
    foodDescription: "Line one\nLine two",
    verificationState: VerificationState.PARTIALLY_VERIFIED,
    confidence: 0.3,
    scoreTotal: 0.755,
    ...overrides,
  };
}

test("TEXT escaping covers backslash, semicolon, comma, CR and LF", () => {
  assert.equal(escapeIcsText("a\\b"), "a\\\\b");
  assert.equal(escapeIcsText("a;b"), "a\\;b");
  assert.equal(escapeIcsText("a,b"), "a\\,b");
  assert.equal(escapeIcsText("a\r\nb"), "a\\nb");
  assert.equal(escapeIcsText("a\nb"), "a\\nb");
  assert.equal(escapeIcsText("a\rb"), "a\\nb");
  // The backslash is escaped first, so an escape sequence is not double-escaped.
  assert.equal(escapeIcsText("a\\,b"), "a\\\\\\,b");
});

test("folding keeps every physical line within 75 octets", () => {
  const line = `DESCRIPTION:${"x".repeat(400)}`;
  const folded = foldIcsLine(line);
  const physical = folded.split("\r\n");
  assert.ok(physical.length > 1);
  for (const segment of physical) {
    assert.ok(
      new TextEncoder().encode(segment).length <= 75,
      `segment too long: ${segment.length}`,
    );
  }
  // Unfolding restores the original line exactly.
  assert.equal(physical.map((s, i) => (i === 0 ? s : s.slice(1))).join(""), line);
});

test("folding never splits a multi-byte character", () => {
  // Each emoji is four UTF-8 octets, so a naive 75-character split would land
  // mid-sequence and corrupt the output.
  const line = `SUMMARY:${"\u{1F355}".repeat(60)}`;
  const folded = foldIcsLine(line);
  for (const segment of folded.split("\r\n")) {
    assert.ok(new TextEncoder().encode(segment).length <= 75);
  }
  const unfolded = folded
    .split("\r\n")
    .map((s, i) => (i === 0 ? s : s.slice(1)))
    .join("");
  assert.equal(unfolded, line);
  assert.ok(!unfolded.includes("\uFFFD"));
});

test("a short line is left unfolded", () => {
  assert.equal(foldIcsLine("UID:abc"), "UID:abc");
});

test("the document uses CRLF throughout and ends with one", () => {
  const ics = buildEventIcs(event(), {
    nowMs: Date.UTC(2025, 2, 12, 12),
    timezone: "America/Chicago",
  });
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  // No bare LF anywhere.
  assert.equal(ics.replace(/\r\n/g, "").includes("\n"), false);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
});

test("start and end are absolute UTC instants", () => {
  const ics = buildEventIcs(event(), {
    nowMs: Date.UTC(2025, 2, 12, 12, 30, 15),
    timezone: "America/Chicago",
  });
  assert.ok(ics.includes("DTSTART:20250312T230000Z\r\n"));
  assert.ok(ics.includes("DTEND:20250313T010000Z\r\n"));
  assert.ok(ics.includes("DTSTAMP:20250312T123015Z\r\n"));
});

test("a cross-midnight event keeps its true end instant", () => {
  const ics = buildEventIcs(
    event({ startUtc: "2025-03-13T03:00:00Z", endUtc: "2025-03-13T06:30:00Z", endsNextDay: true }),
    { nowMs: 0, timezone: "America/Chicago" },
  );
  assert.ok(ics.includes("DTSTART:20250313T030000Z"));
  assert.ok(ics.includes("DTEND:20250313T063000Z"));
});

test("the UID is stable and derived from the AnchorLink id", () => {
  assert.equal(icsUid(event()), "anchorlink-100001@vandy-food-radar");
  // Re-deriving from an identical event yields the same UID, so a re-import
  // updates the entry rather than duplicating it.
  assert.equal(icsUid(event()), icsUid(event({ title: "Renamed" })));
});

test("the download filename contains only digits from the source id", () => {
  assert.equal(icsFilename(event()), "vandy-food-radar-100001.ics");
  // A hostile id cannot inject quotes or path separators into the header.
  assert.equal(
    icsFilename(event({ anchorlinkId: '1"; rm -rf /' })),
    "vandy-food-radar-1.ics",
  );
  assert.equal(icsFilename(event({ anchorlinkId: null })), "vandy-food-radar-event.ics");
});

test("the summary and description are escaped and carry the source link", () => {
  const ics = buildEventIcs(event(), { nowMs: 0, timezone: "America/Chicago" });
  assert.ok(ics.includes("SUMMARY:Pizza\\, Salad\\; and \\\\Snacks\\\\"));
  assert.ok(ics.includes("LOCATION:Sarratt Student Center\\, Room 216"));
  assert.ok(ics.includes("URL:https://anchorlink.vanderbilt.edu/event/100001"));
  // Newlines in the description survive as escaped sequences, not raw breaks.
  assert.ok(ics.includes("Line one\\nLine two"));
});

test("an event with no start time becomes an all-day entry with an exclusive end", () => {
  const ics = buildEventIcs(
    event({ startUtc: null, endUtc: null, startTime: null, endTime: null }),
    { nowMs: 0, timezone: "America/Chicago" },
  );
  assert.ok(ics.includes("DTSTART;VALUE=DATE:20250312\r\n"));
  assert.ok(ics.includes("DTEND;VALUE=DATE:20250313\r\n"));
  assert.ok(!ics.includes("DTEND:"));
  assert.ok(ics.includes("X-VFR-TIME-UNKNOWN:TRUE"));
});
