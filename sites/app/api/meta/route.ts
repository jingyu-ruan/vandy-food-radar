/**
 * `GET /api/meta` — server capabilities and last-success metadata.
 *
 * Contains no secret: walking routing is reported only as an availability
 * boolean, never as a key or an upstream URL.
 */

import { getConfig, getRepository, getRouter, jsonResponse } from "@/lib/vfr/runtime.ts";
import { localDateOf } from "@/lib/vfr/time.ts";
import { clientConfig } from "@/lib/vfr/viewmodel.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const config = getConfig();
  const today = localDateOf(Date.now(), config.timezone);
  let lastSuccess;
  try {
    lastSuccess = await getRepository(config).lastSuccess();
  } catch (error) {
    console.error("meta: refresh metadata read failed", error);
    return jsonResponse({ error: "event data unavailable" }, { status: 503 });
  }
  return jsonResponse({
    ...clientConfig(config, today, today, getRouter(config).routingAvailable),
    last_success: {
      at: lastSuccess?.at ?? null,
      days: lastSuccess ? String(lastSuccess.days.length) : null,
      dates: lastSuccess?.days ?? [],
    },
  });
}
