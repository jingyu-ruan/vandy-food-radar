/**
 * `GET /api/events` — read the persisted feed.
 *
 * This route only reads. It never ingests, never writes, and never falls back to
 * sample data, so the response always reflects what a refresh actually
 * published.
 */

import { feedViewToJson, loadFeedView } from "@/lib/vfr/feed.ts";
import { getConfig, getRepository, jsonResponse } from "@/lib/vfr/runtime.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const config = getConfig();
  try {
    const repository = getRepository(config);
    const view = await loadFeedView(repository, config);
    const body = feedViewToJson(view);
    // A storage failure is a server fault; an unpublished or genuinely empty day
    // is a successful answer that happens to contain no events.
    return jsonResponse(body, { status: view.state === "unavailable" ? 503 : 200 });
  } catch (error) {
    console.error("events: feed read failed", error);
    return jsonResponse(
      {
        state: "unavailable",
        message: "Event data is temporarily unavailable.",
      },
      { status: 503 },
    );
  }
}
