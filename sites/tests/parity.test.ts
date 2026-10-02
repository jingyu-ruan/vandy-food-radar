/**
 * Behavioural parity with the Python reference.
 *
 * `fixtures/python-parity.json` was produced by running the Python
 * implementation (`vandy_food_radar`) on the inputs it lists: place
 * resolution against the shared campus dataset, participation assessment,
 * food excerpts, the daily brief and its content hash, recommendation stars,
 * time labels, and calendar windows. The TypeScript port must reproduce every
 * output exactly, so the two implementations cannot drift silently.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { campusPlaces } from "../lib/vfr/campus-places.ts";
import { foodExcerpt } from "../lib/vfr/excerpts.ts";
import { googleCalendarUrl, resolveWindow } from "../lib/vfr/ics.ts";
import { FoodCategory, FoodConfirmed, VerificationState } from "../lib/vfr/models.ts";
import type { Event } from "../lib/vfr/models.ts";
import {
  assessParticipation,
  participationFactorValue,
  participationWarnings,
} from "../lib/vfr/participation.ts";
import { defaultConfig } from "../lib/vfr/config.ts";
import { participationInputFor } from "../lib/vfr/participation.ts";
import { recommendationStars, scoreEvent } from "../lib/vfr/ranking.ts";
import { HaversineLocationProvider } from "../lib/vfr/walking.ts";
import { buildBrief } from "../lib/vfr/summary.ts";
import type { BriefEvent } from "../lib/vfr/summary.ts";
import { toIcsUtcStamp } from "../lib/vfr/time.ts";
import { formatTimeRange } from "../lib/vfr/viewmodel.ts";

type Fixture = {
  scoring: {
    title: string;
    location: string;
    description: string;
    organizer: string | null;
    startTime: string | null;
    rsvpRequired: boolean | null;
    confidence: number | null;
    foodCategory: FoodCategory;
    foodConfirmed: FoodConfirmed;
    total: number;
    components: { factor: string; raw: number; weight: number; contribution: number }[];
  }[];
  places: { location: string; id: string | null; detail: string | null; matched: string | null }[];
  participation: {
    description: string;
    title: string | null;
    organizer: string | null;
    level: string;
    note: string;
    certain: boolean;
    evidence: string[];
    warnings: string[];
    factor: number;
  }[];
  excerpts: { description: string | null; excerpt: string | null }[];
  briefs: {
    name: string;
    events: BriefEvent[];
    headline: string;
    sentences: string[];
    hash: string;
  }[];
  stars: { score: number | null; stars: number }[];
  ranges: { start: string | null; end: string | null; label: string }[];
  calendar: {
    date: string;
    start: string | null;
    end: string | null;
    allDay: boolean;
    startUtc: string | null;
    endUtc: string | null;
    crosses: boolean;
    google: string;
  }[];
};

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/python-parity.json", import.meta.url), "utf8"),
) as Fixture;

test("place resolution matches the reference on every listed location", () => {
  const places = campusPlaces();
  assert.equal(places.places.length, 58);
  for (const expected of fixture.places) {
    const resolved = places.resolve(expected.location);
    assert.deepEqual(
      {
        id: resolved?.place.id ?? null,
        detail: resolved?.detail ?? null,
        matched: resolved?.matchedText ?? null,
      },
      { id: expected.id, detail: expected.detail, matched: expected.matched },
      expected.location,
    );
  }
});

test("participation assessment matches the reference phrase for phrase", () => {
  for (const expected of fixture.participation) {
    const assessment = assessParticipation({
      title: expected.title,
      description: expected.description || null,
      organizer: expected.organizer,
      extraTexts: [],
    });
    assert.deepEqual(
      {
        level: assessment.level,
        note: assessment.note,
        certain: assessment.certain,
        evidence: assessment.evidence,
        warnings: participationWarnings(assessment),
        factor: participationFactorValue(assessment, 0.5),
      },
      {
        level: expected.level,
        note: expected.note,
        certain: expected.certain,
        evidence: expected.evidence,
        warnings: expected.warnings,
        factor: expected.factor,
      },
      expected.description,
    );
  }
});

test("food excerpts quote the same published sentences", () => {
  for (const expected of fixture.excerpts) {
    assert.equal(foodExcerpt(expected.description), expected.excerpt, String(expected.description));
  }
});

test("the daily brief and its content hash match the reference", async () => {
  for (const expected of fixture.briefs) {
    const brief = await buildBrief("2026-10-02", expected.events);
    assert.equal(brief.headline, expected.headline, expected.name);
    assert.deepEqual(brief.sentences, expected.sentences, expected.name);
    assert.equal(brief.contentHash, expected.hash, expected.name);
  }
});

test("recommendation stars and time labels match the reference", () => {
  for (const expected of fixture.stars) {
    assert.equal(recommendationStars(expected.score), expected.stars, String(expected.score));
  }
  for (const expected of fixture.ranges) {
    assert.equal(formatTimeRange(expected.start, expected.end), expected.label);
  }
});

test("calendar windows and Google prefill links match the reference", () => {
  for (const expected of fixture.calendar) {
    const event: Event = {
      id: "x",
      dedupKey: "x",
      identityKey: "source|anchorlink:9",
      anchorlinkId: "9",
      title: "Late Night, Pancakes; & More",
      eventDate: expected.date,
      startTime: expected.start,
      endTime: expected.end,
      // No absolute instants, so the local-time model is what is exercised.
      startUtc: null,
      endUtc: null,
      endsNextDay: false,
      location: "Sarratt Student Center, Room 216",
      locationGeo: null,
      organizer: "Student Life",
      rsvpRequired: null,
      rsvpUrl: null,
      rsvpLinkOk: null,
      eventUrl: "https://anchorlink.vanderbilt.edu/event/9",
      foodConfirmed: FoodConfirmed.CONFIRMED,
      foodCategory: FoodCategory.UNSPECIFIED,
      foodDescription: "Pancakes provided.",
      verificationState: VerificationState.PARTIALLY_VERIFIED,
      confidence: null,
      scoreTotal: null,
    };
    const window = resolveWindow(event, "America/Chicago");
    const label = `${expected.date} ${expected.start}-${expected.end}`;
    assert.equal(window.allDay, expected.allDay, label);
    if (!window.allDay) {
      assert.equal(toIcsUtcStamp(window.startMs), expected.startUtc, label);
      assert.equal(window.crossesMidnight, expected.crosses, label);
    }
    if (!window.allDay && expected.end === null) {
      // Deliberate improvement: the default duration is 60 real minutes. The
      // reference adds 60 wall-clock minutes, which on the fall-back night
      // (01:30 CDT -> 02:30 CST) silently becomes two hours.
      assert.equal(window.endMs - window.startMs, 60 * 60000, label);
      continue;
    }
    if (!window.allDay) assert.equal(toIcsUtcStamp(window.endMs), expected.endUtc, label);
    assert.equal(googleCalendarUrl(event, { timezone: "America/Chicago" }), expected.google, label);
  }
});

test("scores with a resolved walk and participation match the reference exactly", async () => {
  const config = defaultConfig();
  const places = campusPlaces();
  const provider = new HaversineLocationProvider();
  for (const expected of fixture.scoring) {
    const resolved = places.resolve(expected.location);
    const event: Event = {
      id: "s",
      dedupKey: "k",
      identityKey: "source|anchorlink:1",
      anchorlinkId: "1",
      title: expected.title,
      eventDate: "2026-10-02",
      startTime: expected.startTime,
      endTime: null,
      startUtc: null,
      endUtc: null,
      endsNextDay: false,
      location: expected.location,
      locationGeo: resolved?.place.point ?? null,
      organizer: expected.organizer,
      rsvpRequired: expected.rsvpRequired,
      rsvpUrl: null,
      rsvpLinkOk: null,
      eventUrl: null,
      foodConfirmed: expected.foodConfirmed,
      foodCategory: expected.foodCategory,
      foodDescription: expected.description,
      verificationState: VerificationState.PARTIALLY_VERIFIED,
      confidence: expected.confidence,
      scoreTotal: null,
    };
    const walk = await provider.walking(
      { lat: config.referenceLocation.lat, lng: config.referenceLocation.lng },
      event.locationGeo,
    );
    const result = scoreEvent(
      event,
      config,
      walk,
      assessParticipation(participationInputFor(event, [])),
    );
    assert.deepEqual(
      result.components.map((c) => ({
        factor: c.factor,
        raw: c.rawValue,
        weight: c.weight,
        contribution: c.contribution,
      })),
      expected.components,
      expected.title,
    );
    assert.equal(result.event.scoreTotal, expected.total, expected.title);
  }
});
