import {BriefAssessments} from "@/components/vfr/brief-assessments";
import {generatedLabel} from "@/public/static/js/brief.js";
/**
 * Free Bites at Vandy — the campus workspace for one selected local date.
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

import { displayText } from "@/lib/vfr/display.ts";
import { ActionIcon } from "@/components/vfr/action-icon";
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
    title: `Free Bites at Vandy \u2014 ${longDate(selected, { weekday: "short", month: "short", day: "numeric" })}`,
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
        <dialog className="sidebar" id="workspace-sidebar" aria-labelledby="settings-heading">
          <div className="settings-head"><h2 id="settings-heading">Settings</h2>
          <button type="button" className="control-button" data-action="toggle-sidebar" aria-label="Close settings"><ActionIcon name="close" /></button></div>
          <div className="settings-body">
          <section className="side-block" aria-labelledby="appearance-heading">
            <h3 className="side-heading" id="appearance-heading">Appearance</h3>
            <div className="segmented" role="group" aria-label="Appearance">
              <button type="button" data-theme="system" aria-pressed="true">System</button>
              <button type="button" data-theme="light" aria-pressed="false">Light</button>
              <button type="button" data-theme="dark" aria-pressed="false">Dark</button>
            </div>
          </section>
          <section className="side-block" aria-labelledby="clock-heading">
            <h3 className="side-heading" id="clock-heading">Time Format</h3>
            <div className="segmented" role="group" aria-label="Time Format">
              <button type="button" data-clock="12" aria-pressed="true">12-hour</button>
              <button type="button" data-clock="24" aria-pressed="false">24-hour</button>
            </div>
            <p className="side-status" data-role="preferences-status" aria-live="polite">Changes save automatically on this device.</p>
          </section>
          <section className="side-block" aria-labelledby="origin-heading">
            <h2 className="side-heading" id="origin-heading">
              Walking Origin
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
                <button type="button" className="utility-action" data-action="origin-gps">
                  <ActionIcon name="location" />Use My Location
                </button>
                <button type="button" className="utility-action" data-action="origin-pin">
                  <ActionIcon name="pin" />Pick on Map
                </button>
                <button type="button" className="utility-action" data-action="origin-reset">
                  <ActionIcon name="reset" />Reset
                </button>
              </div>
              <p className="location-attribution">Map and Routes: <a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noopener noreferrer">FOSSGIS</a> / <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener noreferrer">Fix the Map</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> / Photon</p>
              <p className="side-status" data-role="origin-status" aria-live="polite">
                Origin: {displayText(reference.label)}
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
              Clear Saved
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
              {stale ? ". May be out of date." : ""}
            </p>
            {config.ownerPrivate && <RefreshButton />}
          </section>
          </div>
        </dialog>

        <main className="workspace" id="workspace">
          <header className="work-head">
            <div className="work-head-row">
              <div className="work-brand">
                <a className="brand-home" href="/" aria-label="Free Bites at Vandy home">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local vector brand mark has fixed dimensions */}
                  <img className="brand-icon" src="/static/brand/vfr-icon.svg" width="44" height="44" alt="" aria-hidden="true" />
                </a>
                <div className="work-brand-copy"><h1 className="work-title">Free Bites at Vandy</h1><p className="work-slogan">May the fork be with you.</p></div>
              </div>
            </div>
            <div className="work-sub"><span>Walking From</span><div className="origin-picker">
              <button type="button" className="origin-button" data-action="edit-origin" aria-haspopup="dialog" aria-expanded="false" aria-controls="header-origin-picker" title={`Change walking location: ${displayText(reference.label)}`}><ActionIcon name="location" /><span data-role="origin-label">{displayText(reference.label)}</span><ActionIcon name="chevron-down" /></button>
              <div className="origin-popover" id="header-origin-picker" role="dialog" aria-label="Walking Origin" hidden>
                <div className="origin-popover-head"><label htmlFor="header-origin-input">Walking Origin</label><button type="button" className="icon-button utility-action" data-action="close-origin" aria-label="Close location picker"><ActionIcon name="close" /></button></div>
                <div className="combobox"><input className="control" id="header-origin-input" type="search" role="combobox" aria-expanded="false" aria-controls="header-origin-options" aria-autocomplete="list" autoComplete="off" placeholder="Search campus buildings" /><ul className="combobox-list" id="header-origin-options" role="listbox" hidden /></div>
                <div className="side-actions"><button type="button" className="utility-action" data-action="origin-gps"><ActionIcon name="location" />Use My Location</button><button type="button" className="utility-action" data-action="origin-pin"><ActionIcon name="pin" />Pick on Map</button><button type="button" className="utility-action" data-action="origin-reset"><ActionIcon name="reset" />Reset</button></div>
                <p className="side-status" data-role="header-origin-status" aria-live="polite" />
              </div>
            </div></div>
          </header>
          <div className="event-toolbar">
              <div className="date-nav" data-module="date-nav">
                <button
                  type="button"
                  className="control-button"
                  data-action="prev-day"
                  aria-label="Previous day"
                  title="Previous day"
                >
                  <ActionIcon name="chevron-left" />
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
                  title="Next day"
                >
                  <ActionIcon name="chevron-right" />
                </button>
                <button type="button" className="control-button" data-action="today">
                  Today
                </button>
              </div>
              <div className="toolbar-display">
                <div className="segmented view-switch" role="group" aria-label="Event display">
                  <button type="button" data-view="cards" className="is-current" aria-pressed="true">Day</button>
                  <button type="button" data-view="schedule" aria-pressed="false">Week</button>
                  <button type="button" data-view="map" aria-pressed="false">Map</button>
                </div>
                <button type="button" className="control-button settings-button icon-button" data-action="toggle-sidebar" aria-label="Settings" title="Settings" aria-haspopup="dialog" aria-controls="workspace-sidebar"><ActionIcon name="settings" /></button>
              </div>
          </div>
          <div className="workspace-layout" data-role="workspace-layout">
          <div className="event-content">
          <section
            className="view view-cards is-active"
            data-view-panel="cards"
            aria-labelledby="cards-heading"
          >
            <section className="brief" aria-labelledby="brief-heading" data-role="brief"><h2 className="section-heading" id="brief-heading">Daily Brief</h2><p className="brief-text" data-role="brief-text" lang="en">{displayText(briefText)}</p><BriefAssessments brief={feed?.brief} date={selected} events={feed?.events} /><p className="brief-meta" data-role="brief-meta" hidden={!generatedLabel(feed?.brief,config.timezone)}>{generatedLabel(feed?.brief,config.timezone)}</p></section>
            <div className="events-heading"><h2 className="section-heading" id="cards-heading">
              Events{" "}
              <span className="count" data-role="card-count">
                {cards.length}
              </span>
            </h2>
            <p className="selected-date-label" data-role="selected-date-label">{longDate(selected, { weekday: "long", month: "long", day: "numeric" })}</p></div>
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
            </div>
            <div className="schedule-layout" data-schedule-display="agenda">
              <div className="agenda-scroll">
                <div className="agenda" data-role="agenda" id="week-agenda" aria-live="polite" tabIndex={0} aria-label="Weekly events" />
                <button type="button" className="agenda-scroll-hint" data-action="scroll-agenda" aria-controls="week-agenda" hidden>More Events<ActionIcon name="chevron-down" /></button>
              </div>
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
            <div className="map-workspace">
            <div className="map-side">
            <section className="directions-controls" aria-label="Walking Directions">
              <div className="directions-fields">
                <div className="field">
                  <label htmlFor="map-origin">From</label>
                  <div className="combobox"><input className="control" id="map-origin" type="search" role="combobox" aria-expanded="false" aria-controls="map-origin-options" aria-autocomplete="list" autoComplete="off" placeholder="Search campus buildings" defaultValue={displayText(reference.label)} /><ul className="combobox-list" id="map-origin-options" role="listbox" hidden /></div>
                  <div className="field-tools">
                    <button type="button" className="control-button icon-button" data-action="origin-gps" aria-label="Use My Location" title="Use My Location"><ActionIcon name="location" /></button>
                    <button type="button" className="utility-action" data-action="origin-pin" aria-label="Set From on map"><ActionIcon name="pin" />Set From</button>
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="map-place-search">To</label>
                  <div className="combobox"><input className="control" id="map-place-search" type="search" role="combobox" aria-expanded="false" aria-controls="map-place-options" aria-autocomplete="list" autoComplete="off" placeholder="Search campus buildings" /><ul className="combobox-list" id="map-place-options" role="listbox" hidden /></div>
                  <div className="field-tools">
                    <select className="control" id="map-destination" aria-label="Choose an event destination" defaultValue=""><option value="">Choose an event</option></select>
                    <button type="button" className="utility-action" data-action="pin-destination" aria-label="Set To on map"><ActionIcon name="pin" />Set To</button>
                  </div>
                </div>
              </div>
              <div className="directions-actions">
                <a className="control-button directions-link" data-role="google-directions" aria-disabled="true" tabIndex={-1} target="_blank" rel="noopener noreferrer"><ActionIcon name="directions" />Open in Google Maps</a>
              </div>
              <p className="route-status" data-role="walking-route-status" aria-live="polite" />
              <p className="side-status" data-role="map-location-status" aria-live="polite" />
              <p className="location-attribution">Map and Routes: <a href="https://routing.openstreetmap.de/about.html" target="_blank" rel="noopener noreferrer">FOSSGIS</a> / <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener noreferrer">Fix the Map</a> / <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> / <a href="https://photon.komoot.io" target="_blank" rel="noopener noreferrer">Photon</a></p>
            </section>
            <section className="map-events" aria-labelledby="mapped-events-heading"><h3 id="mapped-events-heading" className="section-heading">Events <span className="count" data-role="map-event-count" /></h3><ol className="map-list" data-role="map-list" aria-label="Events for the selected date" /></section>
            </div>
            <div className="map-instructions" data-role="map-instructions" hidden><span data-role="pin-instructions" /><button type="button" className="control-button" data-action="cancel-pin">Cancel Selection</button></div>
            <div data-role="map-home">
              <div className="map-split" data-role="map-split">
                <div className="map-canvas" data-role="map" role="application" aria-label="Campus map">
                  <p className="map-placeholder" data-role="map-status">
                    Loading map…
                  </p>
                </div>
                <p className="map-selection" data-role="map-selection" aria-live="polite" />
              </div>
            </div>
            </div>
          </section>

          </div>
          </div>
        </main>
      </div>

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
