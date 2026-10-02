/**
 * Campus place dataset and conservative location resolution.
 *
 * Ported from the Python reference (`vandy_food_radar/places.py`). Event
 * listings name places the way a person would ("Sarratt Student Center, Room
 * 216"). To draw a marker or estimate a walk the server needs coordinates, and
 * the curated dataset in `public/static/campus-places.json` is the only source
 * of them. That file is read here and never written.
 *
 * Matching is deliberately conservative. A listing resolves only when one of
 * its segments matches a place's name or curated alias exactly after
 * normalization, or starts with such a key followed by a token boundary.
 * Partial-word overlap, edit distance, and "closest building" guesses are all
 * rejected: an unresolved location is a correct answer, a plausible wrong
 * building is not.
 *
 * Room and suite detail is never discarded: `detail` keeps the remainder of the
 * listing so the card still shows "Room 216" while the coordinates come from
 * the building. Entries with non-finite or out-of-range coordinates are
 * skipped rather than trusted.
 */

import type { GeoPoint } from "./models.ts";

/** Separators that commonly divide "Building, Room 123" style strings. */
const SEGMENT_SPLIT = /\s*(?:,|\u2014|\u2013| - | \| |;)\s*/;
const NON_ALNUM = /[^a-z0-9]+/g;
/** Kept tiny on purpose: aggressive stripping causes false matches. */
const NOISE_TOKENS = new Set(["the"]);
const STEVENSON_ROOM = /^(?:stevenson(?:\s+center)?|sc)\s*(?:room\s*)?([124567]\d{3})\b/i;

export type CampusPlace = {
  id: string;
  name: string;
  aliases: string[];
  point: GeoPoint;
  sourceUrl: string | null;
};

export type ResolvedPlace = {
  place: CampusPlace;
  /** Whatever the listing said beyond the building name, verbatim. */
  detail: string | null;
  /** The exact listing segment that matched. */
  matchedText: string;
};

/** Lowercase alphanumeric-token key used for every comparison. */
export function normalizePlaceKey(value: string): string {
  return value
    .toLowerCase()
    .replace(NON_ALNUM, " ")
    .split(" ")
    .filter((token) => token && !NOISE_TOKENS.has(token))
    .join(" ");
}

function validCoordinate(lat: unknown, lng: unknown): GeoPoint | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function matchKeys(place: CampusPlace): string[] {
  const keys: string[] = [];
  for (const candidate of [place.name, ...place.aliases]) {
    const key = normalizePlaceKey(candidate);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** Display form used for calendar locations: building plus preserved detail. */
export function placeDisplayName(resolved: ResolvedPlace): string {
  return resolved.detail ? `${resolved.place.name}, ${resolved.detail}` : resolved.place.name;
}

/** Text after the matched key within one segment, original casing kept. */
function originalTrailing(segment: string, key: string): string | null {
  const wanted = key.split(" ").length;
  let consumed = 0;
  let boundary = 0;
  for (const match of segment.matchAll(/[a-z0-9]+/gi)) {
    if (NOISE_TOKENS.has(match[0].toLowerCase())) continue;
    consumed += 1;
    boundary = (match.index ?? 0) + match[0].length;
    if (consumed === wanted) break;
  }
  const trailing = trimChars(segment.slice(boundary), " ,-");
  return trailing || null;
}

function trimChars(value: string, chars: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value[start])) start += 1;
  while (end > start && chars.includes(value[end - 1])) end -= 1;
  return value.slice(start, end);
}

function joinDetail(segments: string[], skip: number, trailing: string | null): string | null {
  const parts: string[] = [];
  if (trailing) parts.push(trailing);
  segments.forEach((segment, index) => {
    if (index === skip) return;
    const cleaned = segment.trim();
    if (cleaned) parts.push(cleaned);
  });
  return parts.join(", ") || null;
}

/** An immutable, pre-indexed set of campus places. */
export class PlaceDataset {
  readonly places: readonly CampusPlace[];
  private readonly index: { key: string; place: CampusPlace }[];
  private readonly keysByPlace: Map<CampusPlace, string[]>;

  constructor(places: CampusPlace[]) {
    this.places = Object.freeze([...places]);
    this.keysByPlace = new Map(places.map((place) => [place, matchKeys(place)]));
    // Longest key first, so the most specific name wins a prefix test.
    this.index = places
      .flatMap((place) => this.keysByPlace.get(place)!.map((key) => ({ key, place })))
      .sort((a, b) => b.key.length - a.key.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  get available(): boolean {
    return this.places.length > 0;
  }

  /** Resolve a listed location conservatively, or return `null`. */
  resolve(location: string | null | undefined): ResolvedPlace | null {
    if (!location || !location.trim() || this.places.length === 0) return null;
    const listed = location.trim();

    const room = STEVENSON_ROOM.exec(listed);
    if (room) {
      const buildingKey = `stevenson center building ${room[1][0]}`;
      const place = this.places.find((item) =>
        this.keysByPlace.get(item)!.includes(buildingKey),
      );
      if (place) {
        const remainder = trimChars(listed.slice(room[0].length).trim(), " ,-;");
        let detail = `Room ${room[1]}`;
        if (remainder) detail += `, ${remainder}`;
        return { place, detail, matchedText: room[0] };
      }
    }

    const segments = listed.split(SEGMENT_SPLIT).filter((segment) => segment.trim());
    if (segments.length === 0) return null;

    // The full name is tried first; canonical names can contain an inner dash.
    const candidates: [number | null, string][] = [
      [null, listed],
      ...segments.map((segment, index) => [index, segment] as [number, string]),
    ];
    for (const [position, segment] of candidates) {
      const normalized = normalizePlaceKey(segment);
      if (!normalized) continue;
      for (const { key, place } of this.index) {
        if (normalized === key) {
          const detail = position !== null ? joinDetail(segments, position, null) : null;
          return { place, detail, matchedText: segment.trim() };
        }
        if (normalized.startsWith(`${key} `)) {
          const listedNext = normalized.slice(key.length + 1).split(" ")[0];
          // "Stevenson Center Lecture" must not resolve to "Stevenson Center"
          // when a longer key of the same place starts that way but differs.
          const shadowed = this.keysByPlace.get(place)!.some(
            (longer) =>
              longer.startsWith(`${key} `) &&
              listedNext.startsWith(longer.slice(key.length + 1).split(" ")[0]) &&
              !normalized.startsWith(`${longer} `),
          );
          if (shadowed) continue;
          const trailing =
            originalTrailing(segment, key) ??
            (trimChars(segment.trim().slice(key.length).trim(), " ,-") || null);
          const detail =
            position !== null ? joinDetail(segments, position, trailing) : trailing;
          return { place, detail, matchedText: segment.trim() };
        }
      }
    }
    return null;
  }
}

export const EMPTY_DATASET = new PlaceDataset([]);

/**
 * Build a dataset from decoded JSON, skipping unusable entries.
 *
 * The expected shape is an array of `{id,name,aliases,lat,lng,source_url}`. A
 * non-array payload, a non-object entry, a missing name, or a non-numeric or
 * out-of-range coordinate is skipped, so one bad row cannot take the feature
 * down or introduce a fabricated coordinate.
 */
export function parsePlaces(payload: unknown): PlaceDataset {
  if (!Array.isArray(payload)) return EMPTY_DATASET;
  const places: CampusPlace[] = [];
  const seen = new Set<string>();
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const name = row.name;
    if (typeof name !== "string" || !name.trim()) continue;
    const point = validCoordinate(row.lat, row.lng);
    if (!point) continue;
    const id = typeof row.id === "string" && row.id.trim() ? row.id.trim() : name;
    if (seen.has(id)) continue;
    seen.add(id);
    const aliases = Array.isArray(row.aliases)
      ? row.aliases
          .filter((alias): alias is string => typeof alias === "string" && Boolean(alias.trim()))
          .map((alias) => alias.trim())
      : [];
    const sourceUrl =
      typeof row.source_url === "string" && row.source_url.trim() ? row.source_url.trim() : null;
    places.push({ id, name: name.trim(), aliases, point, sourceUrl });
  }
  return new PlaceDataset(places);
}
