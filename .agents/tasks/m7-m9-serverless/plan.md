# Implementation Plan — Vandy Food Radar M7–M9 + Serverless (Vercel + Upstash snapshot)

Extends the EXISTING project at `/projects/sandbox` (M0–M6 done, 93 tests green,
pushed to `jingyu-ruan/vandy-food-radar`, branch **`master`**). REUSES the
existing adapter/interface seams; does NOT rewrite core logic. All new config
flags default OFF/offline. The app MUST boot and render on Vercel with NO env
vars set (offline demo mode).

## SUPERSEDED ASSUMPTION (record this)

The design's §8 and the earlier `.agents/tasks/m7-m9-plan.md` assumed a
**single-process SQLite persistence** model on Render (persistent disk +
APScheduler/gunicorn). **That assumption is SUPERSEDED.** The user chose a
**stateless serverless** design: because every run re-fetches Anchor Link /
Google Calendar, no persistent primary DB is needed. The ONLY durable state is
a **"last snapshot"** of the previous run's canonical events, held in a free
hosted KV (Upstash Redis) and used solely for cross-run change detection
(new / time-changed / venue-changed / cancelled). `SqliteRepository` REMAINS in
the tree for local/dev and keeps its tests green, but the serverless request
path and cross-session change-detection go through the new `SnapshotStore`.
Do NOT introduce Render, a persistent disk, APScheduler, or gunicorn; Vercel
Cron replaces the in-process scheduler.

## Symbols reused verbatim (do not redefine)

- `config.py`: `Config`, `ProvidersConfig`, `SourcesConfig`,
  `LocationProviderKind{HAVERSINE,NULL}`, `CalendarProviderKind{NONE,GOOGLE}`,
  `Config.from_env`, `_parse_bool/_parse_enum/_parse_float`.
- `providers/location.py`: `LocationProvider` (Protocol), `WalkingResult`,
  `WalkingStatus`, `walking_factor_value`, `build_location_provider`,
  `HaversineLocationProvider`, `NullLocationProvider`.
- `providers/calendar.py`: `CalendarProvider` (Protocol),
  `CalendarWriteResult{ok,event_ref,detail}`, `NullCalendarProvider`,
  `build_calendar_provider`.
- `pipeline/orchestrator.py`: `run(window,*,repository,sources,location_provider,config)->RunReport`,
  `seed_demo`, `RunReport{target_date,fetched,merged,conflicts,cancelled,scored,history_entries,saved_event_ids}`,
  `_TRACKED_FIELDS`. Idempotent upsert keyed on `Event.identity_key`; history via `_diff_history`.
- `dedup/deduplicator.py`: `compute_identity_key(event_date, title)`.
- `store/base.py` + `store/sqlite_repository.py`: `Repository` Protocol,
  `SqliteRepository` (`find_by_identity_key`, `save_event`, `get_events_for_day`,
  `get_source_records`, `get_history`).
- `web/app.py`: `create_app(config,*,repository,sources=None,location_provider=None,today_provider=None)`.
- `web/wsgi.py`: `build_app()` + module-level `app` (Flask), reads `VFR_DB`.
- `sources/factory.py`: `build_sources`, `default_fetcher`, `FixtureSourceAdapter`.
- `cli.py`: `build_parser`, `main` (subcommands `seed`, `run`, `--db`).
- `models.py`: `Event`, `GeoPoint`, `VerificationState`, `FoodConfirmed`, `SourceId`.

## Toolchain (verification commands)

uv + Makefile. Full gate: `make check` = `uv run ruff check .` +
`uv run black --check .` + `uv run mypy` (strict) + `uv run pytest`. Add deps
with `uv add <pkg>` (updates `pyproject.toml` + `uv.lock`; note `uv.lock` is
gitignored). `mypy --strict` is on: untyped Google libs need a narrow
`# type: ignore[import-untyped]`. Every default code path and ALL tests run
fully offline — no live network, no real credentials. External integrations
(Upstash, Google Calendar, Google Maps) are each behind an interface, disabled
by an offline fake by default, and tested with mocks/fakes. Baseline: 93 tests.

---

- [ ] 1. (SnapshotStore) Add the `SnapshotStore` seam with an in-memory default and a JSON codec for canonical events.
      Create `vandy_food_radar/store/snapshot.py` defining a `SnapshotStore`
      Protocol (`save_snapshot(target_date: date, events: list[Event]) -> None`,
      `load_snapshot(target_date: date) -> list[Event] | None`), an
      `InMemorySnapshotStore` (dict keyed by ISO date), and pure codec helpers
      `events_to_json(events) -> str` / `events_from_json(text) -> list[Event]`
      that serialize only the fields change-detection needs (`identity_key`,
      `title`, `event_date`, `start_time`, `end_time`, `location`,
      `verification_state`, `score_total`), mirroring the ISO/`.value` coercions
      in `orchestrator._tracked_value` and `sqlite_repository._event_params`.
      Add `build_snapshot_store(config)` returning `InMemorySnapshotStore` by
      default. Export from `store/__init__.py`.
      Files: `vandy_food_radar/store/snapshot.py`, `vandy_food_radar/store/__init__.py`.
      Verify: `uv run mypy && uv run pytest tests/test_snapshot_store.py -q` — new unit tests pass (round-trip codec + in-memory save/load by date).

- [ ] 2. (SnapshotStore) Add `UpstashSnapshotStore` using the Upstash Redis REST API over stdlib HTTPS, with offline fallback.
      In `store/snapshot.py` add `UpstashSnapshotStore(rest_url, rest_token, *, http=None)`
      implementing the Protocol via the Upstash REST endpoint (`POST {rest_url}`
      with `Authorization: Bearer {token}`, body `["SET", key, json]` /
      `["GET", key]`; key = `vfr:snapshot:{date}`) using an injected HTTP client
      (default a tiny `urllib.request`-based client so no new dependency is
      added). Any HTTP/JSON error is swallowed and treated as "no snapshot"
      (`load` returns `None`, `save` is best-effort) so a KV outage never breaks
      a run. Extend `build_snapshot_store(config)` to return `UpstashSnapshotStore`
      only when `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are set
      (read via a new `SnapshotConfig` on `Config`, defaulting empty), else
      `InMemorySnapshotStore`.
      Files: `vandy_food_radar/store/snapshot.py`, `vandy_food_radar/config.py`
      (add `SnapshotConfig{upstash_rest_url:str="",upstash_rest_token:str=""}`
      + `Config.from_env` reads of the two env vars).
      Verify: `uv run mypy && uv run pytest tests/test_snapshot_store.py -q` — Upstash store passes with a MOCKED http client (SET/GET payload shape, error→None fallback); `build_snapshot_store` returns in-memory when env unset.

- [ ] 3. (Change detection) Add a pure change-detection function that diffs fresh ranked events against the loaded snapshot.
      Create `vandy_food_radar/pipeline/change_detect.py` with an enum
      `ChangeKind{NEW,TIME_CHANGED,VENUE_CHANGED,CANCELLED,UNCHANGED}`, a
      `ChangeFlag` dataclass (`identity_key`, `kind`), and
      `detect_changes(fresh: list[Event], previous: list[Event] | None) -> dict[str, ChangeKind]`
      keyed by `identity_key`: absent-in-previous → `NEW` (E-9); current state
      `CANCELLED` and previously not → `CANCELLED` (E-4); `start_time`/`end_time`
      differ → `TIME_CHANGED` (E-2); `location` differs → `VENUE_CHANGED` (E-3);
      else `UNCHANGED`. Precedence: cancelled > time > venue > new > unchanged.
      Deterministic; reuses `identity_key` + the same tracked fields as
      `_diff_history`. Also add `ChangeCounts` (counts per kind) and a helper to
      tally the dict.
      Files: `vandy_food_radar/pipeline/change_detect.py`, `vandy_food_radar/pipeline/__init__.py` (export).
      Verify: `uv run pytest tests/test_change_detect.py -q` — fixtures for each edge case classify correctly; empty/None previous → all NEW.

- [ ] 4. (Change detection) Add a snapshot-backed run wrapper that computes changes and re-saves the snapshot.
      Create `vandy_food_radar/pipeline/snapshot_run.py` with
      `run_with_snapshot(window,*,repository,sources,location_provider,config,snapshot_store) -> tuple[RunReport, dict[str, ChangeKind]]`:
      call existing `run(...)`, read the freshly saved events via
      `repository.get_events_for_day(window.target_date)`, `load_snapshot` the
      previous, `detect_changes`, then `save_snapshot` the fresh events, and
      return `(report, changes)`. Pure orchestration over existing seams; adds
      no new persistence to SQLite.
      Files: `vandy_food_radar/pipeline/snapshot_run.py`, `vandy_food_radar/pipeline/__init__.py` (export).
      Verify: `uv run pytest tests/test_snapshot_run.py -q` — over the fixture corpus, first run → all NEW; unchanged re-run → all UNCHANGED; a `_SingleRecordAdapter`-style time change → TIME_CHANGED; snapshot is repopulated each run.

- [ ] 5. (M7 · T7.3) Add a structured JSON run log emitting RunReport + change counts.
      Create `vandy_food_radar/pipeline/runlog.py` with
      `run_report_to_json(report: RunReport, changes: dict[str, ChangeKind] | None = None) -> str`
      emitting `target_date` (ISO), `fetched`, `merged`, `conflicts`,
      `cancelled`, `scored`, `history_entries`, and a `changes` object with the
      per-kind counts, via `json.dumps(..., sort_keys=True)`; and
      `log_run_report(report, changes=None, *, stream: TextIO = sys.stdout)`.
      Wire it into `cli.py:main` after the existing human-readable print (keep
      both). Export from `pipeline/__init__.py`.
      Files: `vandy_food_radar/pipeline/runlog.py`, `vandy_food_radar/pipeline/__init__.py`, `vandy_food_radar/cli.py`.
      Verify: `uv run pytest tests/test_runlog.py -q` — JSON has all count keys + a `changes` object with correct tallies.

- [ ] 6. (M7 · T7.1/T7.2) Add the Vercel-Cron `/cron/refresh` route returning RunReport+changes JSON; no in-process scheduler.
      In `web/app.py` inject a `snapshot_store` (default `build_snapshot_store(config)`)
      and add `GET/POST /cron/refresh` that derives tomorrow's `Window`, calls
      `run_with_snapshot(...)`, and returns `run_report_to_json(report, changes)`
      as `application/json`. Attach the resulting per-event `ChangeKind` to the
      index view-model so cards can show a "new / time changed / venue changed /
      cancelled" badge (read the snapshot in `index` to compute display flags;
      offline demo with no Upstash still works via in-memory store — flags are
      all UNCHANGED after the first in-process refresh, NEW before). Keep CLI
      `python -m vandy_food_radar run` as the equivalent entrypoint. Do NOT add
      APScheduler or any thread.
      Files: `vandy_food_radar/web/app.py`, `vandy_food_radar/web/wsgi.py`
      (build + pass `snapshot_store`), `vandy_food_radar/web/templates/_event_card.html`
      (change badge), `vandy_food_radar/web/static/app.css` (badge style).
      Verify: `uv run pytest tests/test_web.py tests/test_cron_route.py -q` — `/cron/refresh` returns 200 JSON with count keys; existing web tests still pass.

- [ ] 7. (M8 · T8.1) Implement `GoogleCalendarWriter` behind `CalendarProvider`; extend selection + config.
      Run `uv add google-api-python-client google-auth`. In
      `providers/calendar.py` add `GoogleCalendarWriter(add_event(event) -> CalendarWriteResult)`
      building the Google event body from the `Event` (summary=title;
      start/end from `event_date`+`start_time`/`end_time` in `config.timezone`
      via `zoneinfo`; location; description with food + source URL) and a
      DETERMINISTIC `iCalUID` derived from `event.identity_key` so a repeat add
      updates rather than duplicates (FR-40). The Google client is injected
      (constructor param, default built lazily from service-account JSON in
      config) so tests mock it; the module never imports the Google libs at
      import time (lazy import inside the builder) to keep offline import clean.
      Add `CalendarWriteConfig{enabled:bool=False, calendar_id:str="", credentials_json:str=""}`
      to `Config` with `VFR_`-prefixed + `GOOGLE_*` env reads; default provider
      stays `CalendarProviderKind.NONE`. Extend `build_calendar_provider` to
      return `GoogleCalendarWriter` only when kind is `GOOGLE` AND creds present,
      else `NullCalendarProvider`.
      Files: `vandy_food_radar/providers/calendar.py`, `vandy_food_radar/config.py`,
      `vandy_food_radar/providers/__init__.py`, `pyproject.toml`/`uv.lock`.
      Verify: `uv run mypy && uv run pytest tests/test_calendar_provider.py -q` — passes with a MOCKED client (payload mapping, deterministic iCalUID, idempotent repeat add updates not duplicates).

- [ ] 8. (M8 · T8.2/T8.3) Add the "Add to Calendar" POST route (explicit, one event) with graceful not-configured state + tests.
      In `web/app.py` inject a `calendar_provider` (default
      `build_calendar_provider(config)`); add `POST /calendar/add/<identity_key>`
      that loads the one event (via `get_events_for_day` filtered by
      `identity_key`), calls `calendar_provider.add_event(event)`, and redirects
      to index with a flash message; when the provider is Null/disabled surface
      "Calendar not configured" (never auto-add). Add an "Add to Calendar" button
      per non-cancelled card in `_event_card.html` posting the `identity_key`.
      Files: `vandy_food_radar/web/app.py`, `vandy_food_radar/web/wsgi.py`,
      `vandy_food_radar/web/templates/_event_card.html`, `vandy_food_radar/web/templates/index.html`,
      `vandy_food_radar/web/static/app.css`, `tests/test_calendar_provider.py`, `tests/test_web.py`.
      Verify: `uv run pytest tests/test_web.py tests/test_calendar_provider.py -q` — route calls provider once; Null provider shows "not configured"; idempotent repeat add asserted with the mock.

- [ ] 9. (M9 · T9.1/T9.2) Implement `GoogleMapsLocationProvider` with memoization + graceful fallback; extend selection + config.
      In `providers/location.py` add `GoogleMapsLocationProvider(api_key, *, http=None, fallback=None)`
      implementing `walking(origin, dest) -> WalkingResult` via an injected HTTP
      client (Distance Matrix walking mode; default a stdlib `urllib.request`
      client — no new dep), memoized in an in-process dict keyed by
      `(round(origin), round(dest))`. On missing key / provider error /
      missing dest → fall back to the injected `HaversineLocationProvider`, then
      to `WalkingStatus.UNKNOWN` so `walking_factor_value` uses the neutral
      `walking_unknown_value` (never zero, FR-30/AC-8). Add
      `LocationProviderKind.GOOGLE_MAPS` and `MapsConfig{enabled:bool=False, api_key:str=""}`
      with `VFR_`/`GOOGLE_MAPS_API_KEY` env reads; default stays `HAVERSINE`.
      Extend `build_location_provider` to return the maps provider (wrapping a
      Haversine fallback) only when selected AND key present.
      Files: `vandy_food_radar/providers/location.py`, `vandy_food_radar/config.py`,
      `vandy_food_radar/providers/__init__.py`.
      Verify: `uv run mypy && uv run pytest tests/test_location_maps.py -q` — MOCKED HTTP: success→OK minutes; identical 2nd call is a cache hit (mock called once); HTTP error→Haversine; missing dest→UNKNOWN→neutral factor.

- [ ] 10. (Serverless packaging) Add the Vercel Python entrypoint, `vercel.json`, and pinned `requirements.txt`.
      Create `api/index.py` importing and exposing the existing Flask WSGI `app`
      (`from vandy_food_radar.web.wsgi import app`) as the module-level `app`
      the Vercel Python runtime serves. Create `vercel.json` routing all paths to
      the function, a `crons` entry hitting `/cron/refresh` once daily, and
      Python 3.11 runtime pin. Generate `requirements.txt` via
      `uv export --no-dev --no-hashes -o requirements.txt` (flask,
      google-api-python-client, google-auth, and stdlib HTTP — no `requests`),
      and COMMIT it (Vercel Python uses pip; `uv.lock` is gitignored). Ensure the
      app boots with NO env vars: `wsgi.build_app()` must seed in-memory demo
      fixtures when the store is empty so the page is never blank offline (add a
      first-request seed in `build_app` guarded to the in-memory/demo path).
      Files: `api/index.py`, `vercel.json`, `requirements.txt`,
      `vandy_food_radar/web/wsgi.py`, `.gitignore` (keep `store.db`/`.env` ignored).
      Verify: `uv run python -c "import api.index as m; c=m.app.test_client(); r=c.get('/'); print(r.status_code); assert b'Vandy Food Radar' in r.data"` — prints 200 and the page renders with seeded events offline (no env vars).

- [ ] 11. (Deployment docs + Makefile) Add the README DEPLOYMENT section and a Vercel-style serve target.
      Add a Makefile `serve-vercel` target that runs the WSGI `app` the Vercel
      way locally (`uv run flask --app api.index run` or `python -m` equivalent);
      keep `make demo` working offline. Add a README DEPLOYMENT section:
      click-by-click Vercel steps (import GitHub repo
      `jingyu-ruan/vandy-food-radar` → Vercel detects the Python function →
      deploy → open the `.vercel.app` URL, which works immediately in offline
      demo mode), an OPTIONAL section for creating a free Upstash Redis DB and
      setting `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` in Vercel env
      to enable cross-session change-tracking, OPTIONAL Google Calendar/Maps env
      vars, and a note documenting the daily Vercel Cron on `/cron/refresh`.
      State the user performs the final click-to-deploy (do NOT authenticate to
      Vercel). Record in the README/plan that the SQLite-persistence assumption
      is superseded by the stateless-serverless + Upstash-snapshot architecture.
      Files: `Makefile`, `README.md`.
      Verify: `make check` green; README DEPLOYMENT section present with the
      Vercel + Upstash steps; `make serve-vercel` starts the app locally and
      `GET /` returns the seeded page.

## Assumptions

- Vercel Python runtime serves a module-level WSGI `app` exported from
  `api/index.py`; the daily Vercel Cron replaces any in-process scheduler
  (no APScheduler, no gunicorn).
- Upstash Redis REST API is reached over stdlib `urllib.request` (no `requests`
  dependency added); Google Maps Distance Matrix likewise. Only Google Calendar
  pulls in `google-api-python-client` + `google-auth` per task scope.
- Snapshot serialization stores only the change-detection-relevant fields as
  JSON, keyed by target date; a KV outage degrades to "no snapshot" (all NEW),
  never an error.
- `SqliteRepository` stays for local/dev and keeps its tests green; the
  serverless path and cross-session change-detection use `SnapshotStore`.
- Branch is `master`; commit locally, never push. `uv.lock` is gitignored, so
  `requirements.txt` is the committed dependency manifest for Vercel/pip.
