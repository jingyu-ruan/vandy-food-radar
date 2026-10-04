/** Five transparent food-focused factors. Cancelled events sort last. */
import type { Config } from "./config.ts";
import { FoodCategory, FoodConfirmed, SCORE_FACTORS, VerificationState } from "./models.ts";
import type { Event, ScoreComponent, ScoreFactor } from "./models.ts";
import type { ParticipationAssessment } from "./participation.ts";
import {menuSpecificity} from "./menu-specificity.ts";
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

export type ScoredEvent = { event: Event; components: ScoreComponent[] };

function round(value: number, places: number): number {
  if (!Number.isFinite(value) || value === 0) return value;
  // Round the exact IEEE-754 value with ties to even, matching Python round.
  // Multiplying before Math.round can manufacture a tie from a value just
  // below one (for example 0.0475 * 0.625 at six decimal places).
  const buffer = new ArrayBuffer(8);
  const bits = new DataView(buffer);
  bits.setFloat64(0, Math.abs(value));
  const encoded = bits.getBigUint64(0);
  const exponent = Number((encoded >> 52n) & 0x7ffn);
  const fraction = encoded & ((1n << 52n) - 1n);
  let numerator = (exponent === 0 ? fraction : fraction | (1n << 52n)) * 10n ** BigInt(places);
  const power = exponent === 0 ? -1074 : exponent - 1023 - 52;
  let denominator = 1n;
  if (power >= 0) numerator <<= BigInt(power);
  else denominator <<= BigInt(-power);
  let rounded = numerator / denominator;
  const twiceRemainder = (numerator % denominator) * 2n;
  if (twiceRemainder > denominator || (twiceRemainder === denominator && rounded % 2n !== 0n)) {
    rounded += 1n;
  }
  return Math.sign(value) * Number(rounded) / 10 ** places;
}

/** Start-time proximity to breakfast, lunch or dinner; unknown stays neutral. */
function timingValue(event: Event, config: Config): number {
  if (event.startTime===null) return 0.5;
  const [h,m]=event.startTime.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 0.5;
  const hour=h+m/60;
  const gap=Math.min(...config.ranking.mealWindows.map(([start,end])=>hour<start ? start-hour : hour>end ? hour-end : 0));
  return round(Math.max(0,1-gap/2),4);
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

function walkingNote(result: WalkingResult): string {
  if (result.status === "ok" && result.minutes !== null) {
    return `about a ${result.minutes} min walk`;
  }
  return "walking distance unavailable";
}

/** Persist each factor and its explanation at publication time. */
export function scoreEvent(
  event: Event,
  config: Config,
  walking: WalkingResult,
  participation?: ParticipationAssessment,
): ScoredEvent {
  const weights=config.ranking.weights;
  const menu=menuSpecificity(event.foodDescription);
  const rawValues:Record<ScoreFactor,number>={
    food_confirmed:FOOD_CONFIRMED_VALUE[event.foodConfirmed] ?? 0.3,
    full_meal:FULL_MEAL_VALUE[event.foodCategory] ?? 0.2,
    food_specificity:event.foodConfirmed===FoodConfirmed.CONTRADICTED ? 0 : menu.value,
    timing:timingValue(event,config),
    walking:walkingFactorValue(walking,config.ranking.walkingUnknownValue),
  };
  const notes:Record<ScoreFactor,string>={
    food_confirmed:foodConfirmedNote(event),full_meal:fullMealNote(event),
    food_specificity:event.foodConfirmed===FoodConfirmed.CONTRADICTED ? 'Food provision is contradicted.' : menu.note,
    timing:event.startTime ? `Starts at ${event.startTime}; breakfast 7–10 AM, lunch 11 AM–2 PM, dinner 5–8 PM.` : 'Start Time Unknown',
    walking:walkingNote(walking),
  };

  const components: ScoreComponent[] = [];
  let total = 0;
  for (const factor of SCORE_FACTORS) {
    const weight =
      weights[factor] ?? 0;
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

/**
 * Map a total score to the 0-5 recommendation stars on a card. The scale is
 * fixed and linear over [0, 1], so equal scores always show equal stars.
 */
export function recommendationStars(scoreTotal: number | null): number {
  if (scoreTotal === null || !Number.isFinite(scoreTotal)) return 0;
  const clamped = Math.min(Math.max(scoreTotal, 0), 1);
  return pythonRound(clamped * 5);
}

/** Round half to even, as Python's `round` does, so stars match the reference. */
function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (Math.abs(fraction - 0.5) < 1e-12) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(value);
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
