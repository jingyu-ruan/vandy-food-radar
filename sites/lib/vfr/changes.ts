/**
 * Cross-run change detection.
 *
 * Compares a fresh run's canonical events against the previously published feed
 * for the same target day and classifies each event by its stable identity.
 * Pure and deterministic: it only looks at the events handed to it.
 *
 * Classification precedence, highest first:
 * cancelled > time changed > venue changed > new > unchanged.
 *
 * An event that simply stops appearing in the source is *not* classified as
 * cancelled. A disappearance has many innocent explanations (visibility change,
 * reschedule, upstream edit) and is no proof the event was called off, so no
 * cancellation is ever inferred from absence.
 */

import { ChangeKind, VerificationState } from "./models.ts";
import type { Event } from "./models.ts";

export type ChangeRecord = { kind: ChangeKind; detail: string | null };

function classify(fresh: Event, previous: Event): ChangeRecord {
  const wasCancelled = previous.verificationState === VerificationState.CANCELLED;
  const isCancelled = fresh.verificationState === VerificationState.CANCELLED;
  if (isCancelled && !wasCancelled) {
    return { kind: ChangeKind.CANCELLED, detail: null };
  }
  if (fresh.startTime !== previous.startTime || fresh.endTime !== previous.endTime) {
    const before = `${previous.startTime ?? "?"}–${previous.endTime ?? "?"}`;
    const after = `${fresh.startTime ?? "?"}–${fresh.endTime ?? "?"}`;
    return { kind: ChangeKind.TIME_CHANGED, detail: `${before} → ${after}` };
  }
  if (fresh.location !== previous.location) {
    const before = previous.location ?? "unknown";
    const after = fresh.location ?? "unknown";
    return { kind: ChangeKind.VENUE_CHANGED, detail: `${before} → ${after}` };
  }
  return { kind: ChangeKind.UNCHANGED, detail: null };
}

/**
 * Classify each fresh event against the previous publication.
 *
 * A missing or empty `previous` means the day has no prior publication to
 * compare against, so every fresh event is new.
 */
export function detectChanges(
  fresh: Event[],
  previous: Event[] | null,
): Map<string, ChangeRecord> {
  const previousByKey = new Map<string, Event>();
  for (const event of previous ?? []) previousByKey.set(event.identityKey, event);

  const changes = new Map<string, ChangeRecord>();
  for (const event of fresh) {
    const prior = previousByKey.get(event.identityKey);
    changes.set(
      event.identityKey,
      prior === undefined ? { kind: ChangeKind.NEW, detail: null } : classify(event, prior),
    );
  }
  return changes;
}

export type ChangeCounts = {
  new: number;
  time_changed: number;
  venue_changed: number;
  cancelled: number;
  unchanged: number;
};

export function tallyChanges(changes: Map<string, ChangeRecord>): ChangeCounts {
  const counts: ChangeCounts = {
    new: 0,
    time_changed: 0,
    venue_changed: 0,
    cancelled: 0,
    unchanged: 0,
  };
  for (const record of changes.values()) counts[record.kind] += 1;
  return counts;
}

/** Canonical fields whose change between publications is recorded as history. */
export const TRACKED_FIELDS = [
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
  "verificationState",
] as const;

function trackedValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/**
 * Build history rows for tracked fields that changed between publications.
 *
 * When the fresh event is cancelled, `verificationState` is skipped here because
 * verification already emits a dedicated cancellation-transition entry; letting
 * the generic diff also fire would double-record the same transition.
 */
export function diffHistory(
  previous: Event | null,
  current: Event,
  changedAt: string,
): {
  identityKey: string;
  changedAt: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string;
}[] {
  if (previous === null) return [];
  const cancelledNow = current.verificationState === VerificationState.CANCELLED;
  const entries: {
    identityKey: string;
    changedAt: string;
    fieldName: string;
    oldValue: string | null;
    newValue: string | null;
    reason: string;
  }[] = [];
  for (const fieldName of TRACKED_FIELDS) {
    if (fieldName === "verificationState" && cancelledNow) continue;
    const oldValue = trackedValue(
      (previous as unknown as Record<string, unknown>)[fieldName],
    );
    const newValue = trackedValue(
      (current as unknown as Record<string, unknown>)[fieldName],
    );
    if (oldValue !== newValue) {
      entries.push({
        identityKey: current.identityKey,
        changedAt,
        fieldName,
        oldValue,
        newValue,
        reason: "value changed on re-run",
      });
    }
  }
  return entries;
}
