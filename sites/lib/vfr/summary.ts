/**
 * Deterministic daily brief generated from the published feed.
 *
 * Ported from the Python reference (`vandy_food_radar/summary.py`). Two or
 * three sentences assembled by fixed rules from values already in the feed:
 * counts, the earliest start, how many describe a full meal or have food
 * confirmed, how many are cancelled or conflicting, and the top-ranked title.
 * No language model, no credential, and nothing asserted that is not
 * computable from the events. An empty day says so.
 *
 * Because it is a pure function of its inputs it is cached by a SHA-256 hash
 * of exactly the fields it reads.
 */

import { FoodCategory, FoodConfirmed, VerificationState } from "./models.ts";
import type { Event } from "./models.ts";

export type DailyBrief = {
  targetDate: string;
  headline: string;
  sentences: string[];
  contentHash: string;
  text: string;
};

export type BriefEvent = Pick<
  Event,
  | "identityKey"
  | "title"
  | "startTime"
  | "endTime"
  | "location"
  | "foodCategory"
  | "foodConfirmed"
  | "verificationState"
  | "scoreTotal"
>;

const CACHE_LIMIT = 64;
const cache = new Map<string, DailyBrief>();

/** 12-hour clock, matching the cards: "6 PM", "5:30 PM". */
export function formatClock(hhmm: string): string {
  const [hourText, minuteText] = hhmm.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return hhmm;
  const display = hour % 12 || 12;
  const suffix = hour < 12 ? "AM" : "PM";
  return minute ? `${display}:${String(minute).padStart(2, "0")} ${suffix}` : `${display} ${suffix}`;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compareRows(a: string[], b: string[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return a.length - b.length;
}

/** Hash exactly the fields the brief reads, in a stable order. */
export async function briefContentHash(targetDate: string, events: BriefEvent[]): Promise<string> {
  const rows = events
    .map((event) => [
      event.identityKey,
      event.title,
      event.startTime ? `${event.startTime}:00` : "",
      event.endTime ? `${event.endTime}:00` : "",
      event.location ?? "",
      event.foodCategory,
      event.foodConfirmed,
      event.verificationState,
      event.scoreTotal !== null ? event.scoreTotal.toFixed(6) : "",
    ])
    .sort(compareRows);
  let material = targetDate;
  for (const row of rows) material += `${row.join("\x1f")}\x1e`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return hex(digest);
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function compose(targetDate: string, events: BriefEvent[], key: string): DailyBrief {
  const finish = (headline: string, sentences: string[]): DailyBrief => ({
    targetDate,
    headline,
    sentences,
    contentHash: key,
    text: sentences.join(" "),
  });
  if (events.length === 0) {
    return finish("No listings", [
      "There are no events to display for this date.",
      "Check another date or try again after the next refresh.",
    ]);
  }

  const active = events.filter((event) => event.verificationState !== VerificationState.CANCELLED);
  const cancelled = events.length - active.length;
  const meals = active.filter((event) => event.foodCategory === FoodCategory.FULL_MEAL).length;
  const confirmed = active.filter((event) => event.foodConfirmed === FoodConfirmed.CONFIRMED).length;
  const conflicting = active.filter(
    (event) => event.verificationState === VerificationState.CONFLICTING,
  ).length;
  const starts = active
    .map((event) => event.startTime)
    .filter((start): start is string => Boolean(start))
    .sort();

  const sentences: string[] = [];
  if (active.length) {
    let lead = `${plural(active.length, "listing")} with free food`;
    if (starts.length) lead += `, starting from ${formatClock(starts[0])}`;
    sentences.push(`${lead}.`);
  } else {
    sentences.push("Every listing for this day is cancelled.");
  }

  if (meals) {
    sentences.push(
      meals === 1
        ? "1 event describes a full meal rather than snacks."
        : `${plural(meals, "event")} describe a full meal rather than snacks.`,
    );
  } else if (active.length) {
    sentences.push("All of them describe snacks or unspecified food.");
  }

  if (confirmed && confirmed < active.length) {
    sentences.push(`Free food is confirmed by a source for ${confirmed} of ${active.length}.`);
  } else if (active.length && confirmed === active.length) {
    sentences.push("Free food is confirmed by a source for all of them.");
  }

  const caveats: string[] = [];
  if (cancelled) caveats.push(`${plural(cancelled, "listing")} cancelled`);
  if (conflicting) caveats.push(`${plural(conflicting, "listing")} with conflicting details`);
  if (caveats.length) sentences.push(`Check ${caveats.join(" and ")}.`);

  const top = [...active].sort((a, b) => {
    const difference = (b.scoreTotal ?? 0) - (a.scoreTotal ?? 0);
    if (difference !== 0) return difference;
    const left = a.title.toLowerCase();
    const right = b.title.toLowerCase();
    return left < right ? -1 : left > right ? 1 : 0;
  })[0];
  const headline = top
    ? `${plural(active.length, "listing")} \u00b7 top: ${top.title}`
    : "All listings cancelled";
  return finish(headline, sentences);
}

/** Build (and cache) the brief for one local date. */
export async function buildBrief(targetDate: string, events: BriefEvent[]): Promise<DailyBrief> {
  const key = await briefContentHash(targetDate, events);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const brief = compose(targetDate, events, key);
  cache.set(key, brief);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return brief;
}
