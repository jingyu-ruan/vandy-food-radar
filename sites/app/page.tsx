/**
 * Vandy Food Radar — the campus workspace for one selected local date.
 *
 * Server-rendered from published data only: the page performs no ingestion, so
 * loading it can never change stored data, and it never substitutes sample
 * content for real data. `?date=YYYY-MM-DD` selects a day; anything else shows
 * today in the configured zone. The first paint already contains that day's
 * cards and brief; `WorkspaceBoot` then starts the shared browser modules that
 * drive date changes, the schedule, the map, the walking origin, saved
 * events, and the itinerary.
 *
 * The workspace configuration is embedded as JSON with `<` escaped, so no
 * value can terminate the script element; it carries no secret.
 */

import type { Metadata } from "next";

import { RefreshButton } from "@/components/vfr/refresh-button";
import { WorkspaceBoot } from "@/components/vfr/workspace-boot";
import { WorkspaceCard } from "@/components/vfr/workspace-card";
import { parseSelectedDate } from "@/lib/vfr/feed.ts";
import type { LastSuccess } from "@/lib/vfr/repository.ts";
import { getConfig, getRepository, getRouter } from "@/lib/vfr/runtime.ts";
import { localDateOf } from "@/lib/vfr/time.ts";
import { clientConfig, scriptJson } from "@/lib/vfr/viewmodel.ts";
import type { DayFeedJson } from "@/lib/vfr/viewmodel.ts";
import { loadDayFeed } from "@/lib/vfr/workspace.ts";

export const dynamic = "force-dynamic";

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function longDate(isoDate: string, options: Intl.DateTimeFormatOptions): string {
  const ms = Date.parse(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(ms)) return isoDate;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(new Date(ms));
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const config = getConfig();
  const today = localDateOf(Date.now(), config.timezone);
  const selected = parseSelectedDate(firstValue((await searchParams).date), today);
  return {
    title: `Vandy Food Radar \u2014 ${longDate(selected, { weekday: "short", month: "short", day: "numeric" })}`,
  };
}

export default async function Home({ searchParams }: PageProps) {
  const config = getConfig();
  // The dynamic server page evaluates the clock once for this request.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const today = localDateOf(nowMs, config.timezone);
  const selected = parseSelectedDate(firstValue((await searchParams).date), today);

  let feed: DayFeedJson | null = null;
  let lastSuccess: LastSuccess | null = null;
  try {
    const repository = getRepository(config);
    feed = await loadDayFeed(repository, config, selected, nowMs);
    lastSuccess = await repository.lastSuccess();
  } catch (error) {
    // A missing binding or an unreadable database is a deployment fault. It is
    // logged for the operator; the page says only that data is unavailable.
    console.error(`home: feed could not be loaded for ${selected}`, error);
  }

  const cards = feed?.events ?? [];
  const reference = config.referenceLocation;
  const lastAt = lastSuccess ? Date.parse(lastSuccess.at) : NaN;
  const stale = Number.isFinite(lastAt) && nowMs - lastAt > config.staleAfterMs;
  const scope = `${longDate(selected, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}${selected === today ? " \u00b7 today" : ""} \u00b7 walking from `;
  const briefText = feed
    ? feed.brief.text
    : "Event data is temporarily unavailable. The last published listing could not be read.";
  const emptyText =
    feed?.state === "uninitialized"
      ? "No listing has been published for this date yet."
      : "No free-food listings are published for this date.";
  const routing = getRouter(config).routingAvailable;

  return (
    <>
      <a className="skip-link" href="#workspace">
        Skip to events
      </a>
      <div className="shell">
        <aside className="sidebar" id="workspace-sidebar" aria-label="Workspace navigation">
          <button
            type="button"
            className="mobile-sidebar-close control-button"
            data-action="toggle-sidebar"
          >
            Close settings
          </button>
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            <span className="brand-name">Vandy Food Radar</span>
          </div>

          <nav className="nav" aria-label="Views">
            <button type="button" className="nav-item is-current" data-view="cards" aria-current="page">
              Cards
            </button>
            <button type="button" className="nav-item" data-view="schedule">
              Schedule
            </button>
            <button type="button" className="nav-item" data-view="itinerary">
              Itinerary
            </button>
          </nav>

          <section className="side-block" aria-labelledby="origin-heading">
            <h2 className="side-heading" id="origin-heading">
              Walking origin
            </h2>
            <div className="combobox" data-module="origin">
              <label className="visually-hidden" htmlFor="origin-input">
                Search campus places
              </label>
              <input
                id="origin-input"
                className="control"
                type="text"
                role="combobox"
                aria-expanded="false"
                aria-controls="origin-options"
                aria-autocomplete="list"
                autoComplete="off"
                placeholder="Search campus building"
              />
              <ul className="combobox-list" id="origin-options" role="listbox" hidden />
              <div className="side-actions">
                <button type="button" className="control-button" data-action="origin-gps">
                  Use my location
                </button>
                <button type="button" className="control-button" data-action="origin-pin">
                  Pick on map
                </button>
                <button type="button" className="control-button" data-action="origin-reset">
                  Reset
                </button>
              </div>
              <p className="side-status" data-role="origin-status" aria-live="polite">
                Origin: {reference.label}
              </p>
            </div>
          </section>

          <section className="side-block" aria-labelledby="saved-heading">
            <h2 className="side-heading" id="saved-heading">
              Saved
            </h2>
            <p className="side-status" data-role="saved-count" aria-live="polite">
              None saved
            </p>
            <button type="button" className="control-button" data-action="clear-saved">
              Clear saved
            </button>
          </section>

          <section className="side-block" aria-labelledby="status-heading">
            <h2 className="side-heading" id="status-heading">
              Data
            </h2>
            <p className="side-status">
              {lastSuccess
                ? `Last refresh ${lastSuccess.at.slice(0, 16).replace("T", " ")} UTC`
                : "No recorded refresh yet"}
              {stale ? " \u00b7 may be out of date" : ""}
            </p>
            <RefreshButton />
          </section>
        </aside>

        <main className="workspace" id="workspace">
          <header className="work-head">
            <div className="work-head-row">
              <button
                type="button"
                className="mobile-settings control-button"
                data-action="toggle-sidebar"
                aria-expanded="false"
                aria-controls="workspace-sidebar"
              >
                Location &amp; saved
              </button>
              <h1 className="work-title">Free food on campus</h1>
              <div className="date-nav" data-module="date-nav">
                <button
                  type="button"
                  className="control-button"
                  data-action="prev-day"
                  aria-label="Previous day"
                >
                  ‹
                </button>
                <label className="visually-hidden" htmlFor="date-input">
                  Selected date
                </label>
                <input
                  id="date-input"
                  className="control control-date"
                  type="date"
                  defaultValue={selected}
                />
                <button
                  type="button"
                  className="control-button"
                  data-action="next-day"
                  aria-label="Next day"
                >
                  ›
                </button>
                <button type="button" className="control-button" data-action="today">
                  Today
                </button>
              </div>
            </div>
            <p className="work-sub" data-role="scope">
              {scope}
              <span data-role="origin-label">{reference.label}</span>
            </p>
          </header>

          <section className="brief" aria-labelledby="brief-heading" data-role="brief">
            <h2 className="section-heading" id="brief-heading">
              Daily brief
            </h2>
            <p className="brief-text" data-role="brief-text">
              {briefText}
            </p>
          </section>

          <section
            className="view view-cards is-active"
            data-view-panel="cards"
            aria-labelledby="cards-heading"
          >
            <h2 className="section-heading" id="cards-heading">
              Listings{" "}
              <span className="count" data-role="card-count">
                {cards.length}
              </span>
            </h2>
            <div className="card-grid" data-role="card-grid">
              {cards.length ? (
                cards.map((card) => <WorkspaceCard key={card.identity_key} card={card} />)
              ) : (
                <p className="empty">{feed ? emptyText : briefText}</p>
              )}
            </div>
          </section>

          <section
            className="view view-schedule"
            data-view-panel="schedule"
            aria-labelledby="schedule-heading"
            hidden
          >
            <div className="schedule-head">
              <h2 className="section-heading" id="schedule-heading">
                Week of <span data-role="week-label" />
              </h2>
              <div className="schedule-toggle" aria-label="Schedule display">
                <button
                  type="button"
                  className="control-button is-current"
                  data-schedule-mode="agenda"
                  aria-pressed="true"
                >
                  Agenda
                </button>
                <button
                  type="button"
                  className="control-button"
                  data-schedule-mode="map"
                  aria-pressed="false"
                >
                  Map
                </button>
              </div>
            </div>
            <div className="schedule-layout" data-schedule-display="agenda">
              <div className="agenda" data-role="agenda" aria-live="polite" />
              <div className="schedule-map-host" data-role="schedule-map-host" />
            </div>
          </section>

          <section
            className="view view-map"
            data-view-panel="map"
            aria-labelledby="map-heading"
            hidden
          >
            <h2 className="section-heading" id="map-heading">
              Map
            </h2>
            <div data-role="map-home">
              <div className="map-split" data-role="map-split">
                <div className="map-canvas" data-role="map" role="application" aria-label="Campus map">
                  <p className="map-placeholder" data-role="map-status">
                    Loading map…
                  </p>
                </div>
                <p className="map-selection" data-role="map-selection" aria-live="polite" />
                <ol className="map-list" data-role="map-list" aria-label="Mapped listings" />
              </div>
            </div>
          </section>

          <section
            className="view view-itinerary"
            data-view-panel="itinerary"
            aria-labelledby="itinerary-heading"
            hidden
          >
            <h2 className="section-heading" id="itinerary-heading">
              Itinerary
            </h2>
            <div className="itinerary-controls">
              <label className="field">
                <span>Leave at</span>
                <input className="control" type="time" data-role="depart-at" defaultValue="17:00" />
              </label>
              <label className="field">
                <span>Minutes per stop</span>
                <input
                  className="control"
                  type="number"
                  min="0"
                  max="240"
                  step="5"
                  data-role="dwell"
                />
              </label>
              <button type="button" className="control-button" data-action="optimize">
                Order by feasibility
              </button>
            </div>
            <p className="side-status" data-role="itinerary-status" aria-live="polite" />
            <div className="plan-layout">
              <ol className="itinerary-list" data-role="itinerary" />
              <div className="plan-map-host" data-role="plan-map-host" />
            </div>
          </section>
        </main>
      </div>

      <nav className="mobile-nav" aria-label="Views">
        <button type="button" className="mobile-nav-item is-current" data-view="cards">
          Cards
        </button>
        <button type="button" className="mobile-nav-item" data-view="schedule">
          Schedule
        </button>
        <button type="button" className="mobile-nav-item" data-view="itinerary">
          Plan
        </button>
      </nav>

      <script
        type="application/json"
        id="vfr-config"
        // Our own configuration, serialized with `<`, `>`, and `&` escaped.
        dangerouslySetInnerHTML={{
          __html: scriptJson(clientConfig(config, today, selected, routing)),
        }}
      />
      <WorkspaceBoot />
    </>
  );
}
