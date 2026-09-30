# Vandy Food Radar — Design

This document describes the architecture, data model, component
responsibilities, and the core algorithms (dedup, verification/conflict
resolution, ranking) for the MVP, plus integration boundaries and deployment
notes. It maps directly to `requirements.md`.

---

## 1. Architecture Overview

A single, modular application — **not** microservices. One process runs a
**pipeline** that moves data through clearly separated stages, backed by a
persistence layer and fronted by a thin web UI. External services are reached
only through adapters.

```
                ┌──────────────────────────────────────────────┐
                │                Web UI (presentation)          │
                │   next-day ranked list · event detail · state │
                └───────────────▲──────────────────────────────┘
                                │ read
                        ┌───────┴────────┐
                        │  Repository    │  (persistence interface)
                        └───────▲────────┘
                                │
   ┌─────────┐  raw  ┌──────────┴─────────────────────────────────────────┐
   │ Source  │──────▶│                 Pipeline (orchestrator)             │
   │Adapters │       │  ingest → normalize → dedup → verify → score → save │
   └────┬────┘       └──────────┬───────────────┬───────────────┬─────────┘
        │                        │               │               │
  Anchor Link              LocationProvider   (verify fetches   Ranking config
  Google Calendar          (walking dist)      official pages    (weights)
  Official page fetch      CalendarProvider     via SourceAdapter/fetcher)
                           (deferred write)
```

### 1.1 Layering / separation of concerns (per architecture principles)

| Concern | Module | Depends on |
|---|---|---|
| Source ingestion | `sources/` (adapters) | fetcher, config |
| Normalization | `normalize/` | domain model |
| Deduplication | `dedup/` | domain model |
| Verification / conflict resolution | `verify/` | authority config, fetcher |
| Scoring | `ranking/` | scoring config, LocationProvider |
| Persistence | `store/` (repository) | domain model |
| Presentation | `web/` | repository (read-only) |
| External integrations | `providers/` (location, calendar) | adapter interfaces |
| Orchestration | `pipeline/` | all of the above |
| Config | `config/` | — |

Dependencies point inward toward the domain model. The web layer reads through
the repository and never calls sources directly. Providers and sources are
injected, enabling offline/fixture runs.

### 1.2 Recommended stack (assumption — see Assumptions)

- **Language/runtime:** Python 3.11+ (rich HTML/date parsing, easy Google API
  clients, strong testing story). *Node/TypeScript is an acceptable alternative
  if preferred; the design is language-agnostic at the interface level.*
- **Web:** a minimal server-rendered app (FastAPI + Jinja templates, or Flask).
  Server-rendered keeps the UI dense and simple; no SPA needed for MVP.
- **Storage:** SQLite via a repository interface (file-based, zero-ops,
  single-user). Swappable for Postgres later without touching business logic.
- **Scheduling (deferred):** cron or APScheduler invoking the same pipeline
  entrypoint used by the CLI.

---

## 2. Data Model

The model separates **canonical** (normalized, merged) data from **per-source
raw** data, and retains conflicts, scoring, and history so any normalized value
can be explained (FR-9, FR-31, FR-32).

### 2.1 Entities

```
Event (canonical)
  id                      stable surrogate id
  dedup_key               deterministic key (date + fingerprint) for idempotency
  title
  event_date              (date, tz-aware day)
  start_time / end_time   (tz-aware, nullable)
  location                (text, nullable)
  location_geo            (lat/lng, nullable)
  organizer               (nullable)
  rsvp_required           (bool | unknown)
  rsvp_url                (nullable)
  rsvp_link_ok            (bool | unknown)   # from verification
  event_url               (canonical link)
  food_confirmed          (confirmed | unconfirmed | contradicted)
  food_category           (full_meal | snacks_or_refreshments | unspecified | none)
  food_description        (text, nullable)
  verification_state      (verified | partially_verified | conflicting
                           | food_unconfirmed | cancelled)
  confidence              (0..1, derived)
  score_total             (number)
  created_at / updated_at

SourceRecord (raw, one per source contribution)
  id
  event_id                FK → Event
  source_id               (anchor_link | google_calendar | official_page | ...)
  source_url
  raw_payload             (verbatim: JSON/HTML snippet as retrieved)
  parsed_fields           (this source's own normalized view, per field)
  checked_at              (timestamp of last fetch)
  parse_status            (ok | parse_error | fetch_error)
  source_updated_at       (source's own last-modified, if available)

FieldProvenance (how each canonical field was chosen)
  id
  event_id                FK → Event
  field_name              (e.g., "start_time")
  chosen_value
  chosen_source_id
  agreement               (agreed | resolved_conflict | single_source | missing)

Conflict
  id
  event_id                FK → Event
  field_name
  competing_values        [{ value, source_id, source_updated_at }, ...]
  resolution              (value chosen + rule applied: authority / recency)

ScoreComponent
  id
  event_id                FK → Event
  factor                  (food_confirmed | full_meal | food_specificity
                           | rsvp_likelihood | timing | walking | confidence)
  raw_value               (measured input)
  weight
  contribution            (weight * normalized raw_value)
  note                    (text used to build the human explanation)

EventHistory
  id
  event_id                FK → Event
  changed_at
  field_name
  old_value / new_value
  reason                  (e.g., "source update", "cancellation")
```

### 2.2 Multi-user readiness

Every canonical `Event` and config-derived artifact is single-user today. To go
multi-user later, add an `owner_id` (or a `Workspace`) FK to `Event`,
config, and preferences — an **additive** migration. Reference location,
ranking weights, and provider selection already live in a config object that
can become a per-user record. No core algorithm changes are required. (Satisfies
"reasonably easy to support multiple users later.")

---

## 3. Component Responsibilities

### 3.1 Source adapters (`sources/`, FR-1–FR-5, FR-7)
- Common interface:
  `SourceAdapter.fetch(window) -> list[SourceRecord]`.
- Implementations: `AnchorLinkAdapter` (filter = Free Food perk),
  `GoogleCalendarAdapter` (configured calendar), `OfficialPageFetcher` (used by
  verification to pull a linked page).
- Each adapter returns raw payload + its own best-effort parsed view + a
  `checked_at` and `parse_status`. Adapters **never** merge or rank; they only
  retrieve and shallow-parse. Failures return a record with `parse_error`/
  `fetch_error` — they do not raise out of the pipeline.
- A shared `HttpFetcher` (with timeouts/retries) is injected so tests can supply
  fixtures and no live network is needed.

### 3.2 Normalizer (`normalize/`, FR-8–FR-11)
- Converts each `SourceRecord.parsed_fields` into the canonical field shape.
- Timezone-aware date/time parsing; unparseable values flagged, not dropped.
- Food classifier maps free text → `food_category` and `food_confirmed` via a
  documented keyword table (e.g., "dinner/lunch/breakfast/buffet/meal" →
  `full_meal`; "refreshments/snacks/light bites/coffee/cookies" →
  `snacks_or_refreshments`; explicit "free food"/menu items → `confirmed`).
- Deterministic and pure (no I/O) for testability.

### 3.3 Deduplicator (`dedup/`, FR-12–FR-15) — see §4.
### 3.4 Verifier (`verify/`, FR-16–FR-21) — see §5.
### 3.5 Ranker (`ranking/`, FR-22–FR-27) — see §6.
### 3.6 Repository (`store/`, FR-31–FR-33)
- Interface: `save_events`, `get_events_for_day`, `find_by_dedup_key`,
  `append_history`, `get_conflicts`, `get_score_components`.
- SQLite implementation for MVP; interface allows Postgres later.
- `find_by_dedup_key` + upsert semantics deliver idempotency (FR-42).

### 3.7 Providers (`providers/`)
- `LocationProvider.walking(origin, dest) -> {distance_m?, minutes?, status}`
  (FR-29, FR-30). MVP ships `HaversineLocationProvider` (straight-line from
  static campus coordinates) and `NullLocationProvider` (always "unknown").
  A `GoogleMapsLocationProvider` can be added later without touching ranking.
- `CalendarProvider.add_event(event) -> result` (FR-39, FR-40) — interface
  defined now; `GoogleCalendarWriter` implemented in the deferred task. No
  auto-add.

### 3.8 Pipeline orchestrator (`pipeline/`)
- Single entrypoint used by both the web "refresh" action and the scheduled job:
  `run(window) : ingest → normalize → dedup → verify → score → persist`.
- Idempotent upsert on `dedup_key`; diffs against stored event to emit history.

### 3.9 Web UI (`web/`, FR-34–FR-38)
- Server-rendered main page: tomorrow's events, ranked. Dense cards with all
  required fields + a badge for verification state and an expandable
  "why this rank" and "conflicts" section. Cancelled events segregated/greyed.

---

## 4. Deduplication Approach (FR-12–FR-15, E-1, E-10)

Deterministic, explainable, no ML.

1. **Blocking:** only compare records on the **same `event_date`** (prevents
   merging recurring occurrences across days — E-10).
2. **Similarity score** between two records = weighted sum of:
   - `title_sim` — normalized token/Jaccard or Levenshtein ratio on lowercased,
     punctuation-stripped, stop-word-removed titles (handles "Free Pizza Night"
     vs "Pizza Night (Free!)").
   - `time_proximity` — 1.0 if start times within N minutes, decaying to 0.
   - `location_sim` — normalized string similarity on venue.
   - `organizer_sim` — normalized similarity on organizer.
3. **Decision thresholds (configurable, FR-13/FR-15):**
   - `>= MERGE_THRESHOLD` → merge as the same event.
   - `[REVIEW_LOW, MERGE_THRESHOLD)` → merge **and** flag `possible_duplicate`.
   - `< REVIEW_LOW` → keep separate.
4. **Merge** builds one `Event` referencing all contributing `SourceRecord`s;
   canonical field selection is deferred to the Verifier (§5).
5. **`dedup_key`** = `event_date` + a stable fingerprint (normalized title
   tokens + venue + rounded start time), used for idempotent upsert across runs.

Pure functions over normalized records → fully unit-testable with fixtures.

---

## 5. Verification & Conflict Resolution (FR-16–FR-21, E-2–E-5, E-11)

For each canonical field of a merged event:

1. Gather each contributing source's value + its `source_id` and
   `source_updated_at`.
2. **Agreement:** if all present values equal (after normalization) →
   `agreed`, field `verified`.
3. **Conflict:** if values differ →
   - choose by **authority precedence** (FR-19 default: `official_page` >
     `anchor_link` > `google_calendar`);
   - break ties by **most recent `source_updated_at`** (FR-18);
   - record a `Conflict` row with all competing values (losers preserved);
   - field marked `resolved_conflict`.
4. **Single source / missing:** mark `single_source` or `missing`.
5. **Official-page verification:** if an event has a linked official page,
   `OfficialPageFetcher` pulls it; parsed values enter the same comparison with
   top authority. A `parse_error`/`fetch_error` here is recorded and simply
   removes that source from the comparison (E-11, AC-9) — no crash.

**Event-level `verification_state`:**
- all key fields agreed & food confirmed → `verified`
- some fields single-source/missing but no conflicts → `partially_verified`
- any conflict on a key field → `conflicting`
- food not confirmed or contradicted → `food_unconfirmed`
  (or `conflicting` if actively contradicted, E-5)
- cancellation signal from an authoritative source → `cancelled` (E-4),
  which overrides the others and appends history.

**Confidence (0..1)** is derived deterministically from: fraction of fields
`agreed`, presence of the top-authority source, food-confirmation status, and
RSVP link health. Confidence feeds ranking (FR-23).

---

## 6. Ranking Algorithm (FR-22–FR-27, US-3, US-4)

Transparent weighted sum. Every factor is normalized to `[0,1]`, multiplied by
a configurable weight, and its contribution + a note is stored as a
`ScoreComponent` so the UI can explain the total.

```
score_total = Σ (weight_f × value_f)      for f in factors
```

### 6.1 Factors (default weights — tunable via config, FR-27)

| Factor | Value (0..1) derivation | Default weight |
|---|---|---|
| `food_confirmed` | confirmed=1, unconfirmed=0.3, contradicted=0 | 0.25 |
| `full_meal` | full_meal=1, snacks/refreshments=0.4, unspecified=0.2, none=0 | 0.25 |
| `food_specificity` | scaled by menu/description detail (named items > generic) | 0.15 |
| `rsvp_likelihood` | no RSVP=1; RSVP required & link OK=0.7; required & link broken=0.3; unknown=0.5 | 0.10 |
| `timing` | preference curve over start time (configurable good/bad windows) | 0.05 |
| `walking` | closer=higher; unknown → neutral default (does not zero the score, FR-30) | 0.10 |
| `confidence` | verifier confidence directly | 0.10 |

Weights sum to 1.0 by default; config may change them. Cancelled events are
excluded from the ranked list (or forced to the bottom and flagged).

### 6.2 Determinism & tie-breaks (FR-26)
- Ordering: `score_total` desc, then earlier `start_time`, then `title`
  ascending. Fully reproducible.

### 6.3 Explanation (FR-25)
- Built by joining the top-contributing `ScoreComponent.note`s, e.g.:
  *"Ranked high: confirmed dinner with a specific menu (tacos, rice), no RSVP
  needed, ~6 min walk, verified across 2 sources."* vs.
  *"Ranked lower: only 'refreshments' mentioned, food not confirmed, location
  unknown."* This directly yields US-4's expected outcome (AC-3).

---

## 7. Integration Boundaries (adapters/interfaces)

| External service | Interface | MVP implementation | Later |
|---|---|---|---|
| Event sources | `SourceAdapter` | AnchorLink, GoogleCalendar, OfficialPageFetcher | more sources |
| Maps / walking | `LocationProvider` | Haversine + Null | GoogleMaps/other |
| Calendar write | `CalendarProvider` | interface only (no auto-add) | GoogleCalendarWriter |
| Storage | `Repository` | SQLite | Postgres |
| HTTP | `HttpFetcher` | requests/httpx w/ timeout+retry | — |

All are constructor-injected; the offline/test configuration wires fixture
adapters and the Null/Haversine providers so **the full pipeline runs with no
network** (testing requirement, FR-30).

---

## 8. Deployment Considerations

- **MVP:** runs locally as a single process. `store.db` (SQLite) on disk.
  Config via `.env`/`config.toml`. Web served on localhost.
- **Secrets:** Google Calendar API key / OAuth and (later) Maps API key kept in
  env/secret file, never committed.
- **Scheduled run (deferred):** the same `pipeline.run()` invoked by cron or
  APScheduler once daily for "tomorrow". Idempotent upsert on `dedup_key` means
  re-runs are safe (FR-42, AC-10).
- **Observability:** structured run log per pipeline run (counts: fetched,
  merged, conflicts, cancelled, scored) to make daily runs auditable.
- **Portability:** because everything external is behind an adapter and storage
  is a repository, moving to a hosted DB / multi-user later is additive.

---

## 9. Testing Strategy (summary — full tasks in `tasks.md`)

- **Deterministic, offline-first.** All unit tests use in-repo JSON/HTML
  fixtures via fixture `SourceAdapter`s and the Null/Haversine providers; no
  live network (requirement).
- **Coverage targets by module:**
  - Normalization: date/time parsing incl. bad input; food classification table.
  - Dedup: slight-name matches, same-time-different-event non-merge, recurring
    across days not merged.
  - Conflict resolution: authority precedence, recency tie-break, losers
    preserved, official-page override.
  - Ranking: full-meal > refreshments (AC-3), determinism (AC-2), weight config
    changes ordering predictably, unknown-walking fallback (AC-8).
  - Missing data: null location, missing times, broken RSVP link.
  - Updates & history: time/venue change appends history in place (AC-11).
  - Cancellation: state transition + segregation (AC-12).
  - Idempotency: re-run creates no duplicates / duplicate history (AC-10).
- **Fixtures:** a realistic corpus (multi-source pizza night, dinner-with-menu
  vs refreshments, conflicting times, cancelled event, calendar-only event,
  unparseable page) reused across suites.
