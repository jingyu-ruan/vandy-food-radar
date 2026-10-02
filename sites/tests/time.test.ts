/**
 * Daylight-saving behaviour of the target-day boundaries.
 *
 * The target day is a *local* day, and in America/Chicago two days a year are
 * not 24 hours long. If day bounds were computed by adding a fixed offset, the
 * spring-forward day would silently include an hour of the next day and the
 * fall-back day would silently drop one, which would in turn make the
 * `startsAfter`/`startsBefore` query window wrong and change which events appear.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatLocalTime,
  localDateOf,
  localDayBounds,
  parseAwareTimestamp,
  shiftIsoDate,
  toIcsUtcStamp,
  toUtcIso,
  zonedTimeToEpochMs,
} from "../lib/vfr/time.ts";

const CHICAGO = "America/Chicago";
const HOUR = 3600000;

test("a spring-forward local day is 23 hours long", () => {
  const bounds = localDayBounds("2025-03-09", CHICAGO);
  assert.equal((bounds.endMs - bounds.startMs) / HOUR, 23);
  assert.equal(toUtcIso(bounds.startMs), "2025-03-09T06:00:00Z");
  assert.equal(toUtcIso(bounds.endMs), "2025-03-10T05:00:00Z");
});

test("a fall-back local day is 25 hours long", () => {
  const bounds = localDayBounds("2025-11-02", CHICAGO);
  assert.equal((bounds.endMs - bounds.startMs) / HOUR, 25);
  assert.equal(toUtcIso(bounds.startMs), "2025-11-02T05:00:00Z");
  assert.equal(toUtcIso(bounds.endMs), "2025-11-03T06:00:00Z");
});

test("an ordinary local day is 24 hours long", () => {
  const bounds = localDayBounds("2025-06-15", CHICAGO);
  assert.equal((bounds.endMs - bounds.startMs) / HOUR, 24);
});

test("an instant one minute before local midnight belongs to the previous day", () => {
  const bounds = localDayBounds("2025-03-09", CHICAGO);
  assert.equal(localDateOf(bounds.startMs - 60000, CHICAGO), "2025-03-08");
  assert.equal(localDateOf(bounds.startMs, CHICAGO), "2025-03-09");
  assert.equal(localDateOf(bounds.endMs - 60000, CHICAGO), "2025-03-09");
  assert.equal(localDateOf(bounds.endMs, CHICAGO), "2025-03-10");
});

test("local clock time survives the DST offset change", () => {
  // 01:30 CST and 03:30 CDT are one hour apart in absolute terms on the
  // spring-forward day, because 02:00 local never occurs.
  const before = zonedTimeToEpochMs(
    { year: 2025, month: 3, day: 9, hour: 1, minute: 30, second: 0 },
    CHICAGO,
  );
  const after = zonedTimeToEpochMs(
    { year: 2025, month: 3, day: 9, hour: 3, minute: 30, second: 0 },
    CHICAGO,
  );
  assert.equal((after - before) / HOUR, 1);
  assert.equal(formatLocalTime(before, CHICAGO), "01:30");
  assert.equal(formatLocalTime(after, CHICAGO), "03:30");
});

test("a wall-clock time inside the spring-forward gap resolves past the gap", () => {
  const skipped = zonedTimeToEpochMs(
    { year: 2025, month: 3, day: 9, hour: 2, minute: 30, second: 0 },
    CHICAGO,
  );
  // 02:30 does not exist; it must still land on the right local day.
  assert.equal(localDateOf(skipped, CHICAGO), "2025-03-09");
  assert.equal(formatLocalTime(skipped, CHICAGO), "03:30");
});

test("date shifting crosses month and year boundaries", () => {
  assert.equal(shiftIsoDate("2025-02-28", 1), "2025-03-01");
  assert.equal(shiftIsoDate("2024-02-28", 1), "2024-02-29");
  assert.equal(shiftIsoDate("2025-12-31", 1), "2026-01-01");
  assert.equal(shiftIsoDate("2025-01-01", -1), "2024-12-31");
});

test("a timestamp without a zone designator is rejected", () => {
  assert.throws(() => parseAwareTimestamp("2025-03-12T18:00:00"), /no timezone/);
  assert.throws(() => parseAwareTimestamp(null), /missing event timestamp/);
  assert.equal(parseAwareTimestamp("2025-03-12T18:00:00Z"), Date.UTC(2025, 2, 12, 18));
  assert.equal(
    parseAwareTimestamp("2025-03-12T13:00:00-05:00"),
    Date.UTC(2025, 2, 12, 18),
  );
});

test("an impossible calendar date or clock reading is rejected, not normalized", () => {
  // Date.parse accepts all of these and silently rolls them forward, which would
  // place an event on a day the source never stated.
  for (const impossible of [
    "2025-02-30T18:00:00Z",
    "2025-04-31T18:00:00Z",
    "2025-13-01T18:00:00Z",
    "2025-03-12T24:00:00Z",
    "2025-03-12T18:60:00Z",
    "2025-03-12T18:00:61Z",
    "2025-03-12T18:00:00+24:00",
    "2025-03-12T18:00:00+00:60",
  ]) {
    assert.throws(
      () => parseAwareTimestamp(impossible),
      /invalid calendar date or clock/,
      impossible,
    );
  }
  // A leap day that really exists still parses.
  assert.equal(parseAwareTimestamp("2024-02-29T18:00:00Z"), Date.UTC(2024, 1, 29, 18));
});

test("ICS stamps are compact UTC", () => {
  assert.equal(toIcsUtcStamp(Date.UTC(2025, 2, 12, 23, 5, 7)), "20250312T230507Z");
});
