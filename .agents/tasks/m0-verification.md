# Milestone M0 — Verification Evidence

Project: **Vandy Food Radar** — Milestone M0 (project foundation).
Iteration: first (no `.agents/tasks/m0-review.json` present).
Environment: Python 3.11 via pyenv (`uv` selected `cpython-3.11.16`), managed
with `uv`. All M0 work is deterministic and makes **no live network calls**.

## What was implemented (exactly the four M0 tasks)

- **T0.1 — Project init.** `pyproject.toml` (hatchling build, dev deps: ruff,
  black, mypy, pytest), tool config for ruff/black/mypy/pytest, `README.md`,
  `.gitignore`, and a `Makefile` exposing `install`, `lint`, `format`,
  `format-check`, `typecheck`, `test`, `check`, `clean`. Package
  `vandy_food_radar/`. A smoke test keeps `make test` green.
- **T0.2 — Config module** (`vandy_food_radar/config.py`): typed dataclasses
  with defaults + `OFFLINE` mode covering CFG-1..CFG-8 — timezone
  (`America/Chicago`), target window (`next_day`), configurable reference
  location (label + lat/lng, not hard-coded), per-source enable flags +
  credential/URL placeholders, authority precedence
  (`official_page > anchor_link > google_calendar`), ranking weights matching
  design.md §6.1 (0.25/0.25/0.15/0.10/0.05/0.10/0.10, sum 1.0) + thresholds,
  dedup thresholds (`merge_threshold`, `review_low`), provider selection
  (location default `haversine`; calendar default `none`). Env overrides via
  `Config.from_env` with safe fallbacks; `default_config()` runs offline out of
  the box.
- **T0.3 — Domain models** (`vandy_food_radar/models.py`): `Event`,
  `SourceRecord`, `FieldProvenance`, `Conflict`, `ScoreComponent`,
  `EventHistory` exactly per design.md §2.1, with the enums
  `VerificationState`, `FoodConfirmed`, `FoodCategory`, `SourceId`,
  `ParseStatus` (plus `FieldAgreement`, `ScoreFactor`). Pure dataclasses,
  nullable where the spec allows unknown values. No persistence/business logic.
- **T0.4 — Fixture corpus** (`tests/fixtures/`): JSON raw source payloads plus
  an HTML snippet, covering all six required scenarios:
  - (a) multi-source pizza night (Anchor Link + Google Calendar, slightly
    different titles),
  - (b) dinner-with-confirmed-menu vs. refreshments-only,
  - (c) conflicting start times across sources + linked official page,
  - (d) cancelled event,
  - (e) calendar-only event (no Anchor Link page),
  - (f) unparseable official page (`parse_error` JSON + HTML snippet).
  Loader helper `vandy_food_radar/fixtures.py`; `tests/test_fixtures.py`
  asserts every fixture loads/parses with no network access.

Scope note: no adapters, repository, normalizer, dedup, verifier, ranker,
pipeline, or web UI were built — those are M1+.

## Commands run and results

Run from `/projects/sandbox`:

### `make install`
Succeeded. `uv sync --python 3.11 --extra dev` built the package and installed
dev deps (ruff 0.16.9, black 26.5.1, mypy 2.3.1, pytest 9.1.1). Interpreter:
`uv run python --version` -> `Python 3.11.16`.

### `make lint`
```
uv run ruff check .
All checks passed!
```

### `make typecheck`
```
uv run mypy
Success: no issues found in 9 source files
```

### `make format-check`
```
uv run black --check .
All done! ✨ 🍰 ✨
9 files would be left unchanged.
```

### `make test` (final output, verbatim)
```
uv run pytest
...........................                                              [100%]
27 passed in 0.02s
```

### `make check` (lint + format-check + typecheck + test)
All four stages passed (see individual outputs above).

## Additional offline confirmations

- Config loads with defaults in offline mode:
  `offline: True | tz: America/Chicago | ref: Kirkland Hall`.
- All six domain entities and the five required enums import cleanly.
- Fixture corpus loads with no network: 10 JSON fixtures + 1 HTML fixture,
  covering scenarios: `calendar_only_event`, `cancelled_event`,
  `conflicting_start_time`, `dinner_with_menu`, `multi_source_pizza_night`,
  `refreshments_only`, `unparseable_source_page`.
- Network-import scan of `vandy_food_radar/` and `tests/` (requests, httpx,
  urllib, http.client, socket, urlopen): none found.

## Notes for the reviewer

- Black is invoked through `uv run`, which uses the project's Python 3.11
  interpreter. PEP 695 generic syntax was intentionally avoided (a `TypeVar`
  is used in `config.py`) so the toolchain stays 3.11-compatible.
- String enums use `enum.StrEnum` (3.11+) per ruff's `UP042`.
- No commit was made; changes are left in the working tree as instructed.
- `tasks.md` checkboxes were intentionally left unchecked (updated by a later
  step after approval).
