# M0 project foundation for Vandy Food Radar

Milestone M0 scaffolds the Vandy Food Radar Python project: build tooling and `make` targets (T0.1), a typed offline-first config module covering CFG-1..CFG-8 (T0.2), the six domain entities and their enums from design §2.1 (T0.3), and a six-scenario offline fixture corpus with a loader (T0.4). The work is deterministic and makes no network calls. The implementer recorded lint/typecheck/format/test evidence (27 tests green, mypy clean on 9 files, ruff and black clean) in `m0-verification.md`; that evidence is internally consistent and I did not re-run the suites. The implementation stays strictly inside M0 scope — no adapters, repository, normalizer, dedup, verifier, ranker, pipeline, or web UI leaked in.

Watch for: nothing blocking. Two informational notes only — `Config.from_env` deliberately exposes an env override for only a subset of settings (weights, dedup thresholds, and authority precedence are code-level defaults, not env-overridable) (confirmed); and the model layer ships two helper enums and two value objects beyond the six named entities/five named enums, which is additive and spec-consistent (confirmed).

**Verdict**: APPROVED

## High-level view

The config module is a tree of dataclasses with a `default_config()` that runs offline out of the box and a `from_env` layer that reads `VFR_`-prefixed variables. It reproduces the design's §6.1 ranking weights exactly (0.25/0.25/0.15/0.10/0.05/0.10/0.10, summing to 1.0), the authority precedence `official_page > anchor_link > google_calendar`, dedup merge/review thresholds, and provider selection (haversine location, calendar disabled). The reference location is a configurable dataclass default, not hard-coded into any logic.

The domain layer is pure dataclasses mirroring design §2.1: the six entities plus `GeoPoint` and `CompetingValue` value objects, and the five required enums plus `FieldAgreement` and `ScoreFactor`. Nullable fields use `None` for genuinely unknown values, tri-state booleans included.

The fixture corpus covers all six required scenarios as JSON raw-payload records (verbatim source payload plus a per-source parsed view, `checked_at`, `parse_status`, `source_updated_at`) with one HTML snippet standing in for an unparseable page. A loader in `fixtures.py` reads them offline, and `test_fixtures.py` asserts every fixture loads and covers each named scenario.

Two forward-looking gaps do not block M0 but should carry into later milestones: the `from_env` override surface omits ranking weights, dedup thresholds, and authority precedence (they are code-level defaults only), which M6 weight-tuning work will need to wire; and `from_env` is fail-soft, so a mistyped override silently runs the default rather than surfacing the error.

<details>
<summary>Issues (4)</summary>

1. **Narrow env override surface** — `Config.from_env` does not expose ranking weights, dedup thresholds, or authority precedence as env overrides; they are code-level defaults only. Non-blocking for M0 (CFG-6/CFG-7 require a single config block with defaults, satisfied), but the M6 ranking-tuning tasks (T6.2/T6.4) will need an env hook or config-file loader.
2. **Fail-soft env parsing hides typos** — invalid enum/float overrides fall back to defaults instead of raising, so a mistyped `VFR_*` value runs silently with the wrong config. Acceptable for a single-user tool; consider logging a warning when a provided override is discarded.
3. **Typecheck scope relies on `files` key** — `make typecheck` runs bare `uv run mypy` scoped only by `pyproject.toml`'s `files` list. A future module outside `vandy_food_radar/`/`tests/` would silently escape strict checking; keep the list current as packages are added.
4. **Fixture source-level food labels** — `parsed_fields` carry `food_confirmed`/`food_category` per source (e.g. pizza tagged `full_meal`). These are source-parsed views, not canonical verdicts; M3 food-classifier tests must not treat them as the classifier's expected output.

</details>

<details>
<summary>Details</summary>

### Toolchain and make targets (T0.1)

`pyproject.toml` declares a hatchling build over the `vandy_food_radar` package, `requires-python >=3.11`, no runtime dependencies, and a `dev` extra pinning ruff/black/mypy/pytest. Tool config is present for all four: ruff selects E/F/I/UP/B/W at py311, black at py311/line-length 88, mypy `strict = true` with `files` scoping both the package and tests, and pytest `testpaths = ["tests"]`. The `Makefile` exposes `install`, `lint`, `format`, `format-check`, `typecheck`, `test`, `check`, and `clean` — a superset of the required targets — all routed through `uv run` against a pinned 3.11 interpreter. `.gitignore` (confirmed present, 301 bytes) and `README.md` exist; the README correctly scopes the project to M0 and documents the `VFR_` env surface. The evidence shows `make test` green at 27 passed.

One toolchain caveat surfaces in the evidence and holds up: `make typecheck` runs bare `uv run mypy` and relies on the `files` key in `pyproject.toml` for scope. If a future module lands outside `vandy_food_radar/`/`tests/`, it would silently escape strict checking. Not an M0 defect — the two current packages are both listed — but a foot-gun for later milestones.

### Config surface and §6.1 fidelity (T0.2)

`_default_ranking_weights()` returns exactly the design §6.1 weights, and `test_ranking_weights_match_design_and_sum_to_one` pins each value and the 1.0 sum, so a future edit that drifts from the spec fails a test. Authority precedence defaults to `[OFFICIAL_PAGE, ANCHOR_LINK, GOOGLE_CALENDAR]` (CFG-5/FR-19). Dedup config carries `merge_threshold=0.75` and `review_low=0.55` with the ordering invariant checked in a test. `ProvidersConfig` defaults to haversine location and a disabled (`none`) calendar provider (CFG-8). `RankingConfig.walking_unknown_value=0.5` is the FR-30/AC-8 neutral-walking default, staged for M6.

The reference location is a `ReferenceLocation` dataclass (label + lat/lng) with a Kirkland Hall default and env overrides for all three fields — configurable, not hard-coded into ranking logic (CFG-3/FR-28).

`from_env` is fail-soft: unrecognized enum values and unparseable floats fall back to the current default rather than raising (`_parse_enum`, `_parse_float`), locked in by `test_env_overrides_and_invalid_values_fall_back`. This means a typo'd `VFR_TARGET_WINDOW` silently runs the default instead of surfacing the mistake — acceptable for a single-user tool but worth a discarded-override warning later.

The override surface covers offline flag, timezone, target window, reference location, Google Calendar id/key, and both provider kinds. It does not cover ranking weights, dedup thresholds, or authority precedence. CFG-6/CFG-7 require these configurable in one place with sane defaults, met by the dataclass block, so this is within M0 scope — but the M6 ranking tasks (T6.2/T6.4 exercise weight-change reordering) will need an env hook or config-file loader, and neither exists yet.

### Domain model shape (T0.3)

All six entities are present as pure dataclasses — `Event`, `SourceRecord`, `FieldProvenance`, `Conflict`, `ScoreComponent`, `EventHistory` — matching the design §2.1 field lists. `Event` makes every optional field nullable, defaults `food_confirmed`/`food_category`/`verification_state` to their unknown-leaning members, and models the `rsvp_required`/`rsvp_link_ok` tri-state as `bool | None`. `Conflict.competing_values` is a `list[CompetingValue]`, where `CompetingValue` captures `{value, source_id, source_updated_at}` — a faithful rendering of the design's inline `[{ value, source_id, source_updated_at }, ...]` shape rather than an untyped dict.

All five required enums (`VerificationState`, `FoodConfirmed`, `FoodCategory`, `SourceId`, `ParseStatus`) carry exactly the spec's member values, asserted member-for-member in `test_all_enum_members_present`. Two additional enums (`FieldAgreement`, `ScoreFactor`) and one value object (`GeoPoint`) appear beyond the named set. These are additive and directly traceable to design text — `FieldAgreement` to the §5 provenance vocabulary, `ScoreFactor` to the §6.1 factor names, `GeoPoint` to the `location_geo (lat/lng)` field — so they are groundwork the config module already consumes (`ScoreFactor` keys the weight table), not scope creep. No business logic or persistence sits in the module.

### Fixture corpus and loader (T0.4)

The corpus covers all six required scenarios, with the multi-source and conflicting-time cases split across multiple source files: `multi_source_pizza_night` (anchor + calendar, "Free Pizza Night" vs "Pizza Night (Free!)", same date/venue), `dinner_with_menu`, `refreshments_only`, `conflicting_start_time` (anchor + calendar disagreeing 18:00 vs 18:30, plus an official page at 18:00 as top authority), `cancelled_event`, `calendar_only_event`, and `unparseable_source_page`. Each JSON record carries `scenario`, `source_id`, `source_url`, `checked_at`, `source_updated_at`, `parse_status`, a verbatim `raw_payload`, and a per-source `parsed_fields` view — the raw-plus-parsed shape the design calls for and the shape adapters will produce in M2. The unparseable case correctly sets `parse_status: parse_error`, empty `parsed_fields`, and points at an HTML snippet (`raw_payload_file`) that the loader reads verbatim.

`test_fixtures.py` asserts the directory exists, every JSON fixture parses to a dict, each record has the required keys with `source_id`/`parse_status` validating against the model enums, the corpus covers every named scenario, and scenario-specific invariants hold (differing titles, disagreeing start times with official-page tie-break, cancellation flag, calendar-only having no anchor counterpart, parse-error record plus loadable HTML) — satisfying T0.4's "a test asserting every fixture loads."

One shape note for downstream milestones: the fixture `parsed_fields` embed a `food_confirmed` string on every record, including the cancelled and calendar-only cases, and mark `food_category: full_meal` for the pizza fixtures. These are source-parsed views, not canonical verdicts — the M3 normalizer/food-classifier tests should not assume these source-level labels are the classifier's own output.

### Scope discipline

No M1+ artifacts are present. `find` over the package and tests shows only `config.py`, `models.py`, `fixtures.py`, `__init__.py`, and the four test modules — no `sources/`, `store/`, `normalize/`, `dedup/`, `verify/`, `ranking/`, `pipeline/`, `providers/`, or `web/`. The evidence's network-import scan (requests/httpx/urllib/http.client/socket) found nothing, consistent with the offline requirement. The `LocationProviderKind`/`CalendarProviderKind` enums and `walking_unknown_value` exist only as config declarations for later milestones, which is exactly what CFG-8 and the design's "interface defined now, implemented later" boundary call for.

</details>

<details>
<summary>File map</summary>

- `pyproject.toml` — hatchling build, dev deps, ruff/black/mypy(strict)/pytest config (T0.1)
- `Makefile` — install/lint/format/format-check/typecheck/test/check/clean via `uv run` (T0.1)
- `README.md` — M0-scoped overview, task table, `VFR_` env docs (T0.1)
- `.gitignore` — present (T0.1)
- `vandy_food_radar/__init__.py` — package version, M0 scope note
- `vandy_food_radar/config.py` — CFG-1..CFG-8 typed config, offline defaults, `from_env` overrides (T0.2)
- `vandy_food_radar/models.py` — six §2.1 entities + five required enums (+2 helper enums, GeoPoint/CompetingValue), pure data (T0.3)
- `vandy_food_radar/fixtures.py` — offline JSON/HTML fixture loader (T0.4)
- `tests/fixtures/*.json` (10) + `unparseable_official_page.html` — six-scenario corpus (T0.4)
- `tests/test_config.py` — CFG-1..CFG-8 assertions incl. §6.1 weights and fail-soft env
- `tests/test_models.py` — entity construction + full enum-member checks
- `tests/test_fixtures.py` — every fixture loads, scenario coverage, per-scenario invariants
- `tests/test_smoke.py` — package imports / version

No VCS diff available (project is not a git repository); reviewed against the working tree and the spec.

</details>
