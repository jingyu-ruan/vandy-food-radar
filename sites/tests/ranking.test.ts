/** Food-focused scoring, verification and deterministic order. */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultConfig } from "../lib/vfr/config.ts";
import { computeDedupKey, computeIdentityKey, deduplicate } from "../lib/vfr/dedup.ts";
import { classifyFood } from "../lib/vfr/food.ts";
import {
  FieldAgreement,
  FoodCategory,
  FoodConfirmed,
  DESIGN_SCORE_FACTORS,
  SCORE_FACTORS,
  VerificationState,
} from "../lib/vfr/models.ts";
import type { Event } from "../lib/vfr/models.ts";
import { normalize } from "../lib/vfr/normalize.ts";
import { buildExplanation, orderEvents, scoreEvent } from "../lib/vfr/ranking.ts";
import { verify } from "../lib/vfr/verify.ts";
import { WalkingStatus, walkingFactorValue } from "../lib/vfr/walking.ts";
import type { WalkingResult } from "../lib/vfr/walking.ts";

const UNKNOWN_WALK: WalkingResult = {
  status: WalkingStatus.UNKNOWN,
  distanceM: null,
  minutes: null,
};

function baseEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: "e1",
    dedupKey: "k1",
    identityKey: "source|anchorlink:1",
    anchorlinkId: "1",
    title: "Free Pizza Night",
    eventDate: "2025-03-12",
    startTime: "18:00",
    endTime: "20:00",
    startUtc: "2025-03-12T23:00:00Z",
    endUtc: "2025-03-13T01:00:00Z",
    endsNextDay: false,
    location: "Sarratt 216",
    locationGeo: null,
    organizer: "Student Life",
    rsvpRequired: null,
    rsvpUrl: null,
    rsvpLinkOk: null,
    eventUrl: "https://anchorlink.vanderbilt.edu/event/1",
    foodConfirmed: FoodConfirmed.CONFIRMED,
    foodCategory: FoodCategory.FULL_MEAL,
    foodDescription: "Free pizza and salad provided.",
    verificationState: VerificationState.PARTIALLY_VERIFIED,
    confidence: 0.3,
    scoreTotal: null,
    ...overrides,
  };
}

test("five food-focused factors sum to one and survive scoring", () => {
 const config=defaultConfig(),result=scoreEvent(baseEvent(),config,UNKNOWN_WALK);
 assert.deepEqual(config.ranking.weights,{food_confirmed:0.2,full_meal:0.3,food_specificity:0.25,timing:0.15,walking:0.1});
 assert.deepEqual(result.components.map(c=>c.factor),['food_confirmed','full_meal','food_specificity','timing','walking']);
 assert.equal(result.components.reduce((sum,c)=>sum+c.weight,0),1);
 assert.equal(result.event.scoreTotal,0.95);
});
test("real menu evidence increases the score; longer unrelated copy never does", () => {
 const value=(description:string)=>scoreEvent(baseEvent({foodDescription:description}),defaultConfig(),UNKNOWN_WALK).components.find(c=>c.factor==='food_specificity')!.rawValue;
 assert.equal(value('Free food provided.'),0);
 assert.equal(value('Free food provided. Join our distinguished guest for a detailed research discussion.'),0);
 assert.equal(value('Dinner will be provided.'),0);
 assert.equal(value('Pizza will be provided.'),1);
 assert.equal(value('Chick-fil-A will be provided.'),0.75);
 assert.equal(value('Dinner includes vegetarian and halal options.'),0.4);
 assert.equal(value('No pizza will be provided.'),0);
});
test("meal start windows distinguish meal time from mid-afternoon and late night",()=>{
 const value=(startTime:string|null)=>scoreEvent(baseEvent({startTime}),defaultConfig(),UNKNOWN_WALK).components.find(c=>c.factor==='timing')!.rawValue;
 for(const time of ['08:00','12:00','18:00']) assert.equal(value(time),1);
 assert.equal(value('15:00'),0.5);assert.equal(value('22:00'),0);assert.equal(value(null),0.5);
});
test("full meals beat unspecified food and confidence or access never alter the food score",()=>{
 const score=(event:Partial<Event>)=>scoreEvent(baseEvent(event),defaultConfig(),UNKNOWN_WALK).event.scoreTotal!;
 assert.ok(score({foodCategory:FoodCategory.FULL_MEAL})>score({foodCategory:FoodCategory.SNACKS_OR_REFRESHMENTS}));
 assert.ok(score({foodCategory:FoodCategory.SNACKS_OR_REFRESHMENTS})>score({foodCategory:FoodCategory.UNSPECIFIED}));
 assert.equal(score({confidence:0,rsvpRequired:true}),score({confidence:1,rsvpRequired:false}));
 assert.equal(score({organizer:'Members only'}),score({organizer:'Everyone welcome'}));
});

test("walking distance maps onto the documented ramp", () => {
  assert.equal(walkingFactorValue(UNKNOWN_WALK, 0.5), 0.5);
  assert.equal(
    walkingFactorValue({ status: WalkingStatus.OK, distanceM: 50, minutes: 1 }, 0.5),
    1,
  );
  assert.equal(
    walkingFactorValue({ status: WalkingStatus.OK, distanceM: 1600, minutes: 20 }, 0.5),
    0,
  );
  assert.equal(
    walkingFactorValue({ status: WalkingStatus.OK, distanceM: 850, minutes: 11 }, 0.5),
    0.5,
  );
});

test("ordering puts cancelled events last and is otherwise deterministic", () => {
  const scored = [
    { event: baseEvent({ id: "low", title: "Beta", scoreTotal: 0.4 }), components: [] },
    {
      event: baseEvent({
        id: "cancelled",
        title: "Alpha",
        scoreTotal: 0.9,
        verificationState: VerificationState.CANCELLED,
      }),
      components: [],
    },
    { event: baseEvent({ id: "high", title: "Gamma", scoreTotal: 0.8 }), components: [] },
    {
      event: baseEvent({ id: "tie-late", title: "Delta", scoreTotal: 0.4, startTime: "19:00" }),
      components: [],
    },
  ];
  const ordered = orderEvents(scored).map((entry) => entry.event.id);
  // high score first; equal scores break on the earlier start time; cancelled last
  assert.deepEqual(ordered, ["high", "low", "tie-late", "cancelled"]);
});

test("a cancelled event explains its own position", () => {
  assert.match(
    buildExplanation([], VerificationState.CANCELLED),
    /cancelled/,
  );
});

test("a single AnchorLink source is partially verified with confidence 0.30", () => {
  const config = defaultConfig();
  const record = {
    id: "anchorlink-1",
    sourceId: "anchor_link" as const,
    sourceUrl: "https://anchorlink.vanderbilt.edu/event/1",
    rawPayload: "{}",
    parsedFields: {
      title: "Free Pizza Night",
      event_date: "2025-03-12",
      start_time: "18:00",
      end_time: "20:00",
      location: "Sarratt 216",
      organizer: "Student Life",
      event_url: "https://anchorlink.vanderbilt.edu/event/1",
      anchorlink_id: "1",
      source_identity: "anchorlink:1",
      food_confirmed: "confirmed",
      food_description: "Free pizza and salad provided.",
      status: "Approved",
      cancelled: false,
    },
    checkedAt: "2025-03-12T12:00:00Z",
    parseStatus: "ok" as const,
    sourceUpdatedAt: null,
  };

  const merged = deduplicate([normalize(record)], config.dedup);
  assert.equal(merged.length, 1);

  const verified = verify(
    merged[0],
    new Map([[record.id, record]]),
    config,
    "2025-03-12T12:00:00Z",
  );

  // 0.5 * (0 agreed / 12 fields) + 0.2 * (no top authority) + 0.2 * confirmed
  // food + 0.1 * (unknown RSVP link treated as neutral) = 0.30
  assert.equal(verified.event.confidence, 0.3);
  assert.equal(verified.event.verificationState, VerificationState.PARTIALLY_VERIFIED);
  assert.notEqual(verified.event.verificationState, VerificationState.VERIFIED);
  // Nothing corroborates the single source, so every field is single-source.
  assert.ok(
    verified.provenance.every(
      (entry) =>
        entry.agreement === FieldAgreement.SINGLE_SOURCE ||
        entry.agreement === FieldAgreement.MISSING,
    ),
  );
  assert.deepEqual(verified.conflicts, []);
  // Unknowns stay unknown rather than being filled in.
  assert.equal(verified.event.rsvpRequired, null);
  assert.equal(verified.event.rsvpLinkOk, null);
  assert.equal(verified.event.locationGeo, null);
  // Identity is anchored on the source's own stable id.
  assert.equal(verified.event.identityKey, "source|anchorlink:1");
});

test("a cancelled title marker cancels the event and records the transition", () => {
  const config = defaultConfig();
  const record = {
    id: "anchorlink-2",
    sourceId: "anchor_link" as const,
    sourceUrl: null,
    rawPayload: null,
    parsedFields: {
      title: "[CANCELLED] Free Pizza Night",
      event_date: "2025-03-12",
      start_time: "18:00",
      food_confirmed: "confirmed",
      food_description: "pizza",
      source_identity: "anchorlink:2",
    },
    checkedAt: null,
    parseStatus: "ok" as const,
    sourceUpdatedAt: null,
  };
  const merged = deduplicate([normalize(record)], config.dedup);
  const verified = verify(
    merged[0],
    new Map([[record.id, record]]),
    config,
    "2025-03-12T12:00:00Z",
  );
  assert.equal(verified.event.verificationState, VerificationState.CANCELLED);
  assert.equal(verified.history.length, 1);
  assert.equal(verified.history[0].newValue, VerificationState.CANCELLED);
});

test("the identity key ignores venue and time so a change updates in place", () => {
  const before = computeIdentityKey("2025-03-12", "Free Pizza Night");
  const after = computeIdentityKey("2025-03-12", "Pizza Night (Free!)");
  assert.equal(before, after);
  // The dedup key, by contrast, does fold in venue and rounded start time.
  assert.notEqual(
    computeDedupKey("2025-03-12", "Pizza Night", "Hall A", "18:00"),
    computeDedupKey("2025-03-12", "Pizza Night", "Hall B", "18:00"),
  );
});

test("food classification stays a readable keyword table", () => {
  assert.equal(classifyFood("Free dinner provided").category, FoodCategory.FULL_MEAL);
  assert.equal(
    classifyFood("Light refreshments").category,
    FoodCategory.SNACKS_OR_REFRESHMENTS,
  );
  assert.equal(classifyFood("A talk about things").category, FoodCategory.UNSPECIFIED);
  assert.equal(classifyFood(null).category, FoodCategory.NONE);
  // A negation is checked before the positive keywords.
  assert.equal(classifyFood("No free food at this one").confirmed, FoodConfirmed.CONTRADICTED);
  assert.equal(classifyFood("Free food").confirmed, FoodConfirmed.CONFIRMED);
  // Whole-word matching: "oatmeal" is not "meal".
  assert.equal(classifyFood("oatmeal workshop").category, FoodCategory.UNSPECIFIED);
});
