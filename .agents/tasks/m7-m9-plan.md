# Implementation Plan — Vandy Food Radar M7–M9 + Deployment

Extends the EXISTING project at `/projects/sandbox`. M0–M6 are done, green (93 tests
pass), and pushed. This plan REUSES the existing adapter/interface seams and does NOT
rewrite them. All new config flags default OFF/offline; the app must boot and serve
with NO Google credentials set.

## Symbols reused verbatim (do not redefine)

- `providers/location.py`: `LocationProvider` (Protocol), `WalkingResult`, `WalkingStatus`,
  `walking_factor_value`, `build_location_provider`, `HaversineLocationProvider`,
  `NullLocationProvider`. M9 adds a new impl behind this Protocol and extends `build_location_provider`.
- `providers/calendar.py`: `CalendarProvider` (Protocol), `CalendarWriteResult`,
  `NullCalendarProvider`, `build_calendar_provider`. M8 adds `GoogleCalendarWriter` behind this Protocol.
- `config.py`: `Config`, `ProvidersConfig`, `LocationProviderKind` (has `HAVERSINE`, `NULL`),
  `CalendarProviderKind` (has `NONE`, `GOOGLE`), `Config.from_env` + `_parse_bool/_parse_enum`.
- `pipeline/orchestrator.py`: `run`, `seed_demo`, `RunReport` (fields: target_date, fetched,
  merged, conflicts, cancelled, scored, history_entries, saved_event_ids). Idempotent upsert on
  `identity_key` (see `store/sqlite_repository.save_event` + `find_by_identity_key`).
- `cli.py`: `build_parser`, `main` (subcommands `seed`, `run`; `--db`). `run` already does one
  idempotent pass over `Window.from_config(...)` for the target window and exits.
- `web/app.py`: `create_app(config, *, repository, sources, location_provider, today_provider)`.
- `web/wsgi.py`: `build_app()` + module-level `app` (Flask), reads `VFR_DB`.
- `store/base.py` `Repository` + `SqliteRepository` (`find_by_identity_key`, `save_event`, `get_events_for_day`).

## Toolchain (verify commands)

uv + Makefile. Every module must pass: `uv run ruff check .`, `uv run black --check .`,
`uv run mypy`, `uv run pytest`. Combined: `make check`. Add deps with `uv add` (writes
pyproject + uv.lock). `mypy --strict` is on; add type stubs or `# type: ignore[...]` narrowly
for untyped Google libs.

---

- [ ] 1. (M7 · T7.1) Add automation config flags and a platform-agnostic scheduler wrapper reusing the CLI `run`.
      Add to `config.py` a `SchedulerConfig` dataclass (`enabled: bool = False`, `hour: int = 6`,
      `minute: int = 0`) on `Config` as `scheduler`, with `VFR_SCHEDULER_ENABLED/_HOUR/_MINUTE`
      env overrides in `from_env` (reuse `_parse_bool`, add int parse). Add
      `pipeline/scheduler.py` with `run_daily_once(db_path, config)` that builds sources/provider
      exactly as `cli.py:main` does and calls `pipeline.run` for `Window.from_config` "tomorrow",
      returning the `RunReport`; and `start_scheduler(...)` gated on `config.scheduler.enabled`
      using APScheduler `BackgroundScheduler` (no thread started when disabled — default). The CLI
      `run` subcommand stays the cron/Render-Cron entrypoint unchanged.
      Files: `vandy_food_radar/config.py`, `vandy_food_radar/pipeline/scheduler.py`,
      `vandy_food_radar/pipeline/__init__.py` (export `run_daily_once`, `start_scheduler`), `pyproject.toml`/`uv.lock` (`uv add apscheduler`).
      Verify: `uv run mypy && uv run pytest tests/test_scheduler.py -q` — passes; APScheduler import resolves.

- [ ] 2. (M7 · T7.3) Add a structured JSON run log emitting RunReport counts, and wire it into the `run` path.
      Add `pipeline/runlog.py` with `run_report_to_json(report: RunReport) -> str` (emits
      `target_date`, `fetched`, `merged`, `conflicts`, `cancelled`, `scored`, `history_entries`
      via `json.dumps`, sorted keys) and `log_run_report(report, *, stream=sys.stdout)`. Call it
      from `run_daily_once` (item 1) and optionally from `cli.py:main` after the run.
      Files: `vandy_food_radar/pipeline/runlog.py`, `vandy_food_radar/pipeline/scheduler.py`,
      `vandy_food_radar/cli.py`.
      Verify: `uv run pytest tests/test_runlog.py -q` — asserts JSON has all 7 keys with correct counts.

- [ ] 3. (M7 · T7.2) Add offline idempotency + change-detection tests over the fixture corpus for automation edge cases.
      New `tests/test_scheduler.py` and extend change-detection coverage: assert `run_daily_once`
      twice creates no duplicate events (E-9 late add reuses `identity_key` upsert), a time change
      (E-2) / venue change (E-3) updates in place with one history row, and a cancellation (E-4)
      marks state `cancelled` with a single transition history row. REUSE the `_SingleRecordAdapter`
      pattern and assertions already in `tests/test_pipeline_e2e.py`; do not duplicate the engine.
      Ensure no scheduler thread is left running (assert `start_scheduler` returns None/does nothing when disabled).
      Files: `tests/test_scheduler.py`, `tests/test_runlog.py`.
      Verify: `uv run pytest tests/test_scheduler.py tests/test_runlog.py -q` — all pass; `make check` green.

- [ ] 4. (M8 · T8.1) Implement `GoogleCalendarWriter` behind the existing `CalendarProvider` Protocol; extend provider selection + config.
      In `providers/calendar.py` add `GoogleCalendarWriter` implementing `add_event(event) -> CalendarWriteResult`,
      building the Google event body from the `Event` (summary=title, start/end from event_date+
      start_time/end_time in `config.timezone`, location, description incl. food + source URL) and a
      deterministic `iCalUID`/extended property derived from `event.identity_key` so a repeat add is
      idempotent (no duplicate calendar entries, FR-40). Credentials from env/config placeholders
      (service-account or OAuth token path); NEVER commit creds. Extend `build_calendar_provider`:
      return `GoogleCalendarWriter` only when `providers.calendar is CalendarProviderKind.GOOGLE`
      AND config flags/creds present, else `NullCalendarProvider`. Add `GoogleCalendarWriteConfig`
      (`enabled: bool = False`, `calendar_id: str = ""`, `credentials_json: str = ""`) with env
      overrides; default stays `CalendarProviderKind.NONE`.
      Files: `vandy_food_radar/providers/calendar.py`, `vandy_food_radar/config.py`,
      `pyproject.toml`/`uv.lock` (`uv add google-api-python-client google-auth`).
      Verify: `uv run mypy && uv run pytest tests/test_calendar_provider.py -q` — passes with mocked client.

- [ ] 5. (M8 · T8.2) Add a Flask "Add to Calendar" POST route calling the provider for ONE selected event.
      In `web/app.py` inject a `calendar_provider` (default `build_calendar_provider(config)`), add
      `POST /calendar/add/<event_id>` that loads that one event via the repository, calls
      `calendar_provider.add_event(event)`, and redirects back to index with a flash/state message;
      when the provider is Null/disabled, surface a graceful "Calendar not configured" state (never
      auto-add). Add an "Add to Calendar" button per card in `_event_card.html` (posts the event id)
      shown only for non-cancelled events. Reuse `CalendarWriteResult.ok`/`detail`.
      Files: `vandy_food_radar/web/app.py`, `vandy_food_radar/web/wsgi.py` (pass provider through),
      `vandy_food_radar/web/templates/_event_card.html`, `vandy_food_radar/web/templates/index.html`,
      `vandy_food_radar/web/static/app.css` (button style).
      Verify: `uv run pytest tests/test_web.py -q` — existing pass + new route test.

- [ ] 6. (M8 · T8.3) Integration tests for the calendar write with a MOCKED calendar client.
      New `tests/test_calendar_provider.py`: inject a fake Google client into `GoogleCalendarWriter`;
      assert payload mapping (title/time/location/description), explicit-only single-event write,
      and idempotent repeat add (same `iCalUID` → update not duplicate). Add a web test that the
      "Add to Calendar" route calls the provider once and shows the "not configured" state when the
      Null provider is active.
      Files: `tests/test_calendar_provider.py`, `tests/test_web.py`.
      Verify: `uv run pytest tests/test_calendar_provider.py tests/test_web.py -q` — all pass; `make check` green.

- [ ] 7. (M9 · T9.1/T9.2) Implement a live maps `LocationProvider` with in-process caching and graceful fallback; extend selection + config.
      In `providers/location.py` add `GoogleMapsLocationProvider` implementing `walking(origin, dest)
      -> WalkingResult` via an injected HTTP client (Distance Matrix / Routes walking mode),
      memoized by `(origin, dest)` in an in-process dict cache. On missing key / provider error /
      missing dest → fall back to Haversine, then Null → `WalkingStatus.UNKNOWN` (so
      `walking_factor_value` uses the neutral `walking_unknown_value`, never zero — same as M6).
      Add `LocationProviderKind.GOOGLE_MAPS` and `MapsConfig` (`enabled: bool = False`,
      `api_key: str = ""`) with env overrides; extend `build_location_provider` to return the maps
      provider only when selected AND key present, wrapping a Haversine fallback; default stays `HAVERSINE`.
      Files: `vandy_food_radar/providers/location.py`, `vandy_food_radar/config.py`,
      `pyproject.toml`/`uv.lock` (`uv add requests` if not already present, or reuse existing HttpFetcher).
      Verify: `uv run mypy && uv run pytest tests/test_location_maps.py -q` — passes with mocked HTTP.

- [ ] 8. (M9 · T9.2) Tests for the maps provider with a MOCKED HTTP client.
      New `tests/test_location_maps.py`: success returns OK minutes; second identical call is a cache
      hit (mock called once); HTTP error → Haversine result; missing dest → UNKNOWN → neutral factor
      via `walking_factor_value`. No live network.
      Files: `tests/test_location_maps.py`.
      Verify: `uv run pytest tests/test_location_maps.py -q` — all pass; `make check` green.

- [ ] 9. (Deployment) Add production WSGI serving, deployment artifacts, and docs so the repo deploys in a few clicks.
      `uv add gunicorn`. Add `render.yaml` Blueprint with (1) a Web Service running
      `gunicorn vandy_food_radar.web.wsgi:app --bind 0.0.0.0:$PORT`, a persistent disk mounted for
      `store.db` (via `VFR_DB` pointing at the disk path), and a first-boot seed/migrate step
      (`python -m vandy_food_radar --db $VFR_DB seed`) so the page is not empty; env vars documented
      for optional Google Calendar/Maps creds, all unset → offline/demo mode; and (2) a Cron Job
      running `python -m vandy_food_radar --db $VFR_DB run` daily. Add a `Dockerfile`
      (python:3.11-slim, install project, gunicorn, `CMD` binds `$PORT`). Export `requirements-prod.txt`
      via `uv export --no-dev --no-hashes -o requirements-prod.txt` (and note `uv pip compile`
      alternative). Add Makefile `serve-prod` target running gunicorn on `$PORT`. Add a README
      DEPLOYMENT section: exact Render Blueprint steps (New → Blueprint → connect
      jingyu-ruan/vandy-food-radar → apply render.yaml → open .onrender.com URL), the shorter
      New-Web-Service path, env-var table, and a "Vercel not recommended (WSGI/persistent SQLite)" note.
      Files: `render.yaml`, `Dockerfile`, `requirements-prod.txt`, `Makefile`, `README.md`,
      `pyproject.toml`/`uv.lock`, `.gitignore` (keep `*.db`/`.env` ignored).
      Verify: `uv run gunicorn vandy_food_radar.web.wsgi:app --bind 127.0.0.1:8000 --daemon` then
      `curl -sf localhost:8000/ | grep -q "Vandy Food Radar"` after a seed; `make check` green.

## Assumptions

- Render.com is the primary target (persistent disk for SQLite + Cron Job fit the design's
  single-process SQLite model); Vercel is noted as not recommended because it is serverless and
  lacks persistent disk for the SQLite store.
- Google Calendar auth uses a service account JSON provided via env (simplest for a single-user
  headless server); OAuth user-flow is a documented alternative but not implemented in MVP.
- Maps provider uses Google Distance Matrix walking mode via the existing HttpFetcher-style
  injected client; any HTTP walking-distance API behind the same interface is acceptable.
- `store.db` stays gitignored; production seeds on first boot rather than committing the DB.
