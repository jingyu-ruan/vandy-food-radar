/**
 * Deterministic deduplication and merge.
 *
 * Within each event-date block, normalized records are clustered by a
 * transparent weighted similarity score against configurable thresholds:
 * at or above the merge threshold they are the same event, in the review band
 * they merge and are flagged as a possible duplicate, and below it they stay
 * separate.
 *
 * There is no machine learning here. Every score is a string/number
 * computation a user could reproduce by hand.
 *
 * Canonical per-field selection is deferred to verification; this stage only
 * groups records and computes the keys.
 */

import type { DedupConfig } from "./config.ts";
import type { Event } from "./models.ts";
import { FoodCategory, FoodConfirmed, VerificationState } from "./models.ts";
import type { NormalizedRecord } from "./normalize.ts";

/**
 * Stop words removed before title tokenization, so "Free Pizza Night" and
 * "Pizza Night (Free!)" share the same salient tokens.
 */
export const TITLE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "for",
  "free",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

/** Combined-similarity weights. Title dominates as the strongest signal. */
export const TITLE_WEIGHT = 0.45;
export const TIME_WEIGHT = 0.25;
export const LOCATION_WEIGHT = 0.2;
export const ORGANIZER_WEIGHT = 0.1;

/**
 * Rounding granularity in minutes applied to the start time inside the dedup
 * fingerprint, so trivially close times share a key while distinct times do not.
 */
export const FINGERPRINT_TIME_ROUNDING_MINUTES = 30;

function normalizeText(value: string | null): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Salient, stop-word-filtered token set for a title. */
export function titleTokens(value: string | null): Set<string> {
  const normalized = normalizeText(value);
  if (!normalized) return new Set();
  return new Set(
    normalized.split(" ").filter((token) => token && !TITLE_STOPWORDS.has(token)),
  );
}

function plainTokens(value: string | null): Set<string> {
  const normalized = normalizeText(value);
  if (!normalized) return new Set();
  return new Set(normalized.split(" ").filter(Boolean));
}

/** Jaccard index; two empty sets carry no signal rather than perfect overlap. */
function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / union.size;
}

export function titleSim(left: string | null, right: string | null): number {
  return jaccard(titleTokens(left), titleTokens(right));
}

export function locationSim(left: string | null, right: string | null): number {
  return jaccard(plainTokens(left), plainTokens(right));
}

export function organizerSim(left: string | null, right: string | null): number {
  return jaccard(plainTokens(left), plainTokens(right));
}

function minutesOf(value: string | null): number | null {
  if (!value) return null;
  const [h, m] = value.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/**
 * Start-time closeness, decaying linearly to zero at `windowMinutes` apart.
 * An unknown time yields no positive signal but is never penalized.
 */
export function timeProximity(
  left: string | null,
  right: string | null,
  windowMinutes: number,
): number {
  const a = minutesOf(left);
  const b = minutesOf(right);
  if (a === null || b === null) return 0;
  if (windowMinutes <= 0) return a === b ? 1 : 0;
  const delta = Math.abs(a - b);
  if (delta >= windowMinutes) return 0;
  return 1 - delta / windowMinutes;
}

export function combinedSimilarity(
  left: NormalizedRecord,
  right: NormalizedRecord,
  config: DedupConfig,
): number {
  return (
    TITLE_WEIGHT * titleSim(left.title, right.title) +
    TIME_WEIGHT *
      timeProximity(left.startTime, right.startTime, config.timeProximityMinutes) +
    LOCATION_WEIGHT * locationSim(left.location, right.location) +
    ORGANIZER_WEIGHT * organizerSim(left.organizer, right.organizer)
  );
}

function roundedTimeStamp(value: string | null, granularity: number): string {
  const minutes = minutesOf(value);
  if (minutes === null) return "none";
  let total = minutes;
  if (granularity > 0) total = Math.round(total / granularity) * granularity;
  total = ((total % 1440) + 1440) % 1440;
  const h = String(Math.floor(total / 60)).padStart(2, "0");
  const m = String(total % 60).padStart(2, "0");
  return `${h}${m}`;
}

/**
 * The deterministic within-run dedup key: date plus a fingerprint of sorted
 * title tokens, normalized venue, and rounded start time. It captures the
 * current shape of a cluster, which is what makes within-run clustering precise.
 */
export function computeDedupKey(
  eventDate: string | null,
  title: string | null,
  location: string | null,
  startTime: string | null,
): string {
  const day = eventDate ?? "no-date";
  const titleFp = [...titleTokens(title)].sort().join(" ");
  const venueFp = [...titleTokens(location)].sort().join(" ");
  const timeFp = roundedTimeStamp(startTime, FINGERPRINT_TIME_ROUNDING_MINUTES);
  return `${day}|${titleFp}|${venueFp}|${timeFp}`;
}

/**
 * The stable cross-run identity key: date plus sorted title tokens only.
 *
 * Venue and start time are deliberately excluded so a verified time or venue
 * change keeps the same identity and updates the existing event in place, with
 * the change recorded, instead of inserting a duplicate.
 */
export function computeIdentityKey(
  eventDate: string | null,
  title: string | null,
): string {
  const day = eventDate ?? "no-date";
  return `${day}|${[...titleTokens(title)].sort().join(" ")}`;
}

export type MergedEvent = {
  dedupKey: string;
  members: NormalizedRecord[];
  possibleDuplicate: boolean;
  /** Provisional canonical shell; verification finalizes the field values. */
  event: Event;
};

/** Invert a string's code points so a max-scan yields the smallest value. */
function negLexical(value: string): string {
  let out = "";
  for (const ch of value) out += String.fromCodePoint(0x10ffff - ch.codePointAt(0)!);
  return out;
}

/**
 * Pick a stable representative for the placeholder canonical fields.
 *
 * Content-based only: richest title first, ties broken by longest then
 * lexically smallest title, location, and start time. Source record ids are
 * deliberately not part of the tie-break, because they are regenerated per
 * ingest and would make the derived dedup key unstable across runs.
 */
function canonicalMember(members: NormalizedRecord[]): NormalizedRecord {
  let best = members[0];
  let bestKey = canonicalSortKey(best);
  for (const member of members.slice(1)) {
    const key = canonicalSortKey(member);
    if (compareKeys(key, bestKey) > 0) {
      best = member;
      bestKey = key;
    }
  }
  return best;
}

type SortKey = [number, number, string, string, string];

function canonicalSortKey(record: NormalizedRecord): SortKey {
  const title = record.title ?? "";
  const location = record.location ?? "";
  return [
    titleTokens(title).size,
    title.length,
    negLexical(title),
    negLexical(location),
    record.startTime ?? "",
  ];
}

function compareKeys(left: SortKey, right: SortKey): number {
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
    return String(a) < String(b) ? -1 : 1;
  }
  return 0;
}

function buildEventShell(dedupKey: string, members: NormalizedRecord[]): Event {
  const representative = canonicalMember(members);
  const eventDate =
    members.find((m) => m.eventDate !== null)?.eventDate ??
    representative.eventDate ??
    "1970-01-01";
  const sourceIdentities = [
    ...new Set(members.map((m) => m.sourceIdentity).filter((v): v is string => !!v)),
  ].sort();
  const identityKey =
    sourceIdentities.length === 1
      ? `source|${sourceIdentities[0]}`
      : computeIdentityKey(eventDate, representative.title);
  return {
    // The physical id is the target date plus the identity, which for a
    // provider-native identity is distinct per native event. The dedup key stays
    // a separate fingerprint: it describes the current shape of the cluster, and
    // two distinct native events can legitimately share one.
    id: `${eventDate}|${identityKey}`,
    dedupKey,
    identityKey,
    anchorlinkId: representative.anchorlinkId,
    title: representative.title ?? "",
    eventDate,
    startTime: representative.startTime,
    endTime: representative.endTime,
    startUtc: representative.startUtc,
    endUtc: representative.endUtc,
    endsNextDay: representative.endsNextDay,
    location: representative.location,
    locationGeo: null,
    organizer: representative.organizer,
    rsvpRequired: representative.rsvpRequired,
    rsvpUrl: representative.rsvpUrl,
    rsvpLinkOk: null,
    eventUrl: representative.eventUrl,
    foodConfirmed: representative.foodConfirmed,
    foodCategory: representative.foodCategory,
    foodDescription: representative.foodDescription,
    verificationState: VerificationState.FOOD_UNCONFIRMED,
    confidence: null,
    scoreTotal: null,
  };
}

/** Group records by event date so occurrences on different days never compare. */
function blockByDate(
  records: NormalizedRecord[],
): Map<string | null, NormalizedRecord[]> {
  const blocks = new Map<string | null, NormalizedRecord[]>();
  for (const record of records) {
    const key = record.eventDate;
    const bucket = blocks.get(key);
    if (bucket) bucket.push(record);
    else blocks.set(key, [record]);
  }
  return blocks;
}

function sortedBlockKeys(
  blocks: Map<string | null, NormalizedRecord[]>,
): (string | null)[] {
  const dated = [...blocks.keys()].filter((k): k is string => k !== null).sort();
  const result: (string | null)[] = [...dated];
  if (blocks.has(null)) result.push(null);
  return result;
}

function clusterBlock(
  records: NormalizedRecord[],
  config: DedupConfig,
): { members: NormalizedRecord[]; possibleDuplicate: boolean }[] {
  const clusters: NormalizedRecord[][] = [];
  const borderline: boolean[] = [];

  for (const record of records) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let index = 0; index < clusters.length; index += 1) {
      // Two rows from the same source carrying different native identities are
      // genuinely different events, however alike their text looks.
      const comparable = clusters[index].filter(
        (member) =>
          !(
            record.sourceIdentity &&
            member.sourceIdentity &&
            record.sourceId === member.sourceId &&
            record.sourceIdentity !== member.sourceIdentity
          ),
      );
      if (comparable.length === 0) continue;
      const score = Math.max(
        ...comparable.map((member) => combinedSimilarity(record, member, config)),
      );
      if (score >= config.reviewLow && score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      clusters[bestIndex].push(record);
      if (bestScore < config.mergeThreshold) borderline[bestIndex] = true;
    } else {
      clusters.push([record]);
      borderline.push(false);
    }
  }

  return clusters.map((members, index) => ({
    members,
    possibleDuplicate: borderline[index],
  }));
}

/**
 * Deduplicate normalized records into merged events.
 *
 * Output order is stable: blocks in ascending date order (undated last) and
 * clusters in first-seen order within a block.
 */
export function deduplicate(
  records: NormalizedRecord[],
  config: DedupConfig,
): MergedEvent[] {
  const blocks = blockByDate(records);
  const merged: MergedEvent[] = [];

  for (const blockDate of sortedBlockKeys(blocks)) {
    for (const cluster of clusterBlock(blocks.get(blockDate)!, config)) {
      const representative = canonicalMember(cluster.members);
      const dedupKey = computeDedupKey(
        blockDate,
        representative.title,
        representative.location,
        representative.startTime,
      );
      merged.push({
        dedupKey,
        members: cluster.members,
        possibleDuplicate: cluster.possibleDuplicate,
        event: buildEventShell(dedupKey, cluster.members),
      });
    }
  }

  return merged;
}

export { FoodCategory, FoodConfirmed };
