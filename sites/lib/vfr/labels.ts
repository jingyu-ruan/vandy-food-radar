/**
 * Display labels.
 *
 * Kept apart from the pipeline so wording changes never touch stored data, and
 * so every "unknown" in the UI maps to a real unknown in the model rather than
 * to an invented default.
 */

import { ChangeKind, FoodConfirmed, VerificationState } from "./models.ts";
import type { Event } from "./models.ts";

export const STATE_LABELS: Record<VerificationState, string> = {
  verified: "Verified",
  partially_verified: "Partially verified",
  conflicting: "Conflicting info",
  food_unconfirmed: "Food unconfirmed",
  cancelled: "Cancelled",
};

export const CHANGE_LABELS: Record<Exclude<ChangeKind, "unchanged">, string> = {
  new: "New",
  time_changed: "Time changed",
  venue_changed: "Venue changed",
  cancelled: "Cancelled",
};

export const FOOD_LABELS: Record<FoodConfirmed, string> = {
  confirmed: "Food confirmed",
  unconfirmed: "Food unconfirmed",
  contradicted: "Food disputed",
};

export const FOOD_CATEGORY_LABELS: Record<string, string> = {
  full_meal: "Full meal",
  snacks_or_refreshments: "Snacks or refreshments",
  unspecified: "Type unspecified",
  none: "No food described",
};

export const FACTOR_LABELS: Record<string, string> = {
  food_confirmed: "Food confirmed",
  full_meal: "Full meal",
  food_specificity: "Description detail",
  rsvp_likelihood: "RSVP likelihood",
  timing: "Timing",
  walking: "Walking",
  confidence: "Verification confidence",
};

export const AGREEMENT_LABELS: Record<string, string> = {
  agreed: "Sources agreed",
  resolved_conflict: "Conflict resolved",
  single_source: "Single source",
  missing: "Not provided",
};

export const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  eventDate: "Date",
  startTime: "Start time",
  endTime: "End time",
  location: "Location",
  organizer: "Organizer",
  rsvpRequired: "RSVP required",
  rsvpUrl: "RSVP link",
  eventUrl: "Event link",
  foodConfirmed: "Food confirmed",
  foodCategory: "Food category",
  foodDescription: "Food description",
  verificationState: "Verification state",
};

export const SOURCE_LABELS: Record<string, string> = {
  anchor_link: "AnchorLink",
  google_calendar: "Google Calendar",
  official_page: "Official page",
};

/** Local clock range, marking a cross-midnight end explicitly. */
export function formatTimeRange(event: Event): string {
  if (event.startTime === null) return "Time to be announced";
  if (event.endTime === null) return event.startTime;
  const suffix = event.endsNextDay ? " (next day)" : "";
  return `${event.startTime}\u2013${event.endTime}${suffix}`;
}

export function formatRsvp(event: Event): string {
  if (event.rsvpRequired === null) return "RSVP unknown";
  if (!event.rsvpRequired) return "No RSVP needed";
  if (event.rsvpLinkOk === false) return "RSVP required (link looks broken)";
  return "RSVP required";
}

/** A friendly, unambiguous rendering of a published-at instant. */
export function formatPublishedAt(iso: string | null, timeZone: string): string {
  if (!iso) return "never";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "unknown";
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ms));
}

/** Readable relative age, for the "last updated" line. */
export function formatAge(ageMs: number | null): string {
  if (ageMs === null) return "unknown";
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Long-form target date, e.g. "Thursday, October 2, 2025". */
export function formatTargetDate(isoDate: string, timeZone: string): string {
  const ms = Date.parse(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(ms)) return isoDate;
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(ms));
}
