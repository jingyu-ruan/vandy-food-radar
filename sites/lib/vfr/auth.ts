/**
 * Authorization for the mutating refresh endpoints.
 *
 * This Site is owner-private: the hosting platform's dispatch layer gates every
 * inbound request, including requests from cloud service callers, before the
 * Worker sees them. When `VFR_OWNER_PRIVATE=true` the refresh endpoint may rely
 * on that boundary, because there is no anonymous path to it.
 *
 * That reliance is a deployment-shape assumption, so it is narrow:
 *
 * - It applies only to `POST /api/refresh`, never to a GET.
 * - A bearer token, when configured, is always honoured and compared in
 *   constant time.
 * - Without the owner-private flag and without a configured token the endpoint
 *   fails closed rather than defaulting to open.
 * - A browser-originated mutation must carry a same-origin `Origin` header. A
 *   service caller legitimately sends no `Origin`, which is allowed; a caller
 *   that sends a *foreign* `Origin` is rejected, which is what blocks
 *   cross-site request forgery from another page in the owner's browser.
 * - The legacy `/cron/refresh` compatibility route always demands the token,
 *   regardless of the private boundary.
 *
 * If this Site is ever shared publicly, the owner-private assumption no longer
 * holds and `VFR_OWNER_PRIVATE` must be set to `false` with `VFR_REFRESH_TOKEN`
 * configured, so that mutations require the bearer token.
 *
 * No credential value appears in this file or anywhere else in the source.
 */

import type { Config } from "./config.ts";

const BEARER_PREFIX = "Bearer ";

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Both sides are hashed first so the comparison runs over fixed-length digests
 * and the loop length does not depend on the secret.
 */
export async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * The bearer token this application was given, from the standard header only.
 *
 * `OAI-Sites-Authorization` is deliberately not consulted. It is the hosting
 * platform's own service-access credential, checked and consumed by dispatch,
 * and comparing it against this app's refresh token would conflate two
 * unrelated secrets. A service caller that presents only that header still
 * reaches the refresh endpoint through the owner-private boundary below, because
 * dispatch has already authorized it by the time the Worker runs.
 */
function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token || null;
}

/**
 * Whether a mutating browser request came from this same Site.
 *
 * An absent `Origin` is accepted because non-browser service callers do not
 * send one. A present `Origin` must match the request's own origin. Forwarded
 * host headers are honoured so the check stays correct behind the platform's
 * edge, where the Worker's view of the URL host can differ from the browser's.
 */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  let originHost: string;
  let originProtocol: string;
  try {
    const parsed = new URL(origin);
    originHost = parsed.host;
    originProtocol = parsed.protocol;
  } catch {
    return false;
  }
  const requestUrl = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const allowedHosts = new Set<string>([requestUrl.host]);
  if (forwardedHost) {
    for (const host of forwardedHost.split(",")) {
      const trimmed = host.trim();
      if (trimmed) allowedHosts.add(trimmed);
    }
  }
  const hostHeader = request.headers.get("host");
  if (hostHeader) allowedHosts.add(hostHeader);
  if (!allowedHosts.has(originHost)) return false;
  // A plain-HTTP origin against an HTTPS deployment is not the same site.
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const expectedProtocol = forwardedProto
    ? `${forwardedProto.split(",")[0].trim()}:`
    : requestUrl.protocol;
  if (expectedProtocol === "https:" && originProtocol !== "https:") return false;
  return true;
}

export type AuthDecision =
  | { allowed: true; via: "token" | "owner_private" }
  | { allowed: false; status: 401 | 403 | 503; reason: string };

/** Authorize `POST /api/refresh`. */
export async function authorizeRefresh(
  request: Request,
  config: Config,
): Promise<AuthDecision> {
  const supplied = bearerToken(request);

  if (supplied !== null) {
    if (!config.refreshToken) {
      return {
        allowed: false,
        status: 403,
        reason: "a bearer token was supplied but no refresh token is configured",
      };
    }
    const matches = await constantTimeEquals(supplied, config.refreshToken);
    return matches
      ? { allowed: true, via: "token" }
      : { allowed: false, status: 401, reason: "invalid refresh token" };
  }

  if (config.ownerPrivate) {
    if (!originAllowed(request)) {
      return {
        allowed: false,
        status: 403,
        reason: "cross-origin refresh requests are not accepted",
      };
    }
    return { allowed: true, via: "owner_private" };
  }

  if (!config.refreshToken) {
    return {
      allowed: false,
      status: 503,
      reason:
        "refresh is not configured: set VFR_OWNER_PRIVATE=true for a private Site, " +
        "or configure VFR_REFRESH_TOKEN",
    };
  }
  return { allowed: false, status: 401, reason: "missing bearer token" };
}

/**
 * Authorize the legacy `/cron/refresh` route.
 *
 * This path exists only for schedulers configured against the previous
 * deployment. It always requires the bearer token and never falls back to the
 * private-deployment boundary.
 */
export async function authorizeLegacyCron(
  request: Request,
  config: Config,
): Promise<AuthDecision> {
  if (!config.refreshToken) {
    return {
      allowed: false,
      status: 503,
      reason: "VFR_REFRESH_TOKEN is not configured",
    };
  }
  const supplied = bearerToken(request);
  if (supplied === null) {
    return { allowed: false, status: 401, reason: "missing bearer token" };
  }
  const matches = await constantTimeEquals(supplied, config.refreshToken);
  return matches
    ? { allowed: true, via: "token" }
    : { allowed: false, status: 401, reason: "invalid refresh token" };
}
