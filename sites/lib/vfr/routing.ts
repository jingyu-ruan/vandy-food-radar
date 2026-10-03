/**
 * Walking routes with an optional OpenRouteService backend.
 *
 * Ported from the Python reference (`vandy_food_radar/routing.py`). Two answers
 * are acceptable and the caller is always told which one it got:
 *
 * - `routed`: real pedestrian distance and duration from OpenRouteService;
 * - `estimate`: great-circle distance at a fixed walking pace, explicitly
 *   labelled, with a `detail` saying why no route was used.
 *
 * Constraints enforced here:
 *
 * - `VFR_ORS_API_KEY` lives only in the Worker environment. It is sent as an
 *   `Authorization` header to one hard-coded endpoint and is never placed in a
 *   URL, a response, HTML, or a log line.
 * - There is no caller-supplied URL, so this is not a general proxy.
 * - Coordinates must be finite, in range, within a configured radius of the
 *   reference point, and bounded in count. Invalid input is rejected (400), not
 *   clamped.
 * - Results are memoized in a bounded per-isolate cache keyed on rounded
 *   coordinates, and the upstream call has a timeout.
 */

import type { Config } from "./config.ts";
import type { GeoPoint } from "./models.ts";

/** The single permitted upstream endpoint. Not configurable by design. */
export const ORS_DIRECTIONS_URL =
  "https://api.openrouteservice.org/v2/directions/foot-walking/geojson";

export const WALKING_METRES_PER_MINUTE = 80;
const EARTH_RADIUS_M = 6_371_000;
const CACHE_PRECISION = 5;
const MAX_GEOMETRY_POINTS = 20000;

export type RouteMode = "routed" | "estimate";

export type RouteLeg = { distanceM: number; minutes: number; mode: RouteMode };

export type RouteResult = {
  mode: RouteMode;
  distanceM: number;
  minutes: number;
  legs: RouteLeg[];
  detail: string;
  geometry: GeoPoint[];
};

/** Raised for an invalid walking request. The message is safe to return. */
export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

/** HTTP seam for the one fixed directions call, injected in tests. */
export type RouteHttp = {
  getFoot?(points: GeoPoint[], timeoutMs: number): Promise<RouteResult | null>;
  postJson(
    body: Record<string, unknown>,
    options: { apiKey: string; timeoutMs: number },
  ): Promise<Record<string, unknown> | null>;
};

/**
 * Default transport. Every transport, HTTP, timeout, and decode failure yields
 * `null` so the caller falls back to the labelled estimate; no error text that
 * could carry the key is ever propagated.
 */
let footRequestQueue: Promise<unknown> = Promise.resolve();
let lastFootRequest = 0;

/** The fixed public pedestrian endpoint, serialized to respect its 1 request/s policy. */
export const fetchRouteHttp: RouteHttp = {
  getFoot(points, timeoutMs) {
    const request = footRequestQueue.then(async () => {
      const wait = Math.max(0, 1050 - (Date.now() - lastFootRequest));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      lastFootRequest = Date.now();
      try {
        const coordinates = points.map(p => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(";");
        const response = await fetch(`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coordinates}?overview=full&geometries=geojson&steps=false`, {
          headers:{"User-Agent":"FreeBites/1.0 (https://vandy-food-radar.rjy020128.chatgpt.site)",Accept:"application/json"},
          redirect:"manual", signal:AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return null;
        return parseFootRoute(await response.json(), points.length-1);
      } catch {return null;}
    });
    footRequestQueue = request.catch(() => null);
    return request;
  },
  async postJson(body, { apiKey, timeoutMs }) {
    try {
      const response = await fetch(ORS_DIRECTIONS_URL, {
        method: "POST",
        headers: {
          Authorization: apiKey,
          "Content-Type": "application/json",
          Accept: "application/geo+json",
        },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      return typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  },
};

export function haversineMetres(origin: GeoPoint, dest: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const lat1 = toRad(origin.lat);
  const lat2 = toRad(dest.lat);
  const dLat = toRad(dest.lat - origin.lat);
  const dLng = toRad(dest.lng - origin.lng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function minutesForMetres(distanceM: number): number {
  return Math.max(1, Math.ceil(distanceM / WALKING_METRES_PER_MINUTE));
}

/** Strict coordinate parse: numbers or numeric strings, finite only. */
export function parseCoordinate(value: unknown, field: string): number {
  let number: number;
  if (typeof value === "number") {
    number = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    number = Number(value.trim());
    if (Number.isNaN(number)) throw new RouteError(`${field} must be a number`);
  } else {
    throw new RouteError(`${field} must be a number`);
  }
  if (!Number.isFinite(number)) throw new RouteError(`${field} must be a finite number`);
  return number;
}

export function parsePoint(value: unknown, index: number): GeoPoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RouteError(`waypoint ${index} must be an object with lat and lng`);
  }
  const row = value as Record<string, unknown>;
  const lat = parseCoordinate(row.lat, `waypoint ${index} lat`);
  const lng = parseCoordinate(row.lng, `waypoint ${index} lng`);
  if (lat < -90 || lat > 90) throw new RouteError(`waypoint ${index} lat is out of range`);
  if (lng < -180 || lng > 180) throw new RouteError(`waypoint ${index} lng is out of range`);
  return { lat, lng };
}

/** Validate a request payload into a bounded list of campus waypoints. */
export function parseWaypoints(payload: unknown, config: Config): GeoPoint[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new RouteError("request body must be a JSON object");
  }
  const raw = (payload as Record<string, unknown>).waypoints;
  if (!Array.isArray(raw)) throw new RouteError("waypoints must be a list");
  if (raw.length < 2) throw new RouteError("at least two waypoints are required");
  const { maxWaypoints, maxRadiusKm } = config.routing;
  if (raw.length > maxWaypoints) {
    throw new RouteError(`at most ${maxWaypoints} waypoints are supported`);
  }
  const reference = { lat: config.referenceLocation.lat, lng: config.referenceLocation.lng };
  return raw.map((item, index) => {
    const point = parsePoint(item, index);
    if (haversineMetres(reference, point) > maxRadiusKm * 1000) {
      throw new RouteError(
        `waypoint ${index} is outside the supported ${maxRadiusKm} km service area`,
      );
    }
    return point;
  });
}

/** Straight-line estimate: a lower bound on the real walk, labelled as such. */
export function estimateRoute(points: GeoPoint[], detail?: string): RouteResult {
  const legs: RouteLeg[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const distanceM = haversineMetres(points[index - 1], points[index]);
    legs.push({ distanceM, minutes: minutesForMetres(distanceM), mode: "estimate" });
  }
  return {
    mode: "estimate",
    distanceM: legs.reduce((sum, leg) => sum + leg.distanceM, 0),
    minutes: legs.reduce((sum, leg) => sum + leg.minutes, 0),
    legs,
    detail:
      detail ??
      "Straight-line estimate at a steady walking pace; the real route will be at least this long.",
    geometry: [],
  };
}

function finiteNonNegative(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Extract totals, legs, and geometry from an ORS GeoJSON response. */
export function parseOrsGeojson(payload: Record<string, unknown>): RouteResult | null {
  const features = payload.features;
  if (!Array.isArray(features) || features.length === 0) return null;
  const first = features[0] as Record<string, unknown> | null;
  if (typeof first !== "object" || first === null) return null;
  const properties = first.properties as Record<string, unknown> | undefined;
  if (typeof properties !== "object" || properties === null) return null;
  const summary = properties.summary as Record<string, unknown> | undefined;
  if (typeof summary !== "object" || summary === null) return null;
  const totalDistance = finiteNonNegative(summary.distance);
  const totalDuration = finiteNonNegative(summary.duration);
  if (totalDistance === null || totalDuration === null) return null;

  const legs: RouteLeg[] = [];
  if (Array.isArray(properties.segments)) {
    for (const segment of properties.segments) {
      if (typeof segment !== "object" || segment === null) return null;
      const row = segment as Record<string, unknown>;
      const distance = finiteNonNegative(row.distance);
      const duration = finiteNonNegative(row.duration);
      if (distance === null || duration === null) return null;
      legs.push({
        distanceM: distance,
        minutes: Math.max(1, Math.ceil(duration / 60)),
        mode: "routed",
      });
    }
  }

  let geometry: GeoPoint[] = [];
  const shape = first.geometry as Record<string, unknown> | undefined;
  if (shape && typeof shape === "object" && shape.type === "LineString") {
    const coordinates = shape.coordinates;
    if (Array.isArray(coordinates) && coordinates.length <= MAX_GEOMETRY_POINTS) {
      for (const pair of coordinates) {
        if (!Array.isArray(pair) || pair.length < 2) {
          geometry = [];
          break;
        }
        try {
          geometry.push(parsePoint({ lng: pair[0], lat: pair[1] }, 0));
        } catch {
          geometry = [];
          break;
        }
      }
    }
  }

  return {
    mode: "routed",
    distanceM: totalDistance,
    minutes: Math.max(1, Math.ceil(totalDuration / 60)),
    legs,
    detail: "Pedestrian route from OpenRouteService.",
    geometry,
  };
}

/** JSON projection for the HTTP API: no secrets, no upstream URL. */
export function routeResultToJson(result: RouteResult): Record<string, unknown> {
  const round1 = (value: number) => Math.round(value * 10) / 10;
  return {
    mode: result.mode,
    distance_m: round1(result.distanceM),
    minutes: result.minutes,
    detail: result.detail,
    geometry: result.geometry.map((point) => [point.lat, point.lng]),
    legs: result.legs.map((leg) => ({
      distance_m: round1(leg.distanceM),
      minutes: leg.minutes,
      mode: leg.mode,
    })),
  };
}

/** Resolves walking routes, caching results and degrading to estimates. */
export class WalkingRouter {
  private readonly config: Config;
  private readonly http: RouteHttp;
  private readonly cache = new Map<string, RouteResult>();

  constructor(config: Config, http: RouteHttp = fetchRouteHttp) {
    this.config = config;
    this.http = http;
  }

  /** Whether a routing key is configured; never exposes the key itself. */
  get routingAvailable(): boolean {
    return Boolean(this.config.routing.apiKey || this.http.getFoot);
  }

  async route(points: GeoPoint[]): Promise<RouteResult> {
    const key = points
      .map((point) => `${point.lat.toFixed(CACHE_PRECISION)},${point.lng.toFixed(CACHE_PRECISION)}`)
      .join(";");
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const result = await this.resolve(points);
    this.cache.set(key, result);
    while (this.cache.size > Math.max(1, this.config.routing.cacheEntries)) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return result;
  }

  private async resolve(points: GeoPoint[]): Promise<RouteResult> {
    const { apiKey, timeoutMs } = this.config.routing;
    if (!apiKey) {
      const routed = await this.http.getFoot?.(points, timeoutMs);
      return routed ?? estimateRoute(points, "Walking route unavailable; straight-line estimate, actual walk unverified.");
    }
    const payload = await this.http.postJson(
      {
        // ORS takes [lng, lat] pairs.
        coordinates: points.map((point) => [point.lng, point.lat]),
        instructions: false,
        units: "m",
      },
      { apiKey, timeoutMs },
    );
    if (payload === null) {
      return estimateRoute(
        points,
        "The routing service did not answer, so this is a straight-line estimate.",
      );
    }
    return (
      parseOrsGeojson(payload) ??
      estimateRoute(
        points,
        "The routing service returned an unusable response, so this is a straight-line estimate.",
      )
    );
  }
}

/** Validate OSRM foot totals/legs/coordinates through the common GeoJSON boundary. */
export function parseFootRoute(payload: unknown, expectedLegs: number): RouteResult | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as {code?:string; routes?: {distance:unknown; duration:unknown; legs?:{distance:unknown; duration:unknown}[]; geometry?:unknown}[]};
  const route = data.routes?.[0];
  if (data.code !== "Ok" || !route || route.legs?.length !== expectedLegs) return null;
  const result = parseOrsGeojson({features:[{properties:{summary:{distance:route.distance,duration:route.duration},segments:route.legs},geometry:route.geometry}]});
  if (!result || result.geometry.length < 2) return null;
  return {...result, detail:"Pedestrian route from FOSSGIS using OpenStreetMap data."};
}
