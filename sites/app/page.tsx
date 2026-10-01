/**
 * Vandy Food Radar — ranked free-food events for the target day.
 *
 * Server-rendered from the published feed only. The page performs no ingestion,
 * so loading it can never change stored data, and it never substitutes sample
 * content for real data. When storage cannot be read the page says so rather
 * than showing an empty list that looks like a quiet day on campus.
 */

import { EventCard } from "@/components/vfr/event-card";
import { RefreshButton } from "@/components/vfr/refresh-button";
import { loadFeedView } from "@/lib/vfr/feed.ts";
import {
  formatAge,
  formatPublishedAt,
  formatTargetDate,
} from "@/lib/vfr/labels.ts";
import { getConfig, getRepository } from "@/lib/vfr/runtime.ts";

export const dynamic = "force-dynamic";

export default async function Home() {
  const config = getConfig();

  let view;
  try {
    view = await loadFeedView(getRepository(config), config);
  } catch (error) {
    // A missing binding or an unreadable database is a deployment fault. It is
    // logged for the operator; the page says only that data is unavailable.
    console.error("home: feed could not be loaded", error);
    view = {
      state: "unavailable" as const,
      targetDate: "",
      timezone: config.timezone,
      todayDate: "",
      publishedAt: null,
      ageMs: null,
      stale: false,
      staleAfterMs: config.staleAfterMs,
      snapshot: null,
      lastRun: null,
      schemaMissing: false,
      message: "Event data is temporarily unavailable.",
    };
  }

  const events = view.snapshot?.events ?? [];
  const staleHours = Math.round(view.staleAfterMs / 3600000);

  return (
    <div className="vfr-page">
      <header className="vfr-masthead">
        <div className="vfr-masthead-text">
          <h1>Vandy Food Radar</h1>
          <p className="vfr-subtitle">
            Ranked Vanderbilt events advertising free food
            {view.targetDate ? ` for ${formatTargetDate(view.targetDate, view.timezone)}` : ""}
          </p>
        </div>
        <RefreshButton />
      </header>

      <main className="vfr-main">
        <section className="vfr-status" aria-label="Feed status">
          <dl className="vfr-status-grid">
            <div>
              <dt>Target date</dt>
              <dd>{view.targetDate || "unknown"}</dd>
            </div>
            <div>
              <dt>Time zone</dt>
              <dd>{view.timezone}</dd>
            </div>
            <div>
              <dt>Last successful update</dt>
              <dd>
                {formatPublishedAt(view.publishedAt, view.timezone)}
                {view.publishedAt ? ` (${formatAge(view.ageMs)})` : ""}
              </dd>
            </div>
            <div>
              <dt>Events listed</dt>
              <dd>{events.length}</dd>
            </div>
          </dl>

          {view.stale ? (
            <p className="vfr-notice vfr-notice-warn" role="status">
              This listing is more than {staleHours} hours old, so it may no longer match
              AnchorLink. Use Refresh events to fetch the current listing.
            </p>
          ) : null}

          {view.state === "unavailable" ? (
            <p className="vfr-notice vfr-notice-error" role="alert">
              {view.message}
            </p>
          ) : null}

          {view.state === "uninitialized" ? (
            <p className="vfr-notice" role="status">
              {view.message}
            </p>
          ) : null}

          {view.state === "empty" ? (
            <p className="vfr-notice" role="status">
              {view.message}
            </p>
          ) : null}

          {view.lastRun && view.lastRun.status !== "success" ? (
            <p className="vfr-notice vfr-notice-warn" role="status">
              The most recent refresh attempt did not complete, so the listing below is the
              last one that published successfully.
            </p>
          ) : null}
        </section>

        {events.length > 0 ? (
          <ol className="vfr-list">
            {events.map((stored) => (
              <EventCard key={stored.event.id} stored={stored} />
            ))}
          </ol>
        ) : null}

        <footer className="vfr-footnote">
          <p>
            Every listing is cross-checked against its source before it is shown. With one
            source available, an event can be marked partially verified at best, never fully
            verified. Walking times and RSVP requirements are shown only when the source
            provides them.
          </p>
          <p>
            Calendar files are downloads you choose to import. Nothing is ever added to a
            calendar automatically.
          </p>
        </footer>
      </main>
    </div>
  );
}
