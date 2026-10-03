# Vandy Food Radar

## Current Sites deployment

The live application is now hosted at
[https://vandy-food-radar.rjy020128.chatgpt.site](https://vandy-food-radar.rjy020128.chatgpt.site)
with owner-private access. React/Vinext serves the page and API in one Sites
Worker, and Sites D1 stores feeds, source records, scoring, change history, and
refresh leases. The production application operates on real AnchorLink data.

The campus workspace includes date-specific cards, a source-derived daily brief,
a weekly schedule, a map, saved events, and calendar actions.
The Sites implementation follows the retained Python application's current
behavior, including a curated campus-place dataset, participation warnings,
ended events on the selected date, and atomic publication across multiple days.
Saved events and the selected walking origin are stored on the device.

The existing GitHub Actions workflow refreshes today and tomorrow every two hours
at minute 17, and seven days every six hours at minute 47. It reads every published
day back to verify durable publication. GitHub supplies the timer; discovery,
ranking, persistence, and serving run on Sites. The workflow uses
`VFR_SITES_SERVICE_TOKEN` from repository secrets and rejects redirects. Future
service-token rotation must also update that repository secret.

The complete Sites source is included as ordinary files under [`sites/`](sites/)
and is also maintained in the Site's own source repository. See
[Sites source and publication](docs/sites-source-and-publication.md) for the
release sequence and source correspondence. Its offline tests include real SQL
transaction rollback checks and fixtures generated from the Python implementation.
Calendar actions provide a Google Calendar prefill link and an `.ics` download.

The following documentation describes the retained Python/Vercel version.

## Legacy Python/Vercel application

Vandy Food Radar discovers Vanderbilt events advertising free food, normalizes
and deduplicates them, verifies their provenance, ranks them, and renders a
dense campus workspace: cards for one day, a weekly schedule, a map, and a
walking itinerary.

The pipeline is **Discover → Normalize → Deduplicate → Verify → Rank →
Display**. The original spec is under
[`.kiro/specs/vandy-food-radar/`](.kiro/specs/vandy-food-radar/).

Two explicit modes:

- **Offline demo (default locally):** reads only the fixture corpus under
  `tests/fixtures/`. It never makes source-network calls.
- **Live production:** queries Vanderbilt AnchorLink's public discovery API and
  publishes a complete durable feed to Upstash Redis. It never falls back to
  fixtures or placeholder event links.

## Requirements and setup

- Python 3.11+
- [`uv`](https://docs.astral.sh/uv/)

```sh
make install
make demo     # seeds fixtures, serves http://127.0.0.1:5000/
```

| Command | Purpose |
| --- | --- |
| `make seed` | Retarget and load the fixture corpus into SQLite. |
| `make run` | Run the configured source pipeline. |
| `make demo` | Seed fixtures and serve the Flask UI. |
| `make web` | Serve the UI using local SQLite. |
| `make serve-vercel` | Serve `api/index.py` locally. |
| `make check` | Lint, format check, type check, tests. |

Direct CLI use:

```sh
uv run python -m vandy_food_radar --db store.db seed
uv run python -m vandy_food_radar --db store.db run
```

The offline demo is labelled as a demo in the interface. Fixture dates are
retargeted onto the target day so the demo stays populated, and **Refresh
demo** reruns fixture ingestion. `/seed` and the browser refresh button exist
only offline.

## The interface

### One selected local date

The page opens on **today** in `America/Chicago` and shows exactly that date.
`?date=YYYY-MM-DD` selects another day; a malformed value falls back to today
rather than drifting to a neighbouring date. The server never widens the
filter, the client state holds the feed for one date only, and the JSON API is
scoped the same way:

| Route | Returns |
| --- | --- |
| `GET /` | Server-rendered workspace for the selected date. |
| `GET /api/day?date=` | The ranked feed and daily brief for one date. |
| `GET /api/week?start=` | Seven consecutive days, each bucketed under its own date. |
| `GET /api/meta` | Server capabilities and last-success metadata (no secrets). |
| `POST /api/walking` | A walking answer across validated waypoints. |
| `GET /calendar/ics/<identity_key>?date=` | ICS download, scoped to that date. |

Desktop uses a slim sidebar with **Cards / Schedule / Itinerary**; the map
shares the schedule's selection. Cards are two columns on desktop and one
column below the 800px breakpoint, where a bottom bar replaces the sidebar and
targets are at least 44px. Only local interactions animate, and `prefers-
reduced-motion` is respected.

### Cards

Each card carries recommendation stars (0–5, a fixed linear mapping of the
ranked score so the same score always shows the same stars), the time range,
the food chip, the resolved full building name, the location exactly as the
source listed it, RSVP state, organizer, an inferred participation note, and
source/detail actions.

Only warnings a reader must act on are shown: cancellation, a material
cross-source conflict (date, time, location, food, RSVP), and a time or venue
change detected during refresh, retained for 24 hours across subsequent reads
and refreshes. The routine "partially verified" state — what
a single-source listing simply looks like — is not displayed as a badge, and a
first page load is not badged "New" for every listing. Inferred assessments are
labelled separately from source evidence. Ended events remain visible for the
selected date, including after an evening refresh.

### Daily brief

A short brief sits above the cards. It is assembled by fixed rules from values
already in the feed — listing count, earliest start, how many describe a full
meal, how many have food confirmed by a source, how many are cancelled or
conflicting, and the top-ranked title. No language model is involved and no AI
credential, subscription, or API key is required. It is cached by a SHA-256
hash of exactly the fields it reads, and an empty day says so instead of
inventing activity.

### Campus places

`public/static/campus-places.json` holds **58** curated campus places as
`{id, name, aliases, lat, lng, source_url}`, each citing its source (the
official Vanderbilt campus map, with a small number of OpenStreetMap
references). It is the only source of coordinates. The server reads it to
resolve listed locations; the browser downloads the same file for the origin
combobox.

Matching is conservative: a listing resolves on an exact normalized name/alias
match, or on a name/alias followed by a token boundary, so room and floor
detail is preserved as `detail` rather than discarded. An unrecognized location
stays unresolved and simply gets no coordinates — no "closest building"
guessing, and a row with a non-numeric or out-of-range coordinate is skipped
rather than trusted.

### Map

The map view is **free-first**: Leaflet and OpenStreetMap tiles, no API key and
no billing account. Leaflet is loaded on demand the first time the map opens,
from a CDN with Subresource Integrity hashes; if that fetch fails the panel
says the map is unavailable and keeps the adjacent list of mapped listings
usable. Markers are drawn only for events whose location matched the curated
dataset, saved events are marked distinctly, and on mobile the schedule and map
share one switch.

### Walking origin

Three ways to set where you walk from:

1. a combobox over the downloaded campus dataset, filtered entirely in the
   browser so no keystroke reaches a third-party geocoder;
2. a map click, for a spot the dataset does not name;
3. the browser's own geolocation, which the user grants explicitly.

Every coordinate from GPS or a map click is range-checked before it is stored
or sent anywhere.

### Calendar handoff (no server credentials)

Two credential-free paths, sharing one time model:

- a **Google Calendar prefill** link, which opens Google's composer with the
  fields filled in — the user confirms, so no OAuth scope is needed;
- an **ICS download** (`GET /calendar/ics/<identity_key>?date=`), importable
  anywhere.

The time model: a known start and end use both; a start with no listed end gets
a 60-minute duration instead of a zero-length entry some clients drop; an end
at or before the start is read as crossing midnight and rolls to the next day;
no listed start becomes an all-day entry with the exclusive `DTEND` an all-day
VEVENT requires. Local times convert through `zoneinfo`, so the correct offset
is used on either side of a DST change. ICS text is escaped per RFC 5545 and
folded at 75 **octets** of UTF-8, so a multi-byte character is never split.
The `UID` is a UUID5 of the event's stable identity key, so re-importing
updates the same entry rather than duplicating it, and a cancelled event is
published with `STATUS:CANCELLED` so an existing copy is updated.

The pre-existing authenticated Google Calendar *write* route is retained
unchanged and fires only on an explicit POST.

### Saved activities and itinerary

Bookmarks, the walking origin, and the itinerary live in the browser under
`vfr.saved.v1`, `vfr.origin.v1`, and `vfr.itinerary.v1`. Local storage is
treated as hostile input: it may be unavailable (private mode, blocked storage,
exhausted quota) and its contents may be stale or hand-edited, so every read is
validated field by field and anything unusable is discarded. A write failure
degrades the feature to in-memory only instead of breaking the page.

The itinerary arranges saved events on a single date. Given a departure time,
a configurable dwell per stop, and walking time between stops, it reports which
stops are reachable while the event is still running — arriving early means
waiting, arriving after the end marks the stop infeasible and says so rather
than dropping it. Cancelled events and events with no resolved building are
excluded. Up to `itinerary.max_exact_stops` stops (7 by default, set in
`config.py` rather than from the environment) every order is evaluated and the
best feasible one kept; above that a greedy earliest-feasible heuristic is used
and labelled a good order, never the optimal one. The limit is reported to the
browser through `/api/meta` as `max_exact_stops`.

### Participation assessment

Participation uses the title, full source description, and organizer. Explicit
access statements take priority. Familiar activity formats (for example, a
drop-in meal or an active workshop) also produce small, labelled inferences;
the matching phrase is retained for review. A terse listing with no evidence
remains unassessed.

Explicit eligibility limits ("members only", "graduate students only") are
surfaced as **warnings**, not as a quiet score penalty: an event genuinely
closed to someone is a caveat to read, not a slightly worse event. Only a small
convenience nudge reaches ranking, capped by `participation_influence` (5% of
the total score).

## Walking routes

`POST /api/walking` answers with one of two clearly labelled modes:

- `routed` — a real pedestrian route from OpenRouteService, used only when
  `VFR_ORS_API_KEY` is configured server-side;
- `estimate` — a straight-line (great-circle) distance at a fixed walking pace.

The estimate is not a silent fallback. It is the documented answer when no key
is configured, when the service does not respond, or when its response is
unusable, and the `detail` field says which of those happened and that a real
route will be at least that long.

Constraints: the key is read only from server configuration and sent as an
`Authorization` header to one hard-coded endpoint — never in a URL, in HTML, or
in a log line. There is no caller-supplied URL, so the route is not a general
proxy. Coordinates must be finite and in range, there are at most
`max_waypoints` of them, and each must be within `max_radius_km` of the
configured reference point; a request that fails validation is rejected with
400 rather than clamped. Results are memoized in a bounded in-process cache.
`/api/meta` reports routing only as an availability boolean.

## Live AnchorLink ingestion

The canonical human filter is [AnchorLink Free Food events](https://anchorlink.vanderbilt.edu/events?perks=FreeFood).
AnchorLink's client-rendered page uses the public
[`/api/discovery/event/search`](https://anchorlink.vanderbilt.edu/api/discovery/event/search)
JSON interface. The verified API contract:

- `benefitNames=FreeFood` applies the Free Food facet. The page parameter
  `perks=FreeFood` is **not** an API filter.
- `startsAfter` and `startsBefore` bound event start timestamps.
- `skip` and `take` paginate; `@odata.count` reports the matching total.
- Search rows carry `id`, `institutionId`, `branchId`, `name`, `description`,
  `location`, `startsOn`, `endsOn`, `benefitNames`, `visibility`, `status`.
- Genuine event pages use `https://anchorlink.vanderbilt.edu/event/<numeric-id>`.

The live adapter fetches every page for each configured target day and also
checks each row defensively. A record is accepted only when it:

- contains the exact `Free Food` benefit;
- is `Approved` and `Public`;
- identifies Vanderbilt institution `24` and branch `56623`;
- has a numeric API-returned ID and valid timezone-aware start/end timestamps;
- starts on the target date in `America/Chicago` and has not ended.

Event and source links are built only from those returned numeric IDs.
Descriptions are untrusted text: HTML is stripped and no embedded content is
executed. Listing HTTP, JSON, pagination, and durable-publication failures
return a non-2xx refresh response while retaining the previous feed. A
successful response with zero matches legitimately publishes an empty day.

Because a provider can publish distinct events that share a title, venue, and
start time, the native AnchorLink id becomes the event's identity when exactly
one is present (`identity_key = source|<id>`, primary key = a UUID5 of it).
Listings with no native id keep the previous date + title-token fingerprint, so
stored fixture events are unaffected.

For a one-off live fetch into **local** SQLite:

```sh
VFR_OFFLINE=false uv run python -m vandy_food_radar --db live.db run
```

This is useful for development, but `live.db` is not suitable for Vercel.

## Multi-day feed, retention, and atomic publication

A protected refresh accepts `days=1`, `days=2`, or `days=7`; any other value
collapses to 1. The batch:

1. ingests, scores, and writes each requested day **locally**;
2. replaces stale rows **on each day individually**, so a day that is not
   refreshed is never erased;
3. applies a bounded rolling retention window
   (`[today - past_days, today + future_days]`, plus every requested day);
4. records last-success metadata and publishes durably **once**, after every
   day has succeeded.

A failure partway through the batch propagates before publication, so the
previously published feed survives intact. Durable publication is also
compare-and-set: an invocation whose loaded revision has since been replaced is
refused rather than allowed to overwrite a newer feed. Refreshes refuse to run
concurrently in a process (HTTP 409).

## Vercel production

`api/index.py` exports the Flask WSGI application. Do not add a catch-all
rewrite to `vercel.json`; Flask must receive the original route. Static assets
remain under `public/static/`.

Vercel detects the Flask entry point and installs the dependencies from the
repository. For the existing `jingyu-ruan/vandy-food-radar` project, keep the
repository root as the project root and leave the detected framework settings
in place. A Vercel Hobby deployment can also reject commits authored by an
identity that lacks access to the connected team; see [Vercel's deployment
collaboration guidance](https://vercel.com/docs/deployments/troubleshoot-project-collaboration).

Production deployments (`VERCEL_ENV=production`) default to live mode when
`VFR_OFFLINE` is unset; set `VFR_OFFLINE=false` explicitly for clarity. Live
mode refuses to boot unless durable storage and refresh authentication are
configured, and it never fixture-seeds `/tmp`.

### Required Vercel environment variables

Configure each row for the Production environment. For Upstash, `Config.from_env`
uses the first non-empty variable in each listed sequence:

| Variable | Required value/purpose |
| --- | --- |
| `VFR_OFFLINE` | `false` |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_KV_REST_API_URL` / `KV_REST_API_URL` | Upstash Redis REST URL, in precedence order. |
| `UPSTASH_REDIS_REST_TOKEN` / `UPSTASH_REDIS_REST_KV_REST_API_TOKEN` / `KV_REST_API_TOKEN` | Upstash Redis REST token, in precedence order. |
| `CRON_SECRET` | Strong random bearer token protecting refresh routes. |

`VFR_REFRESH_TOKEN` may replace/override `CRON_SECRET`, but `CRON_SECRET` is
recommended because Vercel Cron sends it as a bearer token. The same value must
be installed in GitHub as described below.

Upstash serves two persistence roles:

1. `vfr:repository:v1` (plus `vfr:repository:v1:revision`) stores the complete
   SQLite repository snapshot — canonical events, real source URLs and raw
   payloads, provenance, conflicts, ranking components, history, and run
   metadata. Every home-page request reloads it, so separate serverless
   invocations see the latest published feed. The revision key provides the
   compare-and-set guard.
2. `vfr:snapshot:<date>` stores the smaller previous-run change snapshot used
   for New / Time changed / Venue changed / Cancelled classification.

The complete repository is mandatory in live mode. Its reads and writes are
strict: an Upstash outage, a corrupt base64 value, a non-SQLite payload, a
failed integrity check, or an incompatible schema produces a clear 502/503
instead of silently serving demo fixtures.

After setting the variables and deploying, trigger the GitHub workflow once or
call the protected endpoint once to create the initial feed. An empty page
before that first successful refresh is expected.

### Scheduling

The current [GitHub workflow](.github/workflows/hourly-refresh.yml) targets Sites:

| Cadence | Span | Purpose |
| --- | --- | --- |
| every 2 hours (minute 17) | `days=2` | today and tomorrow |
| every 6 hours (minute 47) | `days=7` | the schedule's coming week |

Manual runs can select either span. All triggers share a concurrency group with
`cancel-in-progress: false`. The job uses the existing
`VFR_SITES_SERVICE_TOKEN` repository secret, rejects redirects, retries transient
failures, and verifies each date's persisted feed after publication. GitHub may
delay scheduled runs during periods of high load.

The retained Python/Vercel endpoint accepts GET or POST and requires
`Authorization: Bearer <VFR_REFRESH_TOKEN>` in live mode. Its `/refresh` endpoint
uses the same token. `vercel.json` retains a daily Vercel Cron invocation requiring
`CRON_SECRET`; this is separate from the current Sites workflow.

### Optional providers

- Google Calendar **write**: `GOOGLE_CALENDAR_CREDENTIALS_JSON`,
  `VFR_CALENDAR_ID`, `VFR_CALENDAR_WRITE_ENABLED=true`,
  `VFR_CALENDAR_PROVIDER=google`. Not needed for the prefill link or ICS.
- Google Maps walking time: `GOOGLE_MAPS_API_KEY`, `VFR_MAPS_ENABLED=true`,
  `VFR_LOCATION_PROVIDER=google_maps`.
- OpenRouteService pedestrian routing: `VFR_ORS_API_KEY` (see below).

The live source factory intentionally enables only AnchorLink. The existing
Google Calendar and official-page **source** adapters enumerate fixture
manifests and therefore remain offline-only until genuine live implementations
exist.

## Configuration

Configuration lives in `vandy_food_radar/config.py`. Common overrides:

| Variable | Default | Meaning |
| --- | --- | --- |
| `VFR_OFFLINE` | `true` | `false` selects live mode. |
| `VFR_TIMEZONE` | `America/Chicago` | IANA timezone for every local date. |
| `VFR_TARGET_WINDOW` | `today` | `today` or `next_day`. |
| `VFR_ORS_API_KEY` | _unset_ | **Optional** OpenRouteService key, server-side only. Without it `/api/walking` returns labelled straight-line estimates. |
| `VFR_ORS_TIMEOUT_SECONDS` | `6` | Per-request routing timeout, clamped to 1–30. |
| `VFR_CAMPUS_PLACES_PATH` | repo `public/static/campus-places.json` | Campus place dataset. |
| `VFR_RETENTION_PAST_DAYS` | `0` | Days before today kept by a refresh (0–30). |
| `VFR_RETENTION_FUTURE_DAYS` | `13` | Days after today kept by a refresh (0–60). |
| `VFR_ITINERARY_DWELL_MINUTES` | `30` | Default minutes spent per itinerary stop (0–240). |
| `VFR_REF_LABEL` / `VFR_REF_LAT` / `VFR_REF_LNG` | Kirkland Hall | Default walking origin. |
| `VFR_LOCATION_PROVIDER` | `haversine` | `haversine`, `google_maps`, or `null`. |
| `VFR_CALENDAR_PROVIDER` | `none` | `none` or `google`. |
| `VFR_ANCHORLINK_BASE_URL` | AnchorLink origin | Source origin override. |
| `VFR_ANCHORLINK_PAGE_SIZE` | `100` | 1–100. |
| `VFR_ANCHORLINK_TIMEOUT_SECONDS` | `15` | Per-page timeout. |

Secrets must stay in Vercel/GitHub environment configuration and must never be
committed.

## Security

- All activity text reaches the browser through Jinja autoescaping or
  `textContent`; no source field is ever assigned to `innerHTML`.
- Outbound links are dropped unless they are absolute `http`/`https`, so
  `javascript:` and `data:` URLs from source text cannot become hrefs.
- Coordinates come only from the curated dataset or range-checked user input;
  no location is approximated and no geographic claim is fabricated.
- The ORS key is never rendered into HTML, URLs, or logs, and only one fixed
  upstream endpoint is reachable — there is no generic proxy route.
- Flask's session signing key is derived from the required live secret in
  production rather than shipped as a known constant.

## Validation

Tests are offline-first and inject fixtures and fakes; they require no live
network access.

```sh
make check          # ruff, black --check, mypy --strict, pytest
node tests/js/itinerary.test.mjs  # time windows, dwell, waiting, order search
```
