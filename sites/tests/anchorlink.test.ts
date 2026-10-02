/**
 * Live AnchorLink adapter: row validation and pagination integrity.
 *
 * The point of these cases is the distinction between "this row does not belong
 * on the target day" (filtered, feed still publishes) and "this response cannot
 * be trusted" (whole refresh aborts, previous feed survives). Getting that wrong
 * in either direction is the difference between an honest empty day and a
 * silently truncated one.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AnchorLinkFetchError, LiveAnchorLinkAdapter } from "../lib/vfr/anchorlink.ts";
import { defaultConfig } from "../lib/vfr/config.ts";
import { anchorRow, fakeFetcher, searchPage } from "./helpers.ts";

const TARGET = "2025-03-12";
// Well before any 2025-03-12 event ends, so nothing is filtered as past.
const NOW = Date.UTC(2025, 2, 12, 12);

function adapter(
  pages: { skip: number; body: unknown; ok?: boolean; status?: number }[],
  nowMs = NOW,
) {
  const config = defaultConfig();
  const fetcher = fakeFetcher(pages);
  return {
    fetcher,
    adapter: new LiveAnchorLinkAdapter({
      fetcher,
      settings: config.anchorLink,
      timezone: config.timezone,
      nowMs,
    }),
  };
}

test("the query applies the Free Food facet and exact local-day UTC bounds", async () => {
  const { adapter: live, fetcher } = adapter([{ skip: 0, body: searchPage([]) }]);
  await live.fetch(TARGET);

  const url = new URL(fetcher.calls[0]);
  assert.equal(url.pathname, "/api/discovery/event/search");
  assert.equal(url.searchParams.get("benefitNames"), "FreeFood");
  // startsAfter is exclusive, so it steps back one second from local midnight.
  assert.equal(url.searchParams.get("startsAfter"), "2025-03-12T04:59:59Z");
  assert.equal(url.searchParams.get("startsBefore"), "2025-03-13T05:00:00Z");
  assert.equal(url.searchParams.get("take"), "100");
  assert.equal(url.searchParams.get("skip"), "0");
  // The page-level perk parameter is not an API filter and must not be sent.
  assert.equal(url.searchParams.get("perks"), null);
});

test("a valid row becomes a record with a link built from the returned id", async () => {
  const { adapter: live } = adapter([{ skip: 0, body: searchPage([anchorRow()]) }]);
  const result = await live.fetch(TARGET);

  assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.equal(record.id, "anchorlink-100001");
  assert.equal(record.sourceUrl, "https://anchorlink.vanderbilt.edu/event/100001");
  assert.equal(record.parsedFields.event_url, "https://anchorlink.vanderbilt.edu/event/100001");
  assert.equal(record.parsedFields.source_identity, "anchorlink:100001");
  assert.equal(record.parsedFields.start_time, "18:00");
  assert.equal(record.parsedFields.end_time, "20:00");
  // HTML from the description never survives as markup.
  assert.equal(record.parsedFields.food_description, "Free pizza and salad provided.");
  assert.equal(record.parsedFields.ends_next_day, false);
});

test("a cross-midnight event stays on the day it starts and is flagged", async () => {
  const { adapter: live } = adapter([
    {
      skip: 0,
      body: searchPage([
        anchorRow({
          startsOn: "2025-03-13T03:00:00Z", // 22:00 local on the 12th
          endsOn: "2025-03-13T06:30:00Z", // 01:30 local on the 13th
        }),
      ]),
    },
  ]);
  const result = await live.fetch(TARGET);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].parsedFields.start_time, "22:00");
  assert.equal(result.records[0].parsedFields.end_time, "01:30");
  assert.equal(result.records[0].parsedFields.ends_next_day, true);
});

test("rows that do not belong on the target day are filtered, not fatal", async () => {
  const cases = [
    { label: "wrong benefit", row: anchorRow({ benefitNames: ["Free Swag"] }) },
    { label: "not approved", row: anchorRow({ status: "Pending" }) },
    { label: "not public", row: anchorRow({ visibility: "Private" }) },
    { label: "wrong institution", row: anchorRow({ institutionId: 99 }) },
    { label: "wrong branch", row: anchorRow({ branchId: 1, branchIds: [2] }) },
    {
      label: "different local date",
      row: anchorRow({ startsOn: "2025-03-14T23:00:00Z", endsOn: "2025-03-15T01:00:00Z" }),
    },
  ];

  for (const testCase of cases) {
    const { adapter: live } = adapter([{ skip: 0, body: searchPage([testCase.row]) }]);
    const result = await live.fetch(TARGET);
    assert.equal(result.records.length, 0, testCase.label);
  }
});

test("branchIds is accepted as an alternative to branchId", async () => {
  const { adapter: live } = adapter([
    { skip: 0, body: searchPage([anchorRow({ branchId: 999, branchIds: [1, 56623] })]) },
  ]);
  const result = await live.fetch(TARGET);
  assert.equal(result.records.length, 1);
});

test("events that already ended or are in progress stay on their own day", async () => {
  // A date-scoped feed holds the whole selected day, so an evening refresh
  // never erases listings that finished earlier.
  const ended = adapter(
    [{ skip: 0, body: searchPage([anchorRow()]) }],
    Date.UTC(2025, 2, 13, 2), // after the 01:00Z end
  );
  assert.equal((await ended.adapter.fetch(TARGET)).records.length, 1);

  const inProgress = adapter(
    [{ skip: 0, body: searchPage([anchorRow()]) }],
    Date.UTC(2025, 2, 13, 0), // between start and end
  );
  assert.equal((await inProgress.adapter.fetch(TARGET)).records.length, 1);
});

test("a malformed required field fails the entire refresh", async () => {
  const malformed = [
    { label: "non-numeric id", row: anchorRow({ id: "abc" }) },
    { label: "blank name", row: anchorRow({ name: "   " }) },
    { label: "naive timestamp", row: anchorRow({ startsOn: "2025-03-12T18:00:00" }) },
    { label: "end before start", row: anchorRow({ endsOn: "2025-03-12T22:00:00Z" }) },
    { label: "benefits not a list", row: anchorRow({ benefitNames: "Free Food" }) },
    { label: "missing status", row: anchorRow({ status: 1 }) },
  ];

  for (const testCase of malformed) {
    const { adapter: live } = adapter([
      // A good row alongside the bad one: partial success must not be published.
      { skip: 0, body: searchPage([anchorRow({ id: 7 }), testCase.row]) },
    ]);
    await assert.rejects(
      () => live.fetch(TARGET),
      /invalid public event schema/,
      testCase.label,
    );
  }
});

test("a duplicate event id across pages fails the refresh", async () => {
  const { adapter: live } = adapter([
    { skip: 0, body: searchPage([anchorRow({ id: 1 })], 2) },
    { skip: 1, body: searchPage([anchorRow({ id: 1 })], 2) },
  ]);
  await assert.rejects(() => live.fetch(TARGET), /duplicate event id/);
});

test("an empty page before the reported total fails the refresh", async () => {
  const { adapter: live } = adapter([
    { skip: 0, body: searchPage([anchorRow({ id: 1 })], 5) },
    { skip: 1, body: searchPage([], 5) },
  ]);
  await assert.rejects(() => live.fetch(TARGET), /ended before the reported total/);
});

test("pagination walks every page and keeps every valid row", async () => {
  const { adapter: live, fetcher } = adapter([
    { skip: 0, body: searchPage([anchorRow({ id: 1 }), anchorRow({ id: 2 })], 3) },
    { skip: 2, body: searchPage([anchorRow({ id: 3 })], 3) },
  ]);
  const result = await live.fetch(TARGET);
  assert.equal(result.records.length, 3);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.reportedTotal, 3);
  assert.equal(fetcher.calls.length, 2);
});

test("a growing total is followed rather than truncated", async () => {
  const { adapter: live } = adapter([
    { skip: 0, body: searchPage([anchorRow({ id: 1 })], 1) },
    { skip: 1, body: searchPage([anchorRow({ id: 2 })], 2) },
  ]);
  // The first page reports 1; the second reports 2. The adapter must never
  // lower the target and accept a shrinking, incomplete result.
  const result = await live.fetch(TARGET);
  assert.equal(result.records.length, 1);
  assert.equal(result.reportedTotal, 1);
});

test("a listing HTTP failure aborts rather than publishing an empty day", async () => {
  const { adapter: live } = adapter([{ skip: 0, body: null, ok: false, status: 503 }]);
  await assert.rejects(() => live.fetch(TARGET), AnchorLinkFetchError);
});

test("an invalid response envelope aborts the refresh", async () => {
  const cases: { label: string; body: unknown; pattern: RegExp }[] = [
    { label: "not json", body: "<html>down</html>", pattern: /invalid JSON/ },
    { label: "not an object", body: [1, 2], pattern: /not an object/ },
    {
      label: "missing count",
      body: { value: [] },
      pattern: /no valid @odata\.count/,
    },
    {
      label: "negative count",
      body: { "@odata.count": -1, value: [] },
      pattern: /no valid @odata\.count/,
    },
    {
      label: "non-integer count",
      body: { "@odata.count": 1.5, value: [] },
      pattern: /no valid @odata\.count/,
    },
    {
      label: "boolean count",
      body: { "@odata.count": true, value: [] },
      pattern: /no valid @odata\.count/,
    },
    {
      label: "missing list",
      body: { "@odata.count": 0 },
      pattern: /no event list/,
    },
  ];

  for (const testCase of cases) {
    const { adapter: live } = adapter([{ skip: 0, body: testCase.body }]);
    await assert.rejects(() => live.fetch(TARGET), testCase.pattern, testCase.label);
  }
});

test("an implausible reported total is refused", async () => {
  const { adapter: live } = adapter([
    { skip: 0, body: { "@odata.count": 10_000_000, value: [anchorRow()] } },
  ]);
  await assert.rejects(() => live.fetch(TARGET), /implausible total/);
});

test("a genuine zero-match response is a real empty day, not an error", async () => {
  const { adapter: live } = adapter([{ skip: 0, body: searchPage([], 0) }]);
  const result = await live.fetch(TARGET);
  assert.deepEqual(result.records, []);
  assert.equal(result.reportedTotal, 0);
  assert.equal(result.pagesFetched, 1);
});
