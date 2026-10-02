/**
 * `POST /api/walking` — a walking answer across validated waypoints.
 *
 * The answer is either `routed` (OpenRouteService, only when `VFR_ORS_API_KEY`
 * is configured server-side) or a labelled straight-line `estimate` whose
 * `detail` says why. The key never leaves the server, there is no
 * caller-supplied URL, and invalid input is rejected with 400 rather than
 * clamped. A foreign `Origin` is refused so another site cannot spend the
 * routing quota through a visitor's browser.
 */

import { originAllowed } from "@/lib/vfr/auth.ts";
import { RouteError, parseWaypoints, routeResultToJson } from "@/lib/vfr/routing.ts";
import { getConfig, getRouter, jsonResponse } from "@/lib/vfr/runtime.ts";

export const dynamic = "force-dynamic";

/** Far above any legitimate request of at most a dozen waypoints. */
const MAX_BODY_BYTES = 8192;

export async function POST(request: Request): Promise<Response> {
  if (!originAllowed(request)) {
    return jsonResponse({ error: "cross-origin requests are not accepted" }, { status: 403 });
  }
  const config = getConfig();
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return jsonResponse({ error: "request body is too large" }, { status: 413 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return jsonResponse({ error: "request body must be a JSON object" }, { status: 400 });
  }
  let points;
  try {
    points = parseWaypoints(payload, config);
  } catch (error) {
    if (error instanceof RouteError) return jsonResponse({ error: error.message }, { status: 400 });
    throw error;
  }
  const result = await getRouter(config).route(points);
  return jsonResponse(routeResultToJson(result));
}

export async function GET(): Promise<Response> {
  return jsonResponse(
    { error: "use POST with a JSON body of waypoints" },
    { status: 405, headers: { allow: "POST" } },
  );
}
