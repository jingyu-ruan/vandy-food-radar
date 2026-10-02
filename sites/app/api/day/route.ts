/**
 * `GET /api/day?date=YYYY-MM-DD` — the ranked feed and brief for one local date.
 *
 * Read-only. A missing or malformed date selects today in the configured zone;
 * a valid date is honoured exactly and never widened, so the response holds
 * that one day's listings and nothing else.
 */

import { parseSelectedDate } from "@/lib/vfr/feed.ts";
import { getConfig, getRepository, jsonResponse } from "@/lib/vfr/runtime.ts";
import { localDateOf } from "@/lib/vfr/time.ts";
import { loadDayFeed } from "@/lib/vfr/workspace.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const config = getConfig();
  const nowMs = Date.now();
  const today = localDateOf(nowMs, config.timezone);
  const date = parseSelectedDate(new URL(request.url).searchParams.get("date"), today);
  try {
    const feed = await loadDayFeed(getRepository(config), config, date, nowMs);
    return jsonResponse(feed);
  } catch (error) {
    console.error(`day: feed read failed for ${date}`, error);
    return jsonResponse({ error: "event data unavailable" }, { status: 503 });
  }
}
