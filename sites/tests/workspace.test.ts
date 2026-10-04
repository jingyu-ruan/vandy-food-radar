import assert from "node:assert/strict";
import { test } from "node:test";

import type { HttpFetcher } from "../lib/vfr/anchorlink.ts";
import { campusPlaces } from "../lib/vfr/campus-places.ts";
import { defaultConfig, parseRefreshDays } from "../lib/vfr/config.ts";
import { parseSelectedDate } from "../lib/vfr/feed.ts";
import { runRefresh } from "../lib/vfr/pipeline.ts";
import { scoreEvent } from "../lib/vfr/ranking.ts";
import { Repository } from "../lib/vfr/repository.ts";
import { parsePlaces } from "../lib/vfr/places.ts";
import { parseWaypoints, RouteError, routeResultToJson, WalkingRouter } from "../lib/vfr/routing.ts";
import { buildBrief } from "../lib/vfr/summary.ts";
import { localDateOf } from "../lib/vfr/time.ts";
import { buildCard, clientConfig, scriptJson } from "../lib/vfr/viewmodel.ts";
import { loadDayFeed, loadWeek } from "../lib/vfr/workspace.ts";
import { anchorRow, searchPage } from "./helpers.ts";
import { freshDatabase, SqliteD1 } from "./sqlite-d1.ts";

const TODAY = "2025-03-12";
const TOMORROW = "2025-03-13";
const NOW = Date.UTC(2025, 2, 12, 18);

function source(rows: Record<string, unknown[]>): HttpFetcher {
  return {
    async get(url) {
      const start = new URL(url).searchParams.get("startsAfter")!;
      const date = localDateOf(Date.parse(start) + 1000, "America/Chicago");
      const page = rows[date];
      if (!page) return { ok: false, status: 503, text: null, error: "source outage" };
      return { ok: true, status: 200, text: JSON.stringify(searchPage(page)), error: null };
    },
  };
}

function row(date: string, id: number, name: string) {
  return anchorRow({ id, name, startsOn: `${date}T18:00:00Z`, endsOn: `${date}T19:00:00Z` });
}

function setup() {
  const db = freshDatabase();
  const config = defaultConfig();
  const repository = new Repository(new SqliteD1(db), config);
  return { db, config, repository };
}

test("selected dates are exact and invalid dates fall back to the local day", () => {
  assert.equal(parseSelectedDate("2025-03-13", TODAY), TOMORROW);
  for (const invalid of [null, "", "2025-02-30", "2025-13-01", "2025-3-12", "2025-03-12junk"]) {
    assert.equal(parseSelectedDate(invalid, TODAY), TODAY);
  }
  assert.equal(parseRefreshDays("2"), 2);
  assert.equal(parseRefreshDays("7"), 7);
  for (const invalid of [null, "3", "7junk", "-1", "100000"]) {
    assert.equal(parseRefreshDays(invalid), 1);
  }
});

test("one refresh publishes two distinct days and a partial refresh preserves the other day", async () => {
  const { db, config, repository } = setup();
  const result = await runRefresh({ repository, config, nowMs: NOW, trigger: "test", days: 2,
    fetcher: source({ [TODAY]: [row(TODAY, 1, "Today pizza")], [TOMORROW]: [row(TOMORROW, 2, "Tomorrow dinner")] }) });
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(result.summary.published, 2);
  assert.deepEqual((await repository.lastSuccess())?.days, [TODAY, TOMORROW]);
  const day = await loadDayFeed(repository, config, TODAY, NOW);
  assert.deepEqual(day.events.map((event) => event.title), ["Today pizza"]);
  assert.ok(day.events.every((event) => event.date === TODAY));
  const week = await loadWeek(repository, config, TODAY, NOW);
  assert.equal(week.days.length, 7);
  assert.deepEqual(week.days[1].events.map((event) => event.title), ["Tomorrow dinner"]);
  assert.ok(week.days.every((bucket) => bucket.events.every((event) => event.date === bucket.date)));
  const oldTomorrow = await repository.readFeed(TOMORROW);
  const second = await runRefresh({ repository, config, nowMs: NOW + 1000, trigger: "test",
    fetcher: source({ [TODAY]: [] }) });
  assert.ok(second.ok);
  assert.deepEqual(await repository.readFeed(TOMORROW), oldTomorrow);
  assert.equal((await loadDayFeed(repository, config, TODAY, NOW)).state, "empty");
  db.close();
});

test("a second-day source outage leaves every previous day and last-success metadata intact", async () => {
  const { db, config, repository } = setup();
  assert.ok((await runRefresh({ repository, config, nowMs: NOW, trigger: "test", days: 2,
    fetcher: source({ [TODAY]: [row(TODAY, 1, "Old today")], [TOMORROW]: [row(TOMORROW, 2, "Old tomorrow")] }) })).ok);
  const before = await Promise.all([repository.readFeed(TODAY), repository.readFeed(TOMORROW), repository.lastSuccess()]);
  const result = await runRefresh({ repository, config, nowMs: NOW + 1000, trigger: "test", days: 2,
    fetcher: source({ [TODAY]: [row(TODAY, 1, "New today")] }) });
  assert.equal(result.ok, false);
  assert.deepEqual(await Promise.all([repository.readFeed(TODAY), repository.readFeed(TOMORROW), repository.lastSuccess()]), before);
  db.close();
});

test("a database failure on the second day rolls back the whole publication", async () => {
  const { db, config, repository } = setup();
  const rows = { [TODAY]: [row(TODAY, 1, "Old today")], [TOMORROW]: [row(TOMORROW, 2, "Old tomorrow")] };
  assert.ok((await runRefresh({ repository, config, nowMs: NOW, trigger: "test", days: 2, fetcher: source(rows) })).ok);
  const before = await Promise.all([repository.readFeed(TODAY), repository.readFeed(TOMORROW), repository.lastSuccess()]);
  db.exec(`CREATE TRIGGER reject_second_day BEFORE INSERT ON feeds
    WHEN NEW.target_date = '${TOMORROW}' BEGIN SELECT RAISE(ABORT, 'test write failure'); END;`);
  const result = await runRefresh({ repository, config, nowMs: NOW + 1000, trigger: "test", days: 2,
    fetcher: source({ [TODAY]: [], [TOMORROW]: [] }) });
  assert.equal(result.ok, false);
  assert.deepEqual(await Promise.all([repository.readFeed(TODAY), repository.readFeed(TOMORROW), repository.lastSuccess()]), before);
  db.close();
});

test("ended listings remain visible and recent time changes survive an unchanged refresh", async () => {
  const { db, config, repository } = setup();
  const ended = { ...row(TODAY, 1, "Morning pizza"), startsOn: `${TODAY}T15:00:00Z`, endsOn: `${TODAY}T16:00:00Z` };
  const refresh = (item: unknown, nowMs: number) => runRefresh({ repository, config, nowMs, trigger: "test", fetcher: source({ [TODAY]: [item] }) });
  assert.ok((await refresh(ended, NOW)).ok);
  const changed = { ...ended, startsOn: `${TODAY}T15:30:00Z` };
  assert.ok((await refresh(changed, NOW + 60000)).ok);
  const detected = (await repository.readFeed(TODAY))!.events[0].change!.detectedAt;
  assert.ok((await refresh(changed, NOW + 120000)).ok);
  const stored = (await repository.readFeed(TODAY))!.events[0];
  assert.equal(stored.change?.kind, "time_changed");
  assert.equal(stored.change?.detectedAt, detected);
  const context = { config, places: campusPlaces(), nowMs: NOW + 120000 };
  assert.equal(buildCard(stored, context).change, "Time changed");
  assert.equal(buildCard(stored, { ...context, nowMs: NOW + 25 * 3600000 }).change, null);
  assert.equal(stored.event.anchorlinkId, "1");
  db.close();
});

test("card links are safe, restrictions are warnings, and participation is independent of rating", async () => {
  const { db, config, repository } = setup();
  const restricted = row(TODAY, 1, "Members mixer");
  restricted.description = "Members only. Free pizza provided.";
  assert.ok((await runRefresh({ repository, config, nowMs: NOW, trigger: "test", fetcher: source({ [TODAY]: [restricted] }) })).ok);
  const stored = (await repository.readFeed(TODAY))!.events[0];
  stored.event.eventUrl = "javascript:alert(1)";
  stored.event.rsvpUrl = "data:text/html,unsafe";
  const card = buildCard(stored, { config, places: campusPlaces(), nowMs: NOW });
  assert.equal(card.event_url, null);
  assert.equal(card.rsvp_url, null);
  assert.equal(card.badge, null);
  assert.equal(card.change, null);
  assert.ok(card.warnings.some((warning) => /members only/i.test(warning)));
  assert.ok(card.place);
  config.referenceLocation = {label:"Another origin",lat:36.15,lng:-86.82};
  const changedPreferences = buildCard(stored, {config,places:campusPlaces(),nowMs:NOW + 3600000});
  assert.deepEqual(card.score_components, stored.components);
  assert.deepEqual(changedPreferences.score_components, card.score_components);
  assert.equal(changedPreferences.score, card.score);
  assert.equal(changedPreferences.stars, card.stars);
  const scored = scoreEvent(stored.event, config, { status: "unknown", minutes: null, distanceM: null });
  assert.ok(scored.components.every(component=>["food_confirmed","full_meal","food_specificity","timing","walking"].includes(component.factor)));
  db.close();
});

test("JSON embedded in HTML cannot close its script and contains no routing secrets", () => {
  const config = defaultConfig();
  config.routing.apiKey = "test-secret-route-key";
  config.mapsApiKey = "test-secret-map-key";
  config.refreshToken = "test-secret-refresh-key";
  config.gemini.apiKey = "test-secret-gemini-key";
  config.referenceLocation.label = "</script><script>alert(1)</script>";
  const encoded = scriptJson(clientConfig(config, TODAY, TODAY, true));
  assert.equal(encoded.includes("<"), false);
  assert.equal(encoded.includes("test-secret"), false);
  assert.equal(JSON.parse(encoded).reference.label, config.referenceLocation.label);
});

test("invalid campus dataset rows and partial name overlaps remain unresolved", () => {
  const dataset = parsePlaces([{ id: "hall", name: "Test Hall", aliases: ["TH"], lat: 36, lng: -86 },
    { id: "bad", name: "Bad Hall", aliases: [], lat: Infinity, lng: -86 }]);
  assert.equal(dataset.places.length, 1);
  assert.equal(dataset.resolve("Test Hallway"), null);
  assert.equal(dataset.resolve("Bad Hall"), null);
  assert.equal(dataset.resolve("TH, Room 2")?.detail, "Room 2");
});

test("walking validation rejects malformed, excessive, and distant waypoints", () => {
  const config = defaultConfig();
  const point = { lat: config.referenceLocation.lat, lng: config.referenceLocation.lng };
  for (const payload of [null, [], {}, { waypoints: [point] },
    { waypoints: [point, { lat: true, lng: -86 }] },
    { waypoints: [point, { lat: Infinity, lng: -86 }] },
    { waypoints: [point, { lat: 91, lng: -86 }] },
    { waypoints: [point, { lat: 0, lng: 0 }] },
    { waypoints: Array(13).fill(point) }]) {
    assert.throws(() => parseWaypoints(payload, config), RouteError);
  }
});

test("an unavailable routing provider yields a cached labelled estimate without a key", async () => {
  const config = defaultConfig();
  config.routing.apiKey = "test-route-secret";
  let calls = 0;
  const router = new WalkingRouter(config, { async postJson(body, options) {
    calls += 1;
    assert.deepEqual(Object.keys(body).sort(), ["coordinates", "instructions", "units"]);
    assert.equal(options.apiKey, config.routing.apiKey);
    return null;
  } });
  const points = parseWaypoints({ waypoints: [config.referenceLocation, { lat: 36.1455, lng: -86.8051 }] }, config);
  const result = await router.route(points);
  assert.equal(result.mode, "estimate");
  assert.match(result.detail, /did not answer/);
  assert.equal(result.legs.length, 1);
  assert.equal(await router.route(points), result);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(routeResultToJson(result)).includes("test-route-secret"), false);
});

test("daily brief cache changes when the source-derived summary changes", async () => {
  const { db, config, repository } = setup();
  assert.ok((await runRefresh({ repository, config, nowMs: NOW, trigger: "test", fetcher: source({ [TODAY]: [row(TODAY, 1, "Pizza lunch")] }) })).ok);
  const event = (await repository.readFeed(TODAY))!.events[0].event;
  const before = await buildBrief(TODAY, [event]);
  assert.equal(await buildBrief(TODAY, [event]), before);
  const after = await buildBrief(TODAY, [{ ...event, title: "Dinner instead" }]);
  assert.notEqual(after.contentHash, before.contentHash);
  assert.notEqual(after.headline, before.headline);
  db.close();
});
