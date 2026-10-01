# Vandy Food Radar

## Current Sites deployment

The live application is now hosted at
[https://vandy-food-radar.rjy020128.chatgpt.site](https://vandy-food-radar.rjy020128.chatgpt.site)
with owner-private access. React/Vinext serves the page and API in one Sites
Worker, and Sites D1 stores feeds, source records, scoring, change history, and
refresh leases. The production application operates on real AnchorLink data.

The existing GitHub Actions workflow calls the Sites refresh endpoint every hour
at minute 17, then reads the listing back to verify durable publication. GitHub
only supplies the timer; discovery, ranking, persistence, and serving run on
Sites. The Sites account's five-task limit prevented creating a native Site task,
so this preserves unattended updates while that account limit is in effect.
The workflow uses `VFR_SITES_SERVICE_TOKEN` from repository secrets and rejects
redirects. The previous Vercel URL and refresh-token secrets remain available for
rollback. Future service-token rotation must also update that repository secret.

The migrated source is a separate Sites-managed checkout under `sites/` in the
local workspace and lives in the Site's own source repository. It has 87 offline
tests; the first hosted publication matched all 63 numeric ranking factors and
the order of 9 real events from the Python implementation. Calendar actions
export an `.ics` file for explicit import. Frontend redesign is deferred.

The following documentation describes the retained Python/Vercel version.

## Legacy Python/Vercel application

Vandy Food Radar discovers Vanderbilt events advertising free food, normalizes
and deduplicates them, verifies their provenance, ranks them, and renders dense
event cards.

The application has two explicit modes:

- **Offline demo (default locally):** reads only the fixture corpus under
  `tests/fixtures/`. It never makes source-network calls.
- **Live production:** queries Vanderbilt AnchorLink's public discovery API and
  publishes a complete durable feed to Upstash Redis. It never falls back to
  fixtures or placeholder event links.

The pipeline remains **Discover → Normalize → Deduplicate → Verify → Rank →
Display**. The original spec is under [`.kiro/specs/vandy-food-radar/`](.kiro/specs/vandy-food-radar/).

## Requirements and setup

- Python 3.11+
- [`uv`](https://docs.astral.sh/uv/)

```sh
make install
```

## Offline demo

```sh
make demo
```

Open `http://127.0.0.1:5000/`. The fixture dates are retargeted to tomorrow so
the demo stays populated. The page reads local SQLite (`store.db`), and
**Refresh demo** reruns fixture ingestion.

Useful commands:

| Command | Purpose |
| --- | --- |
| `make seed` | Retarget and load the fixture corpus into SQLite. |
| `make run` | Run the configured source pipeline. |
| `make demo` | Seed fixtures and serve the Flask UI. |
| `make web` | Serve the UI using local SQLite. |
| `make serve-vercel` | Serve `api/index.py` locally. |
| `make lint` / `make typecheck` / `make test` | Project validation commands. |

Direct CLI use:

```sh
uv run python -m vandy_food_radar --db store.db seed
uv run python -m vandy_food_radar --db store.db run
```

## Live AnchorLink ingestion

The canonical human filter is [AnchorLink Free Food events](https://anchorlink.vanderbilt.edu/events?perks=FreeFood).
AnchorLink's client-rendered page uses the public
[`/api/discovery/event/search`](https://anchorlink.vanderbilt.edu/api/discovery/event/search)
JSON interface. The verified API contract is:

- `benefitNames=FreeFood` applies the Free Food facet. The page parameter
  `perks=FreeFood` is **not** an API filter.
- `startsAfter` and `startsBefore` bound event start timestamps.
- `skip` and `take` paginate; `@odata.count` reports the matching total.
- Search rows contain `id`, `institutionId`, `branchId`, `name`, `description`,
  `location`, `startsOn`, `endsOn`, `benefitNames`, `visibility`, and `status`.
- Genuine event pages use `https://anchorlink.vanderbilt.edu/event/<numeric-id>`.

The live adapter fetches every page for the configured target day and also
checks each row defensively. A record is accepted only when it:

- contains the exact `Free Food` benefit;
- is `Approved` and `Public`;
- identifies Vanderbilt institution `24` and branch `56623`;
- has a numeric API-returned ID and valid timezone-aware start/end timestamps;
- starts on the target date in `America/Chicago` and has not ended.

Event and source links are constructed only from those returned numeric IDs.
Descriptions are treated as untrusted text: HTML is stripped and no embedded
content is executed. Listing HTTP, JSON, pagination, and durable-publication
failures return a non-2xx refresh response while retaining the previous feed.
A successful API response containing zero matches legitimately publishes an
empty target day.

For a one-off live fetch into **local** SQLite:

```sh
VFR_OFFLINE=false \
uv run python -m vandy_food_radar --db live.db run
```

This is useful for development, but `live.db` is not suitable for Vercel.

## Vercel production

`api/index.py` exports the Flask WSGI application. Do not add a catch-all
rewrite to `vercel.json`; Flask must receive the original route. Static assets
remain under `public/static/`.

Vercel detects the Flask entry point and installs the dependencies from the
repository. For the existing `jingyu-ruan/vandy-food-radar` project, keep the
repository root as the project root and leave the detected framework settings
in place. Configure the required production environment variables below before
redeploying. A Vercel Hobby deployment can also reject commits authored by an
identity that lacks access to the connected team; see [Vercel's deployment
collaboration guidance](https://vercel.com/docs/deployments/troubleshoot-project-collaboration).

Production Vercel deployments (`VERCEL_ENV=production`) default to live mode
when `VFR_OFFLINE` is unset. Set `VFR_OFFLINE=false` explicitly for clarity.
Live mode refuses to boot unless durable storage and refresh authentication are
configured, and it never fixture-seeds `/tmp`.

### Required Vercel environment variables

Configure each row in the Vercel project for the Production environment. For
Upstash, `Config.from_env` uses the first non-empty variable in each listed
URL/token sequence:

| Variable | Required value/purpose |
| --- | --- |
| `VFR_OFFLINE` | `false` |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_KV_REST_API_URL` / `KV_REST_API_URL` | Upstash Redis REST URL, in precedence order. |
| `UPSTASH_REDIS_REST_TOKEN` / `UPSTASH_REDIS_REST_KV_REST_API_TOKEN` / `KV_REST_API_TOKEN` | Upstash Redis REST token, in precedence order. |
| `CRON_SECRET` | Strong random bearer token protecting refresh routes. |

`VFR_REFRESH_TOKEN` may replace/override `CRON_SECRET`, but using
`CRON_SECRET` is recommended because Vercel Cron sends it as a bearer token.
The same token value must be installed in GitHub as described below.

Upstash serves two distinct persistence roles:

1. `vfr:repository:v1` stores the complete SQLite repository snapshot,
   including canonical events, real source URLs/raw payloads, provenance,
   conflicts, ranking components, and history. Every home-page request reloads
   it, so separate serverless invocations see the latest published feed.
2. `vfr:snapshot:<date>` stores the smaller previous-run change snapshot used
   for New / Time changed / Venue changed / Cancelled classification.

The complete repository is mandatory in live mode. Its reads/writes are strict;
an Upstash outage produces a clear 502/503 instead of silently serving demo
fixtures. A refresh builds locally and publishes only after the entire source
and pipeline run succeeds. Only the configured target day is retained, keeping
the Redis value bounded.

After setting environment variables and deploying, trigger the GitHub workflow
manually once or call the protected endpoint once to create the initial feed.
An empty page before that first successful refresh is expected.

### True hourly scheduling on Vercel Hobby

Vercel Hobby cron is limited to daily execution, so the repository includes
[`.github/workflows/hourly-refresh.yml`](.github/workflows/hourly-refresh.yml).
GitHub Actions invokes the protected endpoint hourly at minute 17 and retries
transient failures. GitHub scheduled workflows run from the latest commit on
the default branch, and GitHub may delay scheduled runs during periods of high
load. Configure these **GitHub Actions repository secrets**:

| GitHub secret | Value |
| --- | --- |
| `VFR_REFRESH_URL` | Full production URL, e.g. `https://your-app.vercel.app/cron/refresh` |
| `VFR_REFRESH_TOKEN` | Exactly the same value as Vercel `CRON_SECRET` (or its `VFR_REFRESH_TOKEN`). |

The endpoint accepts GET or POST for scheduler compatibility but requires
`Authorization: Bearer <token>` in live mode. `/refresh` is protected by the
same token; the browser refresh button and `/seed` are disabled in production.
No writable unauthenticated refresh path is exposed.

`vercel.json` retains one daily Vercel Cron invocation as a safety net. It is
not the hourly scheduler and also requires `CRON_SECRET`. The GitHub workflow
is the path that supplies actual hourly refreshes on Hobby.

### Optional providers

- Google Calendar write: `GOOGLE_CALENDAR_CREDENTIALS_JSON`,
  `VFR_CALENDAR_ID`, `VFR_CALENDAR_WRITE_ENABLED=true`, and
  `VFR_CALENDAR_PROVIDER=google`.
- Google Maps walking time: `GOOGLE_MAPS_API_KEY`, `VFR_MAPS_ENABLED=true`, and
  `VFR_LOCATION_PROVIDER=google_maps`.

The live source factory intentionally enables only AnchorLink. Existing Google
Calendar and official-page **source** adapters enumerate fixture manifests and
therefore remain offline-only until genuine live implementations exist.

## Configuration

Configuration is in `vandy_food_radar/config.py`. Common overrides:

- `VFR_OFFLINE`: `true` (offline default) or `false` (live).
- `VFR_TIMEZONE`: IANA timezone; default `America/Chicago`.
- `VFR_TARGET_WINDOW`: `next_day` (default) or `today`.
- `VFR_ANCHORLINK_BASE_URL`: defaults to the Vanderbilt AnchorLink origin.
- `VFR_ANCHORLINK_PAGE_SIZE`: 1–100; default 100.
- `VFR_ANCHORLINK_TIMEOUT_SECONDS`: per-page timeout; default 15.
- `VFR_REF_LABEL`, `VFR_REF_LAT`, `VFR_REF_LNG`: walking origin.
- `VFR_LOCATION_PROVIDER`: `haversine`, `google_maps`, or `null`.
- `VFR_CALENDAR_PROVIDER`: `none` or `google`.

Secrets must remain in Vercel/GitHub environment configuration and must never
be committed.

## Validation

Tests are offline-first and inject fixtures/fakes; they do not require live
network access.

```sh
make check
```
