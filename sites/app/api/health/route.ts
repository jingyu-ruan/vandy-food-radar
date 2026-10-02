/**
 * `GET /api/health` — concise operational state.
 *
 * Reports whether durable storage is reachable, whether today has been
 * published, how old that publication is, and the last complete multi-day
 * refresh. Deliberately terse and free of any
 * credential, hostname, or internal identifier.
 */

import { loadFeedView } from "@/lib/vfr/feed.ts";
import { getConfig, getRepository, jsonResponse } from "@/lib/vfr/runtime.ts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const config = getConfig();
  try {
    const repository = getRepository(config);
    const probe = await repository.probe();
    const view = await loadFeedView(repository, config);
    const lastSuccess = await repository.lastSuccess();
    const healthy = view.state !== "unavailable";
    return jsonResponse(
      {
        status: healthy ? (view.stale ? "stale" : "ok") : "unavailable",
        database: "reachable",
        feedState: view.state,
        targetDate: view.targetDate,
        timezone: view.timezone,
        publishedAt: view.publishedAt,
        ageSeconds: view.ageMs === null ? null : Math.floor(view.ageMs / 1000),
        stale: view.stale,
        eventCount: view.snapshot?.events.length ?? 0,
        retainedFeedDays: probe.feedCount,
        lastSuccess,
        lastRun: view.lastRun
          ? {
              status: view.lastRun.status,
              finishedAt: view.lastRun.finishedAt,
              targetDate: view.lastRun.targetDate,
              published: view.lastRun.published,
              trigger: view.lastRun.trigger,
              error: view.lastRun.error,
            }
          : null,
      },
      { status: healthy ? 200 : 503 },
    );
  } catch (error) {
    console.error("health: storage probe failed", error);
    const schemaMissing = /no such table|no such column/i.test(
      error instanceof Error ? error.message : "",
    );
    return jsonResponse(
      {
        status: "unavailable",
        database: schemaMissing ? "schema not applied" : "unreachable",
        feedState: "unavailable",
      },
      { status: 503 },
    );
  }
}
