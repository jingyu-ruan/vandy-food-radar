# Vandy Food Radar — M1–M6 Implementation Plan

End-to-end goal: a running, **offline** web app that shows a ranked list of
next-day free-food events, driven entirely by the existing fixture corpus
(`tests/fixtures/*.json` + one unparseable HTML). No live network, no API keys,
deterministic.

This plan reuses and extends the approved M0 code — it does **not** rewrite it:

- `vandy_food_radar/config.py` already provides weights (§6.1), dedup
  thresholds, authority precedence, reference location, provider kinds,
  timezone, target window, offline flag. **Reuse as-is.**
- `vandy_food_radar/models.py` already defines every entity + enum
  (`Event`, `SourceRecord`, `FieldProvenance`, `Conflict`, `ScoreComponent`,
  `EventHistory`, and the `*State`/`*Id`/`*Factor` enums). **Reuse as-is.**
- `vandy_food_radar/fixtures.py` already loads the corpus offline. **Reuse.**
- Toolchain: `uv` + `make {lint,format-check,typecheck,test,check}`. Every new
  module must pass `ruff`, `black`, `mypy --strict`, and be covered by
  `pytest`. Baseline is green today.

**Layering (design §1.1)** — each new subpackage stays behind an interface;
`web/` reads only through the `Repository`; providers/sources/fetcher are
injected so the pipeline runs offline:

```
sources/  normalize/  dedup/  verify/  ranking/  store/  providers/  pipeline/  web/
```

**Decision — web framework: Flask + Jinja2.** Server-rendered, minimal
dependency surface, trivial `flask run`/`app.run()` for a single-user local
tool; no ASGI server needed. (design §1.2 lists FastAPI+Jinja *or* Flask; Flask
chosen for the smallest footprint.) Added to `pyproject.toml` deps via `uv add`.

**Decision — offline fetcher wiring.** A `FixtureFetcher` implements the
`HttpFetcher` protocol by returning fixture bytes/JSON keyed by URL (built from
`fixtures.load_all_json_fixtures()`); a `FixtureSourceAdapter` (and the three
real adapters running in fixture mode) read the corpus. Because
`config.offline` defaults `True`, the app wires fixture sources by default, so
it runs with no network out of the box.

**Decision — visible-product seeding.** Fixture events are dated `2025-03-11`.
A `seed`/demo command loads the fixture corpus through the full pipeline and
**retargets** the corpus dates onto the app's target day (tomorrow relative to
`now`), persisting to SQLite, so opening the web page **always** shows ranked
events. The target day used by the web view equals the seeded day. Documented
via `make seed` + `make run` (and a combined `make demo`).

**Ranking weight constants (design §6.1, already in `config.RankingConfig`):**
food_confirmed 0.25, full_meal 0.25, food_specificity 0.15, rsvp_likelihood
0.10, timing 0.05, walking 0.10, confidence 0.10 (sum 1.0).

Fixture key names the normalizer consumes (from `parsed_fields`): `title`,
`event_date`, `start_time` (`"HH:MM"`), `end_time`, `location`, `organizer`,
`rsvp_required`, `rsvp_url`, `event_url`, `food_confirmed`, `food_category`,
`food_description`, plus optional `cancelled` (bool). Top-level record keys:
`source_id`, `source_url`, `checked_at`, `source_updated_at`, `parse_status`,
`raw_payload`, `raw_payload_file` (for the HTML), `parse_error`.

---

## Milestone M1 — Persistence (T1.1–T1.3, FR-31/32/33, FR-42, AC-10)

- [ ] 1. Define the `Repository` protocol in `vandy_food_radar/store/base.py`.
      Methods: `save_event(event, source_records, provenance, conflicts,
      score_components) -> None` (upsert by `dedup_key`), `get_events_for_day(day)
      -> list[Event]`, `find_by_dedup_key(key) -> Event | None`,
      `append_history(entry) -> None`, `get_conflicts(event_id) ->
      list[Conflict]`, `get_score_components(event_id) -> list[ScoreComponent]`,
      plus read helpers `get_source_records(event_id)` and
      `get_history(event_id)` the web layer needs. (T1.1, FR-33)
      Files: `vandy_food_radar/store/__init__.py`, `vandy_food_radar/store/base.py`
      Verify: `make typecheck` passes.

- [ ] 2. Implement `SqliteRepository` in `vandy_food_radar/store/sqlite_repository.py`
      using stdlib `sqlite3`. Schema tables for all entities: `events`,
      `source_records` (incl. `raw_payload`, `parsed_fields` JSON, per-source
      `checked_at`, `parse_status`, `source_updated_at`), `field_provenance`,
      `conflicts` (competing values as JSON), `score_components`, `event_history`.
      Upsert keyed on `events.dedup_key` (UNIQUE): on re-run, update the existing
      row and replace its child rows in a transaction — no duplicate events or
      history. Serialize dates/times/enums deterministically; `find_by_dedup_key`
      backs idempotency. (T1.2, FR-31, FR-32, FR-42)
      Files: `vandy_food_radar/store/sqlite_repository.py`
      Verify: `make typecheck` passes.

- [ ] 3. Add `tests/test_store.py`: round-trip (save then read back an Event with
      all children intact), upsert idempotency (save the same `dedup_key` twice →
      exactly one event row, no duplicate score/history rows), history append
      across two saves with a changed field. Use an in-memory or tmp-file SQLite
      DB. (T1.3, AC-10)
      Files: `tests/test_store.py`
      Verify: `uv run pytest tests/test_store.py` — all pass; then `make check` green.

---

## Milestone M2 — Source ingestion / Discover (T2.1–T2.6, FR-1–FR-7)

- [ ] 4. Define ingestion interfaces in `vandy_food_radar/sources/base.py`:
      `HttpFetcher` protocol (`get(url, *, timeout) -> FetchResult` with
      `status`, `body`, `error`) and `SourceAdapter` protocol
      (`fetch(window) -> list[SourceRecord]`). Add a `Window` dataclass (target
      `date`) if not derived from config. (T2.1, FR-4)
      Files: `vandy_food_radar/sources/__init__.py`,
      `vandy_food_radar/sources/base.py`
      Verify: `make typecheck` passes.

- [ ] 5. Implement the offline fetcher + wiring in
      `vandy_food_radar/sources/fixture_fetcher.py`: `FixtureFetcher` maps a URL →
      fixture payload built from `fixtures.load_all_json_fixtures()` /
      `load_text_fixture()`; unknown URL → `FetchResult` with `fetch_error`. This
      is the injected default when `config.offline` is True. (T2.1, FR-7)
      Files: `vandy_food_radar/sources/fixture_fetcher.py`
      Verify: `make typecheck` passes.

- [ ] 6. Implement the three adapters, each producing `SourceRecord`s (raw
      payload + `parsed_fields` view + `checked_at` + `source_updated_at` +
      `parse_status`), reading through the injected fetcher so they run offline:
      `AnchorLinkAdapter` (filters the Free Food perk; consumes `anchor_link`
      fixtures), `GoogleCalendarAdapter` (`google_calendar` fixtures, incl.
      calendar-only event E-14), `OfficialPageFetcher` (`official_page` fixtures,
      used by verify). Add a `FixtureSourceAdapter` that yields every fixture
      record for the corpus, and a factory `build_sources(config, fetcher)` that
      returns the enabled adapters. Soft-failure: a `fetch_error`/`parse_error`
      fixture becomes a `SourceRecord` with that `parse_status` and empty
      `parsed_fields`; adapters never raise out. (T2.2–T2.5, FR-1/2/3/5/7, E-11)
      Files: `vandy_food_radar/sources/anchor_link.py`,
      `vandy_food_radar/sources/google_calendar.py`,
      `vandy_food_radar/sources/official_page.py`,
      `vandy_food_radar/sources/factory.py`
      Verify: `make typecheck` passes.

- [ ] 7. Add `tests/test_sources.py`: each adapter returns the expected records
      from fixtures with correct `source_id`/`parse_status`; the unparseable page
      yields `parse_error` without raising; the calendar-only event is produced
      from the calendar alone. (T2.6)
      Files: `tests/test_sources.py`
      Verify: `uv run pytest tests/test_sources.py` — all pass; `make check` green.

---

## Milestone M3 — Normalization (T3.1–T3.4, FR-8–FR-11)

- [ ] 8. Implement `vandy_food_radar/normalize/datetime_parse.py`: timezone-aware
      parsing of `event_date` (`YYYY-MM-DD`) and `start_time`/`end_time`
      (`HH:MM`) in `config.timezone`; unparseable values return `None` **and** a
      recorded flag (never dropped, never crash). Pure, no I/O. (T3.2, FR-10, E-12)
      Files: `vandy_food_radar/normalize/__init__.py`,
      `vandy_food_radar/normalize/datetime_parse.py`
      Verify: `make typecheck` passes.

- [ ] 9. Implement `vandy_food_radar/normalize/food_classifier.py`: a **documented
      keyword table** mapping description text → `FoodCategory`
      (`full_meal`: dinner/lunch/breakfast/buffet/meal/pizza; `snacks_or_
      refreshments`: refreshments/snacks/coffee/cookies/appetizers/bagels) and →
      `FoodConfirmed` (explicit free-food/menu → `confirmed`; vague → keeps
      category but may be `unconfirmed`; negation → `contradicted`). Pure and
      deterministic. Respect the fixtures' existing `food_category`/`food_confirmed`
      when present, but the classifier must independently derive them from text
      for records lacking them. (T3.3, FR-11, E-6)
      Files: `vandy_food_radar/normalize/food_classifier.py`
      Verify: `make typecheck` passes.

- [ ] 10. Implement `vandy_food_radar/normalize/normalizer.py`: `normalize(record)
      -> NormalizedRecord` converting a `SourceRecord.parsed_fields` into canonical
      field values (date/time via step 8, food via step 9), **preserving the
      per-source originals** (kept on the `SourceRecord`, no lossy overwrite). Sets
      a per-record `cancelled` signal from `parsed_fields["cancelled"]` or a
      `[CANCELLED]`/`status: cancelled` marker. No I/O. (T3.1, FR-8, FR-9)
      Files: `vandy_food_radar/normalize/normalizer.py`
      Verify: `make typecheck` passes.

- [ ] 11. Add `tests/test_normalize.py`: valid date/time parsing; bad date/time →
      flagged, not dropped; vague "refreshments" → `snacks_or_refreshments`;
      dinner-with-menu → `full_meal` + `confirmed`; missing fields tolerated;
      originals preserved. (T3.4, E-6, E-12)
      Files: `tests/test_normalize.py`
      Verify: `uv run pytest tests/test_normalize.py` — all pass; `make check` green.

---

## Milestone M4 — Deduplication (T4.1–T4.4, FR-12–FR-15, E-1/E-10/E-13)

- [ ] 12. Implement `vandy_food_radar/dedup/similarity.py`: pure similarity
      functions — normalized `title_sim` (lowercase, strip punctuation/stopwords,
      token Jaccard), `time_proximity` (1.0 within `config.dedup.
      time_proximity_minutes`, decaying), `location_sim`, `organizer_sim`, combined
      into a weighted score. Blocking helper groups candidates by `event_date`.
      (T4.1, FR-13, E-10)
      Files: `vandy_food_radar/dedup/__init__.py`,
      `vandy_food_radar/dedup/similarity.py`
      Verify: `make typecheck` passes.

- [ ] 13. Implement `vandy_food_radar/dedup/deduplicator.py`: within each date
      block, cluster records with score `>= merge_threshold`; `[review_low,
      merge_threshold)` merges **and** flags `possible_duplicate`; `< review_low`
      stays separate. Merge builds one `Event` linking all contributing
      `SourceRecord`s (canonical field choice deferred to verify). Generate a
      deterministic `dedup_key` = `event_date` + stable fingerprint (normalized
      title tokens + venue + rounded start). (T4.2, T4.3, FR-12/14/15, FR-42)
      Files: `vandy_food_radar/dedup/deduplicator.py`
      Verify: `make typecheck` passes.

- [ ] 14. Add `tests/test_dedup.py`: the two pizza-night records merge into one
      event (AC-4); two genuinely different same-time events do **not** merge
      (E-13); the same recurring title on different dates does **not** merge
      (E-10); `dedup_key` stable across runs. (T4.4)
      Files: `tests/test_dedup.py`
      Verify: `uv run pytest tests/test_dedup.py` — all pass; `make check` green.

---

## Milestone M5 — Verification & conflict resolution / Verify (T5.1–T5.6, FR-16–FR-21)

- [ ] 15. Implement `vandy_food_radar/verify/conflict.py`: per-field cross-check
      across a merged event's source records → `FieldProvenance`
      (`agreed`/`resolved_conflict`/`single_source`/`missing`). On disagreement,
      pick by `config.authority_precedence` (official_page > anchor_link >
      google_calendar), tie-break by most recent `source_updated_at`
      (fallback `checked_at`), and record a `Conflict` preserving **all** losing
      values. Pure given the records. (T5.1, T5.2, FR-16–FR-19, AC-5)
      Files: `vandy_food_radar/verify/__init__.py`,
      `vandy_food_radar/verify/conflict.py`
      Verify: `make typecheck` passes.

- [ ] 16. Implement `vandy_food_radar/verify/verifier.py`: apply resolved field
      values to the canonical `Event`; wire official-page records with top
      authority; a `parse_error`/`fetch_error` official record is dropped from
      comparison (graceful degrade, no crash). Derive `verification_state`
      (`verified` | `partially_verified` | `conflicting` | `food_unconfirmed` |
      `cancelled`) and a deterministic `confidence` (0..1) from fraction agreed +
      top-authority presence + food status + RSVP link health. Handle food
      disagreement (E-5 → `food_unconfirmed`/`conflicting`, reduce confidence).
      Detect cancellation from any authoritative record → `cancelled` state +
      an `EventHistory` entry. RSVP link health via the official-page fetcher
      result (broken → `rsvp_link_ok=False`, E-8). (T5.3–T5.5, FR-20/21, E-4/E-5/E-8, AC-6/AC-9/AC-12)
      Files: `vandy_food_radar/verify/verifier.py`
      Verify: `make typecheck` passes.

- [ ] 17. Add `tests/test_verify.py`: authority precedence picks official-page
      18:00 for the career-mixer, 18:30 preserved as a `Conflict`, state
      `conflicting` (AC-5); recency tie-break; food conflict → reduced
      confidence/`food_unconfirmed` (AC-6); cancelled event → `cancelled` +
      history (AC-12); unparseable official page degrades gracefully (AC-9);
      broken RSVP link flagged (E-8). (T5.6)
      Files: `tests/test_verify.py`
      Verify: `uv run pytest tests/test_verify.py` — all pass; `make check` green.

---

## Milestone M6 — Ranking + Web UI / Rank → Display (T6.1–T6.9, FR-22–FR-38)

- [ ] 18. Implement `vandy_food_radar/providers/location.py`: `LocationProvider`
      protocol (`walking(origin, dest) -> WalkingResult{distance_m?, minutes?,
      status}`), `HaversineLocationProvider` (straight-line from
      `config.reference_location`, coarse minutes) and `NullLocationProvider`
      (always `unknown`). Unknown walking must map to the neutral
      `config.ranking.walking_unknown_value` in scoring, never zero. Also declare a
      `CalendarProvider` protocol + a no-op default (interface only; no auto-add).
      (T6.1, FR-28/29/30, AC-7/AC-8; FR-39/40 interface only)
      Files: `vandy_food_radar/providers/__init__.py`,
      `vandy_food_radar/providers/location.py`,
      `vandy_food_radar/providers/calendar.py`
      Verify: `make typecheck` passes.

- [ ] 19. Implement `vandy_food_radar/ranking/engine.py`: weighted-sum scorer
      using `config.ranking.weights` (exact §6.1 defaults). Each factor normalized
      to [0,1] per §6.1 derivations (food_confirmed 1/0.3/0; full_meal
      1/0.4/0.2/0; food_specificity from description detail; rsvp_likelihood
      1/0.7/0.3/0.5; timing curve over `timing_good_start/end_hour`; walking via
      provider with neutral fallback; confidence passthrough). Store a
      `ScoreComponent` per factor (raw_value, weight, contribution, note); set
      `Event.score_total`. Ordering: score desc, then earlier `start_time`, then
      `title` asc. Cancelled events forced to bottom/segregated. (T6.2, FR-22–27)
      Files: `vandy_food_radar/ranking/__init__.py`,
      `vandy_food_radar/ranking/engine.py`
      Verify: `make typecheck` passes.

- [ ] 20. Implement `vandy_food_radar/ranking/explanation.py`: build a short
      human-readable "why this rank" string from the top-contributing
      `ScoreComponent.note`s (confirmed dinner-with-menu cites the full meal +
      specific menu; refreshments cites vagueness/unconfirmed). (T6.3, FR-25, US-3)
      Files: `vandy_food_radar/ranking/explanation.py`
      Verify: `make typecheck` passes.

- [ ] 21. Add `tests/test_ranking.py`: dinner-with-menu outranks refreshments and
      the explanation cites the reason (AC-3); ranking deterministic across two
      runs (AC-2); changing a weight reorders predictably; unknown-walking uses the
      neutral default and does not zero/crash (AC-8). (T6.4)
      Files: `tests/test_ranking.py`
      Verify: `uv run pytest tests/test_ranking.py` — all pass; `make check` green.

- [ ] 22. Implement `vandy_food_radar/pipeline/orchestrator.py`:
      `run(window, *, repository, sources, location_provider, config) -> RunReport`
      threading ingest → normalize → dedup → verify → score → save. Idempotent
      upsert on `dedup_key`; diff against the stored event to append
      `EventHistory` on changed tracked fields. Include a `seed`/demo helper that
      loads the fixture corpus and **retargets** its dates onto the target day so
      the DB always has content for "tomorrow". Add a CLI entrypoint
      `vandy_food_radar/__main__.py` (or `cli.py`) exposing `seed` and `run`.
      (T6.5, FR-41 shape/FR-42/FR-43, AC-11)
      Files: `vandy_food_radar/pipeline/__init__.py`,
      `vandy_food_radar/pipeline/orchestrator.py`, `vandy_food_radar/cli.py`
      Verify: `make typecheck`; `uv run python -m vandy_food_radar seed` populates a
      SQLite DB (spot-check via CLI output).

- [ ] 23. Add Flask to deps and build the web app in
      `vandy_food_radar/web/app.py` + `vandy_food_radar/web/templates/` +
      `static/`. `create_app(config)` reads **only** through the `Repository`.
      Main route renders next-day events in ranked order as dense cards showing
      title, time, location, food description, RSVP status, walking time (or
      "unavailable"), source links, verification badge, and the ranking
      explanation; an expandable section shows recorded conflicts. State styling
      visibly distinguishes verified / partially_verified / conflicting /
      food_unconfirmed / cancelled. A "Refresh now" POST runs the pipeline for
      tomorrow. Density-first CSS. (T6.6–T6.8, FR-34–38)
      Files: `pyproject.toml` (add `flask`), `vandy_food_radar/web/__init__.py`,
      `vandy_food_radar/web/app.py`, `vandy_food_radar/web/templates/index.html`,
      `vandy_food_radar/web/templates/_event_card.html`,
      `vandy_food_radar/web/static/app.css`
      Verify: `make typecheck`; app imports and a test client GET "/" returns 200
      with seeded event titles present.

- [ ] 24. Add `tests/test_web.py` and `tests/test_pipeline_e2e.py`: web test uses
      a Flask test client over a seeded repo, asserts 200, ranked order, all
      required card fields, state badges, and that "Refresh now" runs the pipeline.
      The **end-to-end** test runs the full Discover→Display pipeline over the
      fixture corpus and asserts: the two pizza-night sources merge to one event;
      the career-mixer resolves to the official 18:00 with the 18:30 conflict
      preserved; the cancelled event is `cancelled`; dinner-with-menu outranks
      refreshments; final ordering and states as expected. (T6.9, AC-1)
      Files: `tests/test_web.py`, `tests/test_pipeline_e2e.py`
      Verify: `uv run pytest tests/test_web.py tests/test_pipeline_e2e.py` pass;
      `make check` green.

- [ ] 25. Add `make seed`, `make run`, `make demo` targets and README launch docs.
      `make demo` = seed the fixture corpus into SQLite (dates retargeted to
      tomorrow) then start Flask on localhost; document the exact single command
      and the URL so opening the page shows ranked fixture events out of the box.
      (Deliverable/launch)
      Files: `Makefile`, `README.md`
      Verify: `make demo` starts the server; `curl -s localhost:<port>/ | grep`
      shows event titles; `make check` green.

---

## Assumptions / gaps

- **Flask** chosen over FastAPI for minimal footprint (design permits either).
- **Seeding retargets fixture dates to "tomorrow"** so the page is never empty;
  this is a demo affordance, documented in README, and does not alter core
  pipeline logic (the pipeline still processes a target-day window).
- Fixtures already embed `parsed_fields`; adapters surface them and the
  normalizer re-derives canonical values (esp. food category/confirmed) so the
  normalizer/classifier are independently tested rather than trusting the corpus.
- Each milestone leaves the tree green (`make check`); features are strictly
  dependency-ordered M1→M6 and must be implemented in sequence.
