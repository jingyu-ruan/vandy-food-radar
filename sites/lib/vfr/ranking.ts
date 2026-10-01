/**
 * Transparent weighted-sum ranking.
 *
 * Each factor is normalized to [0, 1], multiplied by its configured weight, and
 * summed: `scoreTotal = sum(weight_f * value_f)`. Every factor's raw value,
 * weight, contribution, and an explanatory note are retained, so a total is
 * always fully explainable and nothing about a rank is opaque.
 *
 * Ordering is deterministic: cancelled events last, then score descending, then
 * the earlier start time, then title ascending.
 */

import type { Config } from "./config.ts";
import { FoodCategory, FoodConfirmed, SCORE_FACTORS, VerificationState } from "./models.ts";
import type { Event, ScoreComponent, ScoreFactor } from "./models.ts";
import { walkingFactorValue } from "./walking.ts";
import type { WalkingResult } from "./walking.ts";

const FOOD_CONFIRMED_VALUE: Record<FoodConfirmed, number> = {
  confirmed: 1,
  unconfirmed: 0.3,
  contradicted: 0,
};

const FULL_MEAL_VALUE: Record<FoodCategory, number> = {
  full_meal: 1,
  snacks_or_refreshments: 0.4,
  unspecified: 0.2,
  none: 0,
};

/** Words that add no menu specificity when counting named food items. */
const GENERIC_FOOD_WORDS = new Set([
  "food",
  "free",
  "and",
  "the",
  "a",
  "an",
  "of",
  "with",
  "for",
  "provided",
  "served",
  "included",
  "refreshments",
  "snacks",
  "snack",
  "light",
  "bites",
  "drinks",
  "all",
  "students",
  "some",
  "will",
  "be",
]);

export type ScoredEvent = { event: Event; components: ScoreComponent[] };

/**
 * Distinct non-generic words from a description, in stable order.
 *
 * These are description-detail terms, not identified foods: the rule counts
 * words, so it cannot tell a dish from any other specific noun. The word list
 * and the count are inherited unchanged from the reference application.
 */
function namedFoodTerms(description: string | null): string[] {
  if (!description) return [];
  const seen: string[] = [];
  for (const match of description.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (match.length <= 2 || GENERIC_FOOD_WORDS.has(match)) continue;
    if (!seen.includes(match)) seen.push(match);
  }
  return seen;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Scale by description detail: zero qualifying terms scores 0.0 and each
 * distinct non-generic word adds 0.25, capped at 1.0. The rule is inherited
 * verbatim from the reference application, so its arithmetic is fixed.
 */
function foodSpecificityValue(event: Event): number {
  return round(Math.min(1, 0.25 * namedFoodTerms(event.foodDescription).length), 4);
}

/** Likelihood of actually receiving food, given RSVP status. */
function rsvpLikelihoodValue(event: Event): number {
  if (event.rsvpRequired === false) return 1;
  if (event.rsvpRequired === true) return event.rsvpLinkOk === false ? 0.3 : 0.7;
  return 0.5;
}

/**
 * Preference curve over the start time: full value inside the configured good
 * window, decaying linearly to zero four hours past either edge. An unknown
 * start time is neutral.
 */
function timingValue(event: Event, config: Config): number {
  const start = event.startTime;
  if (start === null) return 0.5;
  const [h, m] = start.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0.5;
  const hour = h + m / 60;
  const goodStart = config.ranking.timingGoodStartHour;
  const goodEnd = config.ranking.timingGoodEndHour;
  if (hour >= goodStart && hour <= goodEnd) return 1;
  const gap = hour < goodStart ? goodStart - hour : hour - goodEnd;
  return round(Math.max(0, 1 - gap / 4), 4);
}

function foodConfirmedNote(event: Event): string {
  if (event.foodConfirmed === FoodConfirmed.CONFIRMED) return "free food is confirmed";
  if (event.foodConfirmed === FoodConfirmed.CONTRADICTED) {
    return "sources disagree on whether food is provided";
  }
  return "free food is not confirmed";
}

function fullMealNote(event: Event): string {
  if (event.foodCategory === FoodCategory.FULL_MEAL) return "appears to be a full meal";
  if (event.foodCategory === FoodCategory.SNACKS_OR_REFRESHMENTS) {
    return "snacks or refreshments only";
  }
  if (event.foodCategory === FoodCategory.NONE) return "no food described";
  return "food type unspecified";
}

/**
 * Describe the specificity factor without asserting that its terms are foods.
 *
 * The counted words are simply non-generic words from the description. Naming
 * them as a menu claimed evidence the source never gave: "hosted", "student",
 * and "october" are not food items. The numeric rule is unchanged; only the
 * wording is now accurate about what was measured.
 */
function foodSpecificityNote(event: Event): string {
  const count = namedFoodTerms(event.foodDescription).length;
  if (count === 0) return "limited description detail";
  return "source description contains additional detail";
}

function rsvpLikelihoodNote(event: Event): string {
  if (event.rsvpRequired === false) return "no RSVP needed";
  if (event.rsvpRequired === true) {
    return event.rsvpLinkOk === false
      ? "RSVP required but the link looks broken"
      : "RSVP required";
  }
  return "RSVP requirement unknown";
}

function timingNote(event: Event): string {
  return event.startTime === null
    ? "start time unknown"
    : `starts at ${event.startTime}`;
}

function walkingNote(result: WalkingResult): string {
  if (result.status === "ok" && result.minutes !== null) {
    return `about a ${result.minutes} min walk`;
  }
  return "walking distance unavailable";
}

function confidenceNote(event: Event): string {
  if (event.confidence === null) return "confidence unknown";
  return `verified with ${Math.round(event.confidence * 100)}% confidence`;
}

/** Score one event, producing its total and the full per-factor breakdown. */
export function scoreEvent(
  event: Event,
  config: Config,
  walking: WalkingResult,
): ScoredEvent {
  const weights = config.ranking.weights;
  const rawValues: Record<ScoreFactor, number> = {
    food_confirmed: FOOD_CONFIRMED_VALUE[event.foodConfirmed] ?? 0.3,
    full_meal: FULL_MEAL_VALUE[event.foodCategory] ?? 0.2,
    food_specificity: foodSpecificityValue(event),
    rsvp_likelihood: rsvpLikelihoodValue(event),
    timing: timingValue(event, config),
    walking: walkingFactorValue(walking, config.ranking.walkingUnknownValue),
    confidence: event.confidence ?? 0.5,
  };
  const notes: Record<ScoreFactor, string> = {
    food_confirmed: foodConfirmedNote(event),
    full_meal: fullMealNote(event),
    food_specificity: foodSpecificityNote(event),
    rsvp_likelihood: rsvpLikelihoodNote(event),
    timing: timingNote(event),
    walking: walkingNote(walking),
    confidence: confidenceNote(event),
  };

  const components: ScoreComponent[] = [];
  let total = 0;
  for (const factor of SCORE_FACTORS) {
    const weight = weights[factor] ?? 0;
    const raw = rawValues[factor];
    const contribution = round(weight * raw, 6);
    total += contribution;
    components.push({
      factor,
      rawValue: round(raw, 4),
      weight,
      contribution,
      note: notes[factor],
    });
  }

  return {
    event: { ...event, scoreTotal: round(total, 6) },
    components,
  };
}

function timeOrdinal(value: string | null): number {
  if (value === null) return Number.POSITIVE_INFINITY;
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return Number.POSITIVE_INFINITY;
  return h * 60 + m;
}

/** Deterministic display order: cancelled last, score desc, time, title. */
export function orderEvents(scored: ScoredEvent[]): ScoredEvent[] {
  return [...scored].sort((a, b) => {
    const aCancelled =
      a.event.verificationState === VerificationState.CANCELLED ? 1 : 0;
    const bCancelled =
      b.event.verificationState === VerificationState.CANCELLED ? 1 : 0;
    if (aCancelled !== bCancelled) return aCancelled - bCancelled;
    const aScore = a.event.scoreTotal ?? 0;
    const bScore = b.event.scoreTotal ?? 0;
    if (aScore !== bScore) return bScore - aScore;
    const aTime = timeOrdinal(a.event.startTime);
    const bTime = timeOrdinal(b.event.startTime);
    if (aTime !== bTime) return aTime - bTime;
    const aTitle = a.event.title.toLowerCase();
    const bTitle = b.event.title.toLowerCase();
    return aTitle < bTitle ? -1 : aTitle > bTitle ? 1 : 0;
  });
}

/** How many of the highest-contributing factors to mention. */
const MAX_REASONS = 4;

/**
 * A short "why this rank" sentence built from the top-contributing factors, so
 * a user can see exactly why one event ranks above another.
 */
export function buildExplanation(
  components: ScoreComponent[],
  verificationState: VerificationState,
): string {
  if (verificationState === VerificationState.CANCELLED) {
    return "Ranked at the bottom: this event is cancelled.";
  }
  if (components.length === 0) {
    return "No ranking factors were available for this event.";
  }
  const ordered = components
    .map((component, index) => ({ component, index }))
    .sort(
      (a, b) =>
        b.component.contribution - a.component.contribution || a.index - b.index,
    );
  const reasons = ordered
    .slice(0, MAX_REASONS)
    .map((entry) => entry.component.note)
    .filter(Boolean);
  const total = components.reduce((sum, c) => sum + c.contribution, 0);
  const lead = total >= 0.6 ? "Ranked high" : "Ranked lower";
  return reasons.length > 0 ? `${lead}: ${reasons.join(", ")}.` : `${lead}.`;
}
