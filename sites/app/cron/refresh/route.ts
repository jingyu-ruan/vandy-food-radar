/**
 * `GET|POST /cron/refresh?days=1|2|7` — legacy scheduler compatibility.
 *
 * The previous deployment exposed this path, so an external scheduler already
 * configured against it keeps working. It accepts both verbs because schedulers
 * differ, and it always requires the bearer token: unlike `/api/refresh` it never
 * relies on the owner-private deployment boundary.
 */

import { parseRefreshDays } from "@/lib/vfr/config.ts";
import { authorizeLegacyCron } from "@/lib/vfr/auth.ts";
import { runRefresh } from "@/lib/vfr/pipeline.ts";
import { getConfig, getRepository, jsonResponse } from "@/lib/vfr/runtime.ts";

export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  const config = getConfig();

  const decision = await authorizeLegacyCron(request, config);
  if (!decision.allowed) {
    return jsonResponse(
      { ok: false, error: decision.reason },
      {
        status: decision.status,
        ...(decision.status === 401
          ? { headers: { "www-authenticate": 'Bearer realm="refresh"' } }
          : {}),
      },
    );
  }

  let repository;
  try {
    repository = getRepository(config);
  } catch (error) {
    console.error("cron refresh: durable storage unavailable", error);
    return jsonResponse(
      { ok: false, error: "the listing could not be updated right now" },
      { status: 503 },
    );
  }

  const days = parseRefreshDays(new URL(request.url).searchParams.get("days"));
  const result = await runRefresh({ repository, config, trigger: "cron", days });

  if (result.ok) return jsonResponse({ ok: true, ...result.summary });

  if (result.kind === "locked") {
    return jsonResponse(
      { ok: false, error: result.message },
      { status: 409, headers: { "retry-after": String(result.retryAfterSeconds) } },
    );
  }

  console.error(`cron refresh: ${result.kind} failure: ${result.message}`);
  const status = result.kind === "source" ? 502 : 503;
  return jsonResponse(
    { ok: false, error: "refresh failed; the previous listing was kept" },
    { status },
  );
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
