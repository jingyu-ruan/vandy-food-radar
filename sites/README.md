# Vandy Food Radar

Ranked Vanderbilt events advertising free food, in a date-specific campus workspace. The pipeline
is Discover → Normalize → Deduplicate → Verify → Rank → Display, and it is
**live-only**: there is no fixture corpus, no sample data, and no fallback. If
nothing has been published the page says so; if storage cannot be read it says
that instead of showing an empty day.

The single source is the Vanderbilt AnchorLink discovery API
(`/api/discovery/event/search` with `benefitNames=FreeFood`). A row is accepted
only when it carries the exact `Free Food` benefit, is `Approved` and `Public`,
matches institution 24 / branch 56623, has a numeric API-returned id, and starts
on the requested local date. Ended events remain visible on their date. Event links are built
only from ids the API returned. Descriptions are reduced to plain text.

## Layout

| Path | Purpose |
| --- | --- |
| `lib/vfr/` | The pipeline: source adapter, normalize, dedup, verify, rank, repository, read model, auth. |
| `db/schema.ts`, `drizzle/` | Drizzle schema and the generated migrations. |
| `app/` | Server-rendered page and the API routes. |
| `tests/` | Offline tests, including real-SQL checks over `node:sqlite`. |

## Commands

```sh
npm run install:ci   # one locked dependency install
npm test            # offline pipeline, parity, and real-SQL checks
node --test tests/js/*.test.mjs
npm run lint
npm run typecheck
npm run build
npm run db:generate  # regenerate migrations after editing db/schema.ts
```

Tests run under Node's strip-only TypeScript loader, so the source avoids
non-erasable syntax (parameter properties, `enum`, namespaces). `tsconfig.json`
sets `erasableSyntaxOnly` so a regression fails typecheck rather than the test
run.

Applied migrations are immutable. A schema change means a new numbered delta from
`npm run db:generate`, never an edit to an existing file.

## Refresh and unattended operation

`POST /api/refresh` is the primary writer. The token-protected `/cron/refresh` compatibility route also writes. The `days` query accepts 1, 2, or 7 (default 1), starting today in America/Chicago.
One run fetches every source page for all requested dates, computes those feeds
in memory, and publishes them together in a single D1 batch, so
a source outage or a storage failure leaves the previously published feed exactly
as it was. A successful response with zero events is a real empty day.

Concurrency is handled by a persistent lease with an expiry:

- The claim is conditional in SQL, so two overlapping refreshes cannot both
  proceed.
- The holder is re-validated **inside** the publish transaction. The first
  statement writes `app_state.value` from a sub-select of the publisher's own
  lease row, and that column is `NOT NULL`, so a run that overran its lease and
  was superseded rolls back instead of overwriting the newer feed.
- A lease that expired but was never taken over and never released may still
  finish, so a slow-but-uncontested run is not thrown away.

The GitHub workflow in the enclosing repository calls the fixed Site origin with
the `VFR_SITES_SERVICE_TOKEN` and `VFR_REFRESH_TOKEN` repository secrets. It refreshes today and tomorrow every two
hours at minute 17, and seven days every six hours at minute 47. A manual run can
select either span. After publication it reads `/api/events?date=YYYY-MM-DD` for
each date and checks the date, event count, timezone, publication timestamp, and
freshness. Transient failures receive bounded retries; redirects are rejected.

Scheduling updates data through the published writer. The legacy `/cron/refresh`
route additionally requires `Authorization: Bearer <VFR_REFRESH_TOKEN>`, including
on a private Site. The existing native Sites automation remains paused.
`GET /api/health` reports storage reachability and the last run outcome.

## Campus workspace

The activity workspace places date controls next to the event content. Day, Week,
and Map are display modes with directional horizontal transitions, respecting
reduced motion. Saving uses yellow star buttons and never opens another panel.
Week lists today and future dates only; event rows are buttons that select the
event and pan the adjacent map to its resolved building, opening the map tooltip
so the location name is visible. On narrow screens where the Week map is hidden,
selecting a mapped event switches to the Map view for its date. Source links, walking directions,
and the save action live inside each row's ellipsis menu. Saved events display a
filled gold star beside the ellipsis that unsaves on click; unsaved events offer
Save inside the menu. The entire row including star and ellipsis shares a hover
and focus background; the ellipsis appears on hover for pointer devices and stays
visible on touch. Selecting an event whose location did not resolve to a campus building shows
concise inline feedback. The desktop schedule layout is
roughly 40 percent event list and 60 percent map. The first day's top border is
removed to avoid a redundant separator under the heading; day separators between
dates are preserved. The desktop list scrolls independently while the map remains
visible. Week and Map selection share an accent border and inset text padding.
The segmented Day/Week/Map control matches the 44-pixel
date-input height. Settings provide light, dark, and system appearance, plus
12-hour and 24-hour clocks, retained in device-local storage. Display copy uses
spacing and complete phrases instead of middle-dot separators. Settings sit in
the event toolbar, save immediately, and close using an icon or Escape. The header
and close control stay fixed while the settings body scrolls. Mobile form fields
use at least 16-pixel type to avoid automatic input zoom; closing restores page
scroll and opener focus. Segmented controls have a moving selection surface.
The header walking origin opens its own keyboard-accessible campus picker and
truncates long names to one line. Event cards
use a single column so expanded details never stretch a neighboring card. Food
certainty and category are combined in a semantic colored badge; unspecified
food remains explicitly unspecified, without implying quality. Cards
show source-derived food excerpts, participation restrictions, change warnings,
calendar actions, and resolved campus buildings with room details. The Day view's
event title links to AnchorLink. Fact labels use consistent functional icons and
type sizes; mobile footer controls remain on one line with 44-pixel heights.
Rating opens on hover, focus, or click and shows each stored factor's weight,
value, contribution, and explanation. Scores remain the published snapshot:
changing walking origin or display preferences never changes the rating.
The daily brief uses optional server-side Gemini generation, cached durably in D1
by local date and source-content hash. Without a key or when inference fails,
the source-derived rule summary remains available.
The checked-in dataset contains 58 curated campus places; unknown names remain
unresolved. Participation contributes at most five percent to ranking.

Saved events and the selected walking origin stay in device-local storage. Walking routes use the fixed FOSSGIS OpenStreetMap pedestrian endpoint, on explicit route requests, with bounded waypoints, a cache, and serialized requests. An optional OpenRouteService key selects that provider instead. Map attribution links to FOSSGIS and Fix the Map; automatic card estimates avoid requesting public pedestrian routes. Missing or failed routing is labelled as a distance-based
estimate. Routing keys remain server-side.

The Map view puts the scrolling event list beneath From/To in the desktop sidebar.
The list retains at least 180 pixels of height even when the endpoint controls
grow. Endpoint controls have no enclosing panel border, and location/pin actions
share the blue accent. Week has a bottom fade with a clickable More events arrow
when its independent desktop list overflows; the cue disappears at the bottom.
On mobile, compact endpoint controls appear in normal flow above the map, with
the event list beneath it. Changing coordinates pans the persistent map smoothly;
label-only updates and save actions preserve its camera. A new selection can
interrupt the previous pan, and reduced motion uses immediate positioning.
The walking link reads Open in Google Map.
The basemap uses OpenFreeMap Liberty vector tiles rendered through MapLibre and
Leaflet. Buildings use light neutral fills, parks retain natural green, and
low-priority place labels appear only at closer zoom levels. Activity markers
are blue; saved activities are gold, with an outer ring for selection. The
public service requires no API key. If vector assets, WebGL, or map requests
fail, standard OSM raster tiles appear with a notice. Visible attribution
credits OpenFreeMap, OpenMapTiles, and OpenStreetMap.
From and To search the verified campus dataset locally, with keyboard selection;
events remain available in a destination dropdown. Current-location selection
and explicit map selection modes remain available. In selection mode, campus markers,
event markers, and arbitrary map clicks set the requested endpoint. Google Maps
walking links prefill both endpoints with the exact coordinates, or a listed
address for unresolved events. Selecting a nearby address never snaps the
coordinates to that address. GPS and unnamed pins request a bounded nearest
address from Photon through `POST /api/location`; this user-triggered request
has a six-second upstream timeout and preserves coordinates on failure. Labels
say "Near" because the result describes a nearby address, not verified GPS
accuracy. No background geocoding or autocomplete is performed. OSM/Photon
attribution appears with the location controls. A denied browser location
permission leaves all campus and map selection methods available.

Date-specific reads never ingest events:

| Route | Purpose |
| --- | --- |
| `/api/day?date=YYYY-MM-DD` | Card view for exactly one date, including its daily brief. |
| `/api/week?start=YYYY-MM-DD` | Seven distinct date buckets. |
| `/api/events?date=YYYY-MM-DD` | Persisted pipeline projection for readback. |
| `/api/meta` | Public workspace defaults and refresh spans. |
| `POST /api/walking` | Validated pedestrian route or labelled estimate. |
| `/api/calendar/<AnchorLink id>` | Download a published event's ICS file. |

## Public access and refresh authorization

The public deployment uses `VFR_OWNER_PRIVATE=false`. Anonymous visitors can read
published listings. Mutating refresh requests require the application bearer
token stored as `VFR_REFRESH_TOKEN` in both Sites and GitHub Actions secrets.
The owner-only refresh button is omitted from the public page. Secrets are never
embedded in the browser or its workspace configuration.

The original Codex mark appears once, to the left of the main heading, and links
home. The image is decorative for assistive technology because the adjacent
heading and link label provide its meaning. A dedicated simplified favicon and
Apple touch icon share the same design. This placement applies Apple's guidance
on discreet branding, aligned related content and responsive layout:
https://developer.apple.com/design/human-interface-guidelines/branding
https://developer.apple.com/design/human-interface-guidelines/layout

### Private deployment support

For an owner-private deployment, the hosting platform's dispatch layer authorizes
every inbound request before the Worker runs. `VFR_OWNER_PRIVATE=true` lets
`POST /api/refresh` rely on that boundary, narrowly:

- Only `POST /api/refresh`, never a GET, and never `/cron/refresh`.
- A configured `VFR_REFRESH_TOKEN` is always honoured and compared in constant
  time.
- Browser-originated mutations must carry a same-origin `Origin`. A service
  caller legitimately sends none, which is allowed; a foreign `Origin` is
  rejected, which is what blocks cross-site request forgery.
- With neither the flag nor a token the endpoint fails closed.

The bearer token is read from `Authorization` only. `OAI-Sites-Authorization` is
the platform's own service-access credential, checked and consumed by dispatch,
and is never compared against `VFR_REFRESH_TOKEN`. A service caller presenting
only that header still reaches refresh through the owner-private boundary.

If the Site is ever shared publicly, set `VFR_OWNER_PRIVATE=false` and configure
`VFR_REFRESH_TOKEN`.

## Configuration

Variables are read from the Worker environment; see `.dev.vars.example` for local
use and `lib/vfr/config.ts` for the full list and defaults. Every value has a
working default, and an unrecognized value falls back to it rather than throwing.
Common ones: `VFR_OWNER_PRIVATE`, `VFR_REFRESH_TOKEN` (or `CRON_SECRET`),
`VFR_TIMEZONE`, `VFR_STALE_AFTER_HOURS`, retention settings, and
`VFR_ORS_API_KEY`. Refresh starts on today; selected dates are strict ISO dates. Secrets live only
in the hosted environment or in `.dev.vars`, never in the repository.

Visitor-facing failures are plain: the page and the JSON routes say the listing
is temporarily unavailable. Storage diagnostics, including an unapplied
migration, go to the server log and `GET /api/health`, because a visitor cannot
act on a deployment fault.

## Local development

Use Node 24 for the test suite. Install the locked dependencies, copy
`.dev.vars.example` to ignored `.dev.vars`, and run `npm run build` once.
Apply pending local migrations in order, once each:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_harsh_banshee.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_common_black_knight.sql
npm run dev
```

Use the loopback URL printed by the server. `npm start` previews the built Worker
with the same local database. Production migrations are applied through Sites
publication. Runtime secrets belong in Sites environment settings.

## Migration adaptations

The React page, Worker API, and D1 persistence are hosted together on Sites.
Published snapshots, source payloads, per-field provenance, scoring, changes,
refresh logs, and leases are durable; the read path never triggers ingestion.
The original Python/Vercel checkout is retained separately as a rollback option.

The seven original ranking factors retain their relative weights, scaled to
leave at most five percent for source-text participation assessment.
The description-detail label describes what the old specificity calculation
actually measures. A single AnchorLink source has confidence 0.30 and is marked
partially verified. Optional walking providers retain their configuration, with
unknown walks represented neutrally by default.

Calendar actions include a Google Calendar prefill link and download one `.ics` file from `/api/calendar/<AnchorLink id>`.
The file contains the source URL and absolute event times. Importing the file is
an explicit action in the user's calendar app.

## Gemini daily briefs and participation estimates

Configure `GEMINI_API_KEY` as a secret in the Site's server environment.
`VFR_GEMINI_MODEL` optionally selects a Gemini Flash model; the default is
`gemini-3.5-flash-lite`. Google AI Studio showed the new project on Free tier on
October 3, 2026. Availability and quotas are controlled by Google; selecting a
model does not impose a billing cap on a paid Google project.

Each protected source refresh can issue one combined request for each nonempty
requested date, up to 40 events per date. Unchanged inputs reuse a durable D1
result across visitors and Worker restarts. Visitor GET requests only read data.
Requests time out after 15 seconds; failed or changed-input requests have a
one-hour cooldown and a maximum of three attempts per event date and prompt version per Chicago
calendar day. Attempts are stored before inference under the refresh lease.
AI records age out with the feed retention window. A successful source refresh
continues even when Gemini is unavailable or its response fails validation.

The English Daily Brief shows one opening sentence followed by a semantic table with
Ranking, Activity, Time, Food, Location, Walk and Notes columns for every event.
The table scrolls horizontally on narrow screens. Tablet layouts keep activity
names visible; phone layouts give the Notes column room to be read in full.
Linked event names scroll to and focus their corresponding cards. Its metadata identifies the generation
date/time and actual model ID. The model's structured reasons are grounded in verbatim
source evidence. Gemini returns bounded JSON prose for the opening sentence and
Notes cells; the application constructs all table markup and supplies source times,
ranking, links and locations. Walk values update with the visitor's selected origin
and remain labelled as estimates when a pedestrian route is unavailable.
Participation displays one evidence-backed explanation, with source-derived analysis
as the fallback. An exact supporting quote remains accessible in the hover title.
Changed source inputs invalidate cached AI immediately; a new prompt version starts
a fresh bounded retry budget. Credentials remain outside browser code and archives.

Map updates the pedestrian route automatically after both endpoints are chosen,
including event selection, campus search and map pins. Identical coordinate pairs
reuse the route; rapid changes cancel stale results. Unmapped destinations retain
the Google Maps link and an explicit coordinate limitation.

Official reference: https://ai.google.dev/gemini-api/docs/pricing
