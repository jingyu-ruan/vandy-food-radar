/**
 * Verification: cross-check sources, resolve conflicts, derive state.
 *
 * For each canonical field this gathers every contributing source's value,
 * decides whether the sources agreed / disagree / are single-source / missing,
 * and on disagreement resolves by configured authority precedence with a
 * most-recent-update tie-break. Every losing value is preserved on the emitted
 * conflict so a discrepancy is never discarded.
 *
 * The result carries the canonical event with resolved values applied,
 * per-field provenance, preserved conflicts, a derived verification state, and
 * a deterministic confidence in [0, 1].
 *
 * A single-source AnchorLink feed therefore lands on "partially verified" with
 * confidence 0.30: no field ever agreed across sources, the top-authority
 * source is absent, food is confirmed, and the RSVP link is unknown. It is
 * never reported as fully "verified", because nothing independent corroborates
 * it.
 */

import type { Config } from "./config.ts";
import type { MergedEvent } from "./dedup.ts";
import {
  FieldAgreement,
  FoodCategory,
  FoodConfirmed,
  ParseStatus,
  VerificationState,
} from "./models.ts";
import type {
  CompetingValue,
  Conflict,
  Event,
  EventHistoryEntry,
  FieldProvenance,
  SourceId,
  SourceRecord,
} from "./models.ts";
import type { NormalizedRecord } from "./normalize.ts";

/** Canonical fields cross-checked across sources, in a stable order. */
export const CROSS_CHECKED_FIELDS = [
  "title",
  "eventDate",
  "startTime",
  "endTime",
  "location",
  "organizer",
  "rsvpRequired",
  "rsvpUrl",
  "eventUrl",
  "foodConfirmed",
  "foodCategory",
  "foodDescription",
] as const;
export type CrossCheckedField = (typeof CROSS_CHECKED_FIELDS)[number];

/** Fields whose disagreement makes the whole event conflicting. */
const KEY_FIELDS = new Set<CrossCheckedField>(["eventDate", "startTime", "location"]);

/** Weights for the deterministic confidence blend. These sum to 1.0. */
const W_AGREEMENT = 0.5;
const W_TOP_AUTHORITY = 0.2;
const W_FOOD = 0.2;
const W_RSVP = 0.1;

export type VerifiedEvent = {
  event: Event;
  provenance: FieldProvenance[];
  conflicts: Conflict[];
  history: EventHistoryEntry[];
};

type SourceValue = {
  sourceId: SourceId;
  value: unknown;
  sourceUpdatedAt: string | null;
  checkedAt: string | null;
};

function recency(value: SourceValue): string | null {
  return value.sourceUpdatedAt ?? value.checkedAt;
}

function usedCheckedAtFallback(value: SourceValue): boolean {
  return value.sourceUpdatedAt === null && value.checkedAt !== null;
}

/** A value counts as present unless it is null/undefined or blank text. */
function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

/** Collapse case and whitespace so trivially different renderings agree. */
function normalizeForCompare(value: unknown): unknown {
  if (typeof value === "string") return value.toLowerCase().split(/\s+/).join(" ");
  return value;
}

function authorityRank(sourceId: SourceId, precedence: SourceId[]): number {
  const index = precedence.indexOf(sourceId);
  return index === -1 ? precedence.length : index;
}

/**
 * Pick the authoritative, most-recent value deterministically: authority rank
 * ascending, then recency descending (missing timestamps sort oldest), then
 * source id for a fully stable order.
 */
function selectWinner(present: SourceValue[], config: Config): SourceValue {
  return [...present].sort((a, b) => {
    const rankDelta =
      authorityRank(a.sourceId, config.authorityPrecedence) -
      authorityRank(b.sourceId, config.authorityPrecedence);
    if (rankDelta !== 0) return rankDelta;
    const aTime = recency(a);
    const bTime = recency(b);
    const aMs = aTime ? Date.parse(aTime) : Number.NEGATIVE_INFINITY;
    const bMs = bTime ? Date.parse(bTime) : Number.NEGATIVE_INFINITY;
    if (aMs !== bMs) return bMs - aMs;
    return a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0;
  })[0];
}

function resolutionNote(winner: SourceValue): string {
  let note = `authority_precedence -> ${winner.sourceId}`;
  if (usedCheckedAtFallback(winner)) {
    note += " (recency tie-break used checked_at fallback)";
  }
  return note;
}

type FieldResolution = {
  provenance: FieldProvenance;
  conflict: Conflict | null;
  chosenValue: unknown;
};

function resolveField(
  fieldName: CrossCheckedField,
  values: SourceValue[],
  config: Config,
): FieldResolution {
  const present = values.filter((v) => isPresent(v.value));

  if (present.length === 0) {
    return {
      provenance: {
        fieldName,
        chosenValue: null,
        chosenSourceId: null,
        agreement: FieldAgreement.MISSING,
      },
      conflict: null,
      chosenValue: null,
    };
  }

  const distinct = new Set(present.map((v) => JSON.stringify(normalizeForCompare(v.value))));
  let agreement: FieldAgreement;
  if (present.length === 1) agreement = FieldAgreement.SINGLE_SOURCE;
  else if (distinct.size === 1) agreement = FieldAgreement.AGREED;
  else agreement = FieldAgreement.RESOLVED_CONFLICT;

  const winner = selectWinner(present, config);

  let conflict: Conflict | null = null;
  if (agreement === FieldAgreement.RESOLVED_CONFLICT) {
    const competingValues: CompetingValue[] = present.map((v) => ({
      value: v.value,
      sourceId: v.sourceId,
      sourceUpdatedAt: v.sourceUpdatedAt,
    }));
    conflict = { fieldName, competingValues, resolution: resolutionNote(winner) };
  }

  return {
    provenance: {
      fieldName,
      chosenValue: winner.value,
      chosenSourceId: winner.sourceId,
      agreement,
    },
    conflict,
    chosenValue: winner.value,
  };
}

function fieldValue(record: NormalizedRecord, fieldName: CrossCheckedField): unknown {
  return (record as unknown as Record<string, unknown>)[fieldName] ?? null;
}

/**
 * Split members into comparable and dropped. A record is dropped from field
 * comparison when either the normalized record or its originating source record
 * reports a non-ok parse status, so a failed fetch degrades gracefully.
 */
function comparableMembers(
  merged: MergedEvent,
  sourceRecords: Map<string, SourceRecord>,
): NormalizedRecord[] {
  return merged.members.filter((member) => {
    const source = sourceRecords.get(member.sourceRecordId);
    return (
      member.parseStatus === ParseStatus.OK &&
      (source === undefined || source.parseStatus === ParseStatus.OK)
    );
  });
}

type FoodState = { confirmed: FoodConfirmed; conflicting: boolean };

/**
 * Derive event-level food confirmation, flagging genuine disagreement.
 *
 * A confirmed claim on one source alongside a contradiction on another is an
 * active conflict. Confirmed alongside unconfirmed (a source that simply does
 * not mention food) is not fully verified and downgrades to unconfirmed.
 */
function resolveFood(members: NormalizedRecord[]): FoodState {
  const states = new Set(members.map((m) => m.foodConfirmed));
  if (
    states.size === 0 ||
    (states.size === 1 && states.has(FoodConfirmed.UNCONFIRMED))
  ) {
    return { confirmed: FoodConfirmed.UNCONFIRMED, conflicting: false };
  }
  const hasConfirmed = states.has(FoodConfirmed.CONFIRMED);
  const hasContradicted = states.has(FoodConfirmed.CONTRADICTED);
  if (hasConfirmed && hasContradicted) {
    return { confirmed: FoodConfirmed.CONTRADICTED, conflicting: true };
  }
  if (hasContradicted) {
    return { confirmed: FoodConfirmed.CONTRADICTED, conflicting: false };
  }
  if (hasConfirmed && states.has(FoodConfirmed.UNCONFIRMED)) {
    return { confirmed: FoodConfirmed.UNCONFIRMED, conflicting: false };
  }
  if (hasConfirmed) return { confirmed: FoodConfirmed.CONFIRMED, conflicting: false };
  return { confirmed: FoodConfirmed.UNCONFIRMED, conflicting: false };
}

/**
 * Align the food provenance row with the dedicated food resolver, so provenance
 * reflects the decision actually applied to the event rather than the generic
 * per-field result.
 */
function syncFoodProvenance(
  provenance: FieldProvenance[],
  state: FoodState,
  members: NormalizedRecord[],
): void {
  const row = provenance.find((p) => p.fieldName === "foodConfirmed");
  if (!row) return;
  row.chosenValue = state.confirmed;
  const states = new Set(members.map((m) => m.foodConfirmed));
  if (state.conflicting) row.agreement = FieldAgreement.RESOLVED_CONFLICT;
  else if (members.length >= 2 && states.size === 1) row.agreement = FieldAgreement.AGREED;
  else if (members.length === 1) row.agreement = FieldAgreement.SINGLE_SOURCE;
  else row.agreement = FieldAgreement.MISSING;
}

/**
 * Tri-state RSVP link health. `null` when no member advertises an RSVP URL;
 * otherwise true unless a source carrying an RSVP URL failed to fetch or parse.
 * Nothing is invented: an absent RSVP stays unknown.
 */
function rsvpLinkOk(
  members: NormalizedRecord[],
  sourceRecords: Map<string, SourceRecord>,
): boolean | null {
  let sawLink = false;
  for (const member of members) {
    if (member.rsvpUrl === null) continue;
    sawLink = true;
    const source = sourceRecords.get(member.sourceRecordId);
    if (source !== undefined && source.parseStatus !== ParseStatus.OK) return false;
  }
  return sawLink ? true : null;
}

function verificationStateFor(input: {
  keyConflict: boolean;
  anyConflict: boolean;
  hasMissingOrSingle: boolean;
  foodConfirmed: FoodConfirmed;
  foodConflicting: boolean;
}): VerificationState {
  if (input.foodConflicting || input.keyConflict) return VerificationState.CONFLICTING;
  if (input.foodConfirmed !== FoodConfirmed.CONFIRMED) {
    return VerificationState.FOOD_UNCONFIRMED;
  }
  if (input.anyConflict) return VerificationState.CONFLICTING;
  if (input.hasMissingOrSingle) return VerificationState.PARTIALLY_VERIFIED;
  return VerificationState.VERIFIED;
}

/**
 * Deterministic confidence in [0, 1]: a weighted blend of the fraction of
 * fields that agreed across sources, presence of the top-authority source,
 * food-confirmation status, and RSVP link health. An unknown RSVP link is
 * neutral so it neither rewards nor penalizes.
 */
function computeConfidence(input: {
  agreed: number;
  totalFields: number;
  hasTopAuthority: boolean;
  foodConfirmed: FoodConfirmed;
  rsvpLinkOk: boolean | null;
}): number {
  const agreementScore = input.totalFields ? input.agreed / input.totalFields : 0;
  const authorityScore = input.hasTopAuthority ? 1 : 0;
  const foodScore =
    input.foodConfirmed === FoodConfirmed.CONFIRMED
      ? 1
      : input.foodConfirmed === FoodConfirmed.UNCONFIRMED
        ? 0.4
        : 0;
  const rsvpScore = input.rsvpLinkOk === null ? 1 : input.rsvpLinkOk ? 1 : 0;
  const confidence =
    W_AGREEMENT * agreementScore +
    W_TOP_AUTHORITY * authorityScore +
    W_FOOD * foodScore +
    W_RSVP * rsvpScore;
  return Math.round(Math.max(0, Math.min(1, confidence)) * 10000) / 10000;
}

function applyField(
  event: Event,
  fieldName: CrossCheckedField,
  value: unknown,
): void {
  if (fieldName === "foodCategory") {
    if (value !== null && value !== undefined) {
      event.foodCategory = value as FoodCategory;
    }
    return;
  }
  // Event-level food confirmation is derived separately.
  if (fieldName === "foodConfirmed") return;
  if (value === null || value === undefined) return;
  (event as unknown as Record<string, unknown>)[fieldName] = value;
}

/** Cross-check, resolve conflicts, and derive verification state. */
export function verify(
  merged: MergedEvent,
  sourceRecords: Map<string, SourceRecord>,
  config: Config,
  nowIso: string,
): VerifiedEvent {
  const event: Event = { ...merged.event };
  const comparable = comparableMembers(merged, sourceRecords);

  const provenance: FieldProvenance[] = [];
  const conflicts: Conflict[] = [];
  let agreed = 0;
  let keyConflict = false;

  for (const fieldName of CROSS_CHECKED_FIELDS) {
    const values: SourceValue[] = comparable.map((member) => {
      const source = sourceRecords.get(member.sourceRecordId);
      return {
        sourceId: member.sourceId,
        value: fieldValue(member, fieldName),
        sourceUpdatedAt: source?.sourceUpdatedAt ?? null,
        checkedAt: source?.checkedAt ?? null,
      };
    });
    const resolution = resolveField(fieldName, values, config);
    provenance.push(resolution.provenance);
    if (resolution.conflict) conflicts.push(resolution.conflict);
    if (resolution.provenance.agreement === FieldAgreement.AGREED) agreed += 1;
    else if (resolution.provenance.agreement === FieldAgreement.RESOLVED_CONFLICT) {
      if (KEY_FIELDS.has(fieldName)) keyConflict = true;
    }
    applyField(event, fieldName, resolution.chosenValue);
  }

  const foodState = resolveFood(comparable);
  event.foodConfirmed = foodState.confirmed;
  syncFoodProvenance(provenance, foodState, comparable);

  // RSVP health considers every member, including a dropped source page whose
  // own RSVP link is what failed.
  event.rsvpLinkOk = rsvpLinkOk(merged.members, sourceRecords);

  const topAuthority = config.authorityPrecedence[0] ?? null;
  event.confidence = computeConfidence({
    agreed,
    totalFields: CROSS_CHECKED_FIELDS.length,
    hasTopAuthority: comparable.some((m) => m.sourceId === topAuthority),
    foodConfirmed: event.foodConfirmed,
    rsvpLinkOk: event.rsvpLinkOk,
  });

  const history: EventHistoryEntry[] = [];
  const cancelled = comparable.some((member) => member.cancelled);
  if (cancelled) {
    event.verificationState = VerificationState.CANCELLED;
    history.push({
      identityKey: event.identityKey,
      changedAt: nowIso,
      fieldName: "verificationState",
      oldValue: null,
      newValue: VerificationState.CANCELLED,
      reason: "cancellation signal detected from an authoritative source",
    });
  } else {
    event.verificationState = verificationStateFor({
      keyConflict,
      anyConflict: conflicts.length > 0,
      hasMissingOrSingle: provenance.some(
        (p) =>
          p.agreement === FieldAgreement.SINGLE_SOURCE ||
          p.agreement === FieldAgreement.MISSING,
      ),
      foodConfirmed: event.foodConfirmed,
      foodConflicting: foodState.conflicting,
    });
  }

  return { event, provenance, conflicts, history };
}
