/**
 * Walking-distance providers.
 *
 * The ranker consults this seam for the walking-convenience factor. An unknown
 * walk is reported honestly as unknown and substitutes the configured neutral
 * ranking value, so it never zeroes a score and no minute figure is ever
 * fabricated.
 *
 * The live AnchorLink discovery rows carry no coordinates, so in production
 * every event's destination is absent and walking is genuinely unavailable.
 * The Google Distance Matrix provider is retained for the case where a future
 * source does supply coordinates; it is only constructed when a key is present
 * and explicitly enabled.
 */

import type { Config } from "./config.ts";
import type { GeoPoint } from "./models.ts";

/** Average campus walking speed, for turning metres into coarse minutes. */
const WALKING_METRES_PER_MINUTE = 80;
const EARTH_RADIUS_M = 6_371_000;

/** Distances at or below NEAR score 1.0; at or above FAR score 0.0. */
const NEAR_METRES = 100;
const FAR_METRES = 1600;

const MAPS_DISTANCE_MATRIX_URL =
  "https://maps.googleapis.com/maps/api/distancematrix/json";
const MAPS_HTTP_TIMEOUT_MS = 5000;
const MAPS_CACHE_PRECISION = 5;

export const WalkingStatus = { OK: "ok", UNKNOWN: "unknown" } as const;
export type WalkingStatus = (typeof WalkingStatus)[keyof typeof WalkingStatus];

export type WalkingResult = {
  status: WalkingStatus;
  distanceM: number | null;
  minutes: number | null;
};

const UNKNOWN_WALK: WalkingResult = {
  status: WalkingStatus.UNKNOWN,
  distanceM: null,
  minutes: null,
};

export type LocationProvider = {
  walking(origin: GeoPoint, dest: GeoPoint | null): Promise<WalkingResult>;
};

function haversineMetres(origin: GeoPoint, dest: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const lat1 = toRad(origin.lat);
  const lat2 = toRad(dest.lat);
  const dLat = toRad(dest.lat - origin.lat);
  const dLng = toRad(dest.lng - origin.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Great-circle estimate from the configured reference point. Offline. */
export class HaversineLocationProvider implements LocationProvider {
  async walking(origin: GeoPoint, dest: GeoPoint | null): Promise<WalkingResult> {
    if (dest === null) return UNKNOWN_WALK;
    const distanceM = haversineMetres(origin, dest);
    return {
      status: WalkingStatus.OK,
      distanceM: Math.round(distanceM * 10) / 10,
      minutes: Math.max(1, Math.ceil(distanceM / WALKING_METRES_PER_MINUTE)),
    };
  }
}

/** Provider that never knows a walking distance. */
export class NullLocationProvider implements LocationProvider {
  async walking(): Promise<WalkingResult> {
    return UNKNOWN_WALK;
  }
}

export type MapsHttp = { getJson(url: string): Promise<Record<string, unknown> | null> };

const fetchMapsHttp: MapsHttp = {
  async getJson(url) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(MAPS_HTTP_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const parsed: unknown = await response.json();
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  },
};

function parseDistanceMatrix(
  payload: Record<string, unknown> | null,
): { distanceM: number; durationSeconds: number } | null {
  if (!payload || payload["status"] !== "OK") return null;
  const rows = payload["rows"];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const firstRow = rows[0] as Record<string, unknown> | undefined;
  const elements = firstRow?.["elements"];
  if (!Array.isArray(elements) || elements.length === 0) return null;
  const element = elements[0] as Record<string, unknown>;
  if (element["status"] !== "OK") return null;
  const distance = element["distance"] as Record<string, unknown> | undefined;
  const duration = element["duration"] as Record<string, unknown> | undefined;
  const distanceM = Number(distance?.["value"]);
  const durationSeconds = Number(duration?.["value"]);
  if (!Number.isFinite(distanceM) || !Number.isFinite(durationSeconds)) return null;
  return { distanceM, durationSeconds };
}

/**
 * Live walking estimator backed by the Google Distance Matrix API, memoized per
 * rounded coordinate pair. Any failure falls back to the injected fallback
 * provider and ultimately to unknown; it never raises and never guesses.
 */
export class GoogleMapsLocationProvider implements LocationProvider {
  private readonly cache = new Map<string, WalkingResult>();
  private readonly apiKey: string;
  private readonly http: MapsHttp;
  private readonly fallback: LocationProvider;

  constructor(
    apiKey: string,
    http: MapsHttp = fetchMapsHttp,
    fallback: LocationProvider = new HaversineLocationProvider(),
  ) {
    this.apiKey = apiKey;
    this.http = http;
    this.fallback = fallback;
  }

  async walking(origin: GeoPoint, dest: GeoPoint | null): Promise<WalkingResult> {
    if (dest === null) return UNKNOWN_WALK;
    const key = [origin.lat, origin.lng, dest.lat, dest.lng]
      .map((value) => value.toFixed(MAPS_CACHE_PRECISION))
      .join(",");
    const cached = this.cache.get(key);
    if (cached) return cached;
    const result = await this.resolve(origin, dest);
    this.cache.set(key, result);
    return result;
  }

  private async resolve(origin: GeoPoint, dest: GeoPoint): Promise<WalkingResult> {
    if (!this.apiKey) return this.fallback.walking(origin, dest);
    const params = new URLSearchParams({
      origins: `${origin.lat},${origin.lng}`,
      destinations: `${dest.lat},${dest.lng}`,
      mode: "walking",
      key: this.apiKey,
    });
    const payload = await this.http.getJson(
      `${MAPS_DISTANCE_MATRIX_URL}?${params.toString()}`,
    );
    const parsed = parseDistanceMatrix(payload);
    if (!parsed) return this.fallback.walking(origin, dest);
    return {
      status: WalkingStatus.OK,
      distanceM: Math.round(parsed.distanceM * 10) / 10,
      minutes: Math.max(1, Math.ceil(parsed.durationSeconds / 60)),
    };
  }
}

/**
 * Map a walking result to the ranking factor value in [0, 1]. An unknown walk
 * uses the configured neutral value rather than a fabricated zero.
 */
export function walkingFactorValue(
  result: WalkingResult,
  unknownValue: number,
): number {
  if (result.status !== WalkingStatus.OK || result.distanceM === null) {
    return unknownValue;
  }
  const distance = result.distanceM;
  if (distance <= NEAR_METRES) return 1;
  if (distance >= FAR_METRES) return 0;
  const span = FAR_METRES - NEAR_METRES;
  return Math.round((1 - (distance - NEAR_METRES) / span) * 10000) / 10000;
}

/** Human-readable walking label. Unknown stays explicitly unavailable. */
export function walkingLabel(result: WalkingResult): string {
  if (result.status === WalkingStatus.OK && result.minutes !== null) {
    return `${result.minutes} min walk`;
  }
  return "Walking time unavailable";
}

export function buildLocationProvider(config: Config): LocationProvider {
  if (config.locationProvider === "null") return new NullLocationProvider();
  if (
    config.locationProvider === "google_maps" &&
    config.mapsEnabled &&
    config.mapsApiKey
  ) {
    return new GoogleMapsLocationProvider(config.mapsApiKey);
  }
  return new HaversineLocationProvider();
}
