/**
 * `POST /api/refresh?days=1|2|7` — run one complete refresh.
 *
 * Mutating and authorized. A refresh covers `days` consecutive local days
 * starting today (any other value means one day). It ingests every source page
 * of every requested day and computes them all before publishing them in one
 * transaction, so a failure leaves the previously published feed intact and
 * visible, and days outside the request are never erased.
 *
 * `GET` is deliberately rejected: loading a page must never have a side effect.
 *
 * Failure responses are plain product messages. Exception text and schema
 * diagnostics go to the server log, because the caller is a visitor's browser
 * and cannot act on a deployment fault.
 */

import { parseRefreshDays } from "@/lib/vfr/config.ts";
import { authorizeRefresh } from "@/lib/vfr/auth.ts";
import { runRefresh } from "@/lib/vfr/pipeline.ts";
import { getConfig, getRepository, jsonResponse } from "@/lib/vfr/runtime.ts";

export const dynamic = "force-dynamic";

const TEMPORARILY_UNAVAILABLE =
  "the listing could not be updated right now; the previous listing was kept";

export async function POST(request: Request): Promise<Response> {
  const config = getConfig();

  const decision = await authorizeRefresh(request, config);
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
    console.error("refresh: durable storage unavailable", error);
    return jsonResponse(
      { ok: false, error: TEMPORARILY_UNAVAILABLE },
      { status: 503 },
    );
  }

  const days = parseRefreshDays(new URL(request.url).searchParams.get("days"));
  const result = await runRefresh({ repository, config, trigger: "api", days });

  if (result.ok) {
    return jsonResponse({ ok: true, ...result.summary });
  }

  if (result.kind === "locked") {
    return jsonResponse(
      { ok: false, error: result.message },
      {
        status: 409,
        headers: { "retry-after": String(result.retryAfterSeconds) },
      },
    );
  }

  if (result.kind === "source") {
    console.error(`refresh: source failure: ${result.message}`);
    return jsonResponse(
      {
        ok: false,
        error: "the event source could not be read; the previous listing was kept",
      },
      { status: 502 },
    );
  }

  // Storage diagnostics, including an unapplied migration, are an operator
  // concern. They are logged, never returned to the caller.
  console.error(
    `refresh: storage failure (schemaMissing=${result.schemaMissing}): ${result.message}`,
  );
  return jsonResponse({ ok: false, error: TEMPORARILY_UNAVAILABLE }, { status: 503 });
}

export async function GET(): Promise<Response> {
  return jsonResponse(
    { ok: false, error: "use POST to refresh; GET has no side effects" },
    { status: 405, headers: { allow: "POST" } },
  );
}
