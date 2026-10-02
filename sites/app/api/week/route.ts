/**
 * `GET /api/week?start=YYYY-MM-DD` — seven consecutive days for the schedule.
 *
 * Read-only. Each day is read through its own date-scoped query and bucketed
 * under its own date, so the agenda can never attribute a listing to the wrong
 * day. A missing or malformed start selects today.
 */

import { parseSelectedDate } from "@/lib/vfr/feed.ts";
import { getConfig, getRepository, jsonResponse } from "@/lib/vfr/runtime.ts";
import { localDateOf } from "@/lib/vfr/time.ts";
import { loadWeek } from "@/lib/vfr/workspace.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const config = getConfig();
  const nowMs = Date.now();
  const today = localDateOf(nowMs, config.timezone);
  const start = parseSelectedDate(new URL(request.url).searchParams.get("start"), today);
  if (start > "9999-12-24") {
    return jsonResponse(
      { error: "date is outside the supported calendar range" },
      { status: 400 },
    );
  }
  try {
    return jsonResponse(await loadWeek(getRepository(config), config, start, nowMs));
  } catch (error) {
    console.error(`week: feed read failed for ${start}`, error);
    return jsonResponse({ error: "event data unavailable" }, { status: 503 });
  }
}
