# Vandy Food Radar

A lightweight, single-user tool for Vanderbilt students that discovers upcoming
campus events offering free food, cross-checks details across sources, and ranks
events by how worthwhile they are to attend.

The MVP pipeline is **Discover → Normalize → Deduplicate → Verify → Rank →
Display**. See the full spec under [`.kiro/specs/vandy-food-radar/`](.kiro/specs/vandy-food-radar/)
(`requirements.md`, `design.md`, `tasks.md`, `assumptions.md`).

## Project status

The full MVP pipeline is implemented end to end and runs entirely offline:

- typed configuration and domain models (`config.py`, `models.py`);
- source ingestion behind an `HttpFetcher`/`SourceAdapter` seam with an offline
  fixture fetcher (`sources/`);
- normalization, deduplication, and verification/conflict-resolution
  (`normalize/`, `dedup/`, `verify/`);
- a transparent weighted-sum ranking engine with stored score components and an
  explanation generator (`ranking/`);
- SQLite persistence behind a `Repository` (`store/`), location/calendar
  provider seams (`providers/`), the pipeline orchestrator + CLI (`pipeline/`,
  `cli.py`), and a server-rendered Flask web UI (`web/`).

Everything is deterministic and makes **no network calls**; all source data
comes from the fixture corpus under `tests/fixtures/`.

## Requirements

- Python **3.11+**
- [`uv`](https://docs.astral.sh/uv/) for environment and dependency management

If you use `pyenv`, install and select 3.11 first:

```sh
pyenv install 3.11
pyenv local 3.11
```

`uv` will locate a suitable Python 3.11 interpreter automatically.

## Setup

Install the package with its development dependencies (ruff, black, mypy,
pytest) into a local virtual environment:

```sh
make install
```

## Common tasks

| Command          | What it does                                  |
| ---------------- | --------------------------------------------- |
| `make install`   | Create the venv and install dev dependencies. |
| `make lint`      | Run `ruff` lint checks.                        |
| `make format`    | Auto-format with `black` and `ruff`.           |
| `make format-check` | Verify formatting without changes.          |
| `make typecheck` | Run `mypy` in strict mode.                     |
| `make test`      | Run the `pytest` suite.                        |
| `make check`     | Run lint, format-check, typecheck, and tests.  |
| `make seed`      | Load the fixture corpus into SQLite, retargeted to tomorrow. |
| `make run`       | Run the pipeline over the configured sources for the target day. |
| `make demo`      | Seed the corpus **and** serve the ranked-events web UI. |

## Running the app

To see ranked free-food events in your browser out of the box, run a single
command:

```sh
make demo
```

This seeds the offline fixture corpus into `store.db` (with each event's date
retargeted onto **tomorrow** so the page is never empty), then serves the web
UI. Open:

```
http://127.0.0.1:5000/
```

The main page lists tomorrow's events in ranked order as dense cards showing the
title, time, location, food description, RSVP status, walking time (or
"unavailable"), source links, a verification badge, and a short explanation of
the ranking, with an expandable list of any detected conflicts. The **Refresh
now** button re-runs the pipeline for the same day.

Prefer to run the steps separately:

```sh
make seed        # populate store.db with tomorrow's events
make run         # (or) run the pipeline over the configured sources
make web         # serve the UI reading from store.db
```

The pipeline is also available directly on the CLI:

```sh
uv run python -m vandy_food_radar --db store.db seed
uv run python -m vandy_food_radar --db store.db run
```

Both write to the SQLite database at `--db` (default `store.db`, a local
runtime artifact that is not committed). Re-running is idempotent: events upsert
by their dedup key and no duplicates are created.

## Configuration

Configuration lives in `vandy_food_radar/config.py` with defaults that run out
of the box in offline mode. A curated subset can be overridden via environment
variables prefixed with `VFR_`, for example:

- `VFR_OFFLINE` — `true`/`false` (default `true`)
- `VFR_TIMEZONE` — IANA timezone (default `America/Chicago`)
- `VFR_TARGET_WINDOW` — `next_day` (default) or `today`
- `VFR_REF_LABEL`, `VFR_REF_LAT`, `VFR_REF_LNG` — reference location
- `VFR_GOOGLE_CALENDAR_ID`, `VFR_GOOGLE_CALENDAR_API_KEY` — calendar source
- `VFR_LOCATION_PROVIDER` — `haversine` (default) or `null`
- `VFR_CALENDAR_PROVIDER` — `none` (default) or `google`

Secrets (API keys/OAuth) are read from the environment and must never be
committed.

## Testing

Tests are offline-first and use the JSON/HTML fixture corpus in
`tests/fixtures/`; no live network access is required.

```sh
make test
```
