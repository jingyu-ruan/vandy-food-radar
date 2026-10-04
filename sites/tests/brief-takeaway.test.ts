import assert from "node:assert/strict";
import test from "node:test";
import { ruleTakeaway } from "../lib/vfr/viewmodel.ts";
import type { CardJson } from "../lib/vfr/viewmodel.ts";

/** Only the fields the takeaway reads; the rest of a card is irrelevant here. */
function card(overrides: Partial<CardJson>): CardJson {
  return {
    identity_key: "event:1", title: "Event", cancelled: false, start: null, end: null,
    place: null, location_listed: null, food_items: undefined, description: null,
    food_category: "Unspecified", rsvp_label: "RSVP not stated",
    participation: { level: "unknown", note: "", certain: false, warnings: [] },
    ...overrides,
  } as unknown as CardJson;
}

test("rules fallback names the top non-cancelled pick with source fields and neutral wording", () => {
  const cards = [
    card({ identity_key: "a", title: "Cancelled Feast", cancelled: true, food_category: "Full meal", start: "12:00:00", end: "13:00:00" }),
    card({ identity_key: "b", title: "Taco Night", start: "17:30:00", end: "19:00:00", food_items: ["tacos", "churros"],
      place: { name: "Rand Hall", lat: 36.1, lng: -86.8, source_url: null, detail: "Room 2" }, rsvp_label: "RSVP required" }),
    card({ identity_key: "c", title: "Study Break", start: "18:00:00", end: "20:00:00" }),
  ];
  const text = ruleTakeaway(cards);
  assert.equal(text, "Top pick: Taco Night at Rand Hall, Room 2, starting at 5:30 PM. The listing names tacos and churros. RSVP is required, so register before you go.");
  assert.doesNotMatch(text, /Cancelled Feast|\btoday\b|\btonight\b|\d{4}-\d{2}-\d{2}|events are listed|below/i);
});

test("rules fallback never invents a menu or eligibility and reports a source-supported overlap", () => {
  const text = ruleTakeaway([
    card({ identity_key: "a", title: "Career Mixer", location_listed: "Alumni Hall", start: "12:00:00", end: "13:00:00", description: "Free food provided." }),
    card({ identity_key: "b", title: "Book Club", start: "12:30:00", end: "13:30:00" }),
  ]);
  assert.equal(text, "Top pick: Career Mixer at Alumni Hall, starting at 12 PM. It overlaps Book Club, so you may need to choose.");
  assert.doesNotMatch(text, /RSVP|eligib|menu|pizza/i);
  assert.equal(ruleTakeaway([card({ title: "Gone", cancelled: true })]), "Every listing for this date is marked cancelled, so there is no event to recommend.");
  assert.equal(ruleTakeaway([card({ title: "Seminar", participation: { level: "structured", note: "", certain: true, warnings: [] }, food_category: "Snacks" })]),
    "Top pick: Seminar. The listing advertises light refreshments. Plan to join the scheduled program rather than only stopping by for food.");
});
