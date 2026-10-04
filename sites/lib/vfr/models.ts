/**
 * Domain model for Vandy Food Radar.
 *
 * These are plain data shapes with no persistence or business logic, mirroring
 * the reference application's canonical/per-source separation so any
 * normalized field value can be explained from its provenance and conflicts.
 *
 * Discrete states are modelled as `as const` maps plus string-literal unions
 * rather than TypeScript `enum`s: enums are not erasable syntax, and these
 * modules must load unchanged both in the Worker bundle and under Node's
 * type-stripping test runner.
 */

/** Overall event-level verification state. */
export const VerificationState = {
  VERIFIED: "verified",
  PARTIALLY_VERIFIED: "partially_verified",
  CONFLICTING: "conflicting",
  FOOD_UNCONFIRMED: "food_unconfirmed",
  CANCELLED: "cancelled",
} as const;
export type VerificationState =
  (typeof VerificationState)[keyof typeof VerificationState];

/** Whether free food is confirmed for the event. */
export const FoodConfirmed = {
  CONFIRMED: "confirmed",
  UNCONFIRMED: "unconfirmed",
  CONTRADICTED: "contradicted",
} as const;
export type FoodConfirmed = (typeof FoodConfirmed)[keyof typeof FoodConfirmed];

/** Classified food signal. */
export const FoodCategory = {
  FULL_MEAL: "full_meal",
  SNACKS_OR_REFRESHMENTS: "snacks_or_refreshments",
  UNSPECIFIED: "unspecified",
  NONE: "none",
} as const;
export type FoodCategory = (typeof FoodCategory)[keyof typeof FoodCategory];

/** Identifier of an event data source. */
export const SourceId = {
  ANCHOR_LINK: "anchor_link",
  GOOGLE_CALENDAR: "google_calendar",
  OFFICIAL_PAGE: "official_page",
} as const;
export type SourceId = (typeof SourceId)[keyof typeof SourceId];

/** Outcome of fetching/parsing a source record. */
export const ParseStatus = {
  OK: "ok",
  PARSE_ERROR: "parse_error",
  FETCH_ERROR: "fetch_error",
} as const;
export type ParseStatus = (typeof ParseStatus)[keyof typeof ParseStatus];

/** How a canonical field's value was chosen across sources. */
export const FieldAgreement = {
  AGREED: "agreed",
  RESOLVED_CONFLICT: "resolved_conflict",
  SINGLE_SOURCE: "single_source",
  MISSING: "missing",
} as const;
export type FieldAgreement =
  (typeof FieldAgreement)[keyof typeof FieldAgreement];

/** Five food-focused factors, persisted in a fixed presentation order. */
export const DESIGN_SCORE_FACTORS = ["food_confirmed", "full_meal", "food_specificity", "timing", "walking"] as const;
export type DesignScoreFactor = (typeof DESIGN_SCORE_FACTORS)[number];
export const SCORE_FACTORS = DESIGN_SCORE_FACTORS;
export type ScoreFactor = DesignScoreFactor;

/** How a fresh event compares to the previously published feed. */
export const ChangeKind = {
  NEW: "new",
  TIME_CHANGED: "time_changed",
  VENUE_CHANGED: "venue_changed",
  CANCELLED: "cancelled",
  UNCHANGED: "unchanged",
} as const;
export type ChangeKind = (typeof ChangeKind)[keyof typeof ChangeKind];

/** A latitude/longitude coordinate pair. */
export type GeoPoint = { lat: number; lng: number };

/**
 * Canonical, normalized, merged event.
 *
 * `eventDate` is the local calendar date (`YYYY-MM-DD`) and `startTime`/
 * `endTime` are local wall-clock `HH:MM`. `startUtc`/`endUtc` retain the
 * absolute instants so a calendar export and any duration arithmetic stay
 * correct across daylight-saving transitions.
 *
 * `endsNextDay` is true for a cross-midnight event, whose local end time is
 * earlier in the day than its start.
 *
 * Tri-state fields use `null` for "unknown"; nothing is ever invented to fill
 * a gap.
 */
export type Event = {
  id: string;
  dedupKey: string;
  identityKey: string;
  anchorlinkId: string | null;
  title: string;
  eventDate: string;
  startTime: string | null;
  endTime: string | null;
  startUtc: string | null;
  endUtc: string | null;
  endsNextDay: boolean;
  location: string | null;
  locationGeo: GeoPoint | null;
  organizer: string | null;
  rsvpRequired: boolean | null;
  rsvpUrl: string | null;
  rsvpLinkOk: boolean | null;
  eventUrl: string | null;
  foodConfirmed: FoodConfirmed;
  foodCategory: FoodCategory;
  foodDescription: string | null;
  verificationState: VerificationState;
  confidence: number | null;
  scoreTotal: number | null;
};

/** Raw contribution from a single source for one event. */
export type SourceRecord = {
  id: string;
  sourceId: SourceId;
  sourceUrl: string | null;
  rawPayload: string | null;
  parsedFields: Record<string, unknown>;
  checkedAt: string | null;
  parseStatus: ParseStatus;
  sourceUpdatedAt: string | null;
};

/** Records how a single canonical field value was chosen. */
export type FieldProvenance = {
  fieldName: string;
  chosenValue: unknown;
  chosenSourceId: SourceId | null;
  agreement: FieldAgreement;
};

/** One source's value for a field involved in a conflict. */
export type CompetingValue = {
  value: unknown;
  sourceId: SourceId;
  sourceUpdatedAt: string | null;
};

/** A detected disagreement between sources for a field. */
export type Conflict = {
  fieldName: string;
  competingValues: CompetingValue[];
  resolution: string | null;
};

/** One factor's contribution to an event's total score. */
export type ScoreComponent = {
  factor: ScoreFactor;
  rawValue: number;
  weight: number;
  contribution: number;
  note: string;
};

/** A recorded change to a tracked event detail. */
export type EventHistoryEntry = {
  identityKey: string;
  changedAt: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string;
};
