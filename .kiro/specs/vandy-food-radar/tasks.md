# Vandy Food Radar — Implementation Tasks

Tasks are grouped into milestones. Each task lists the requirements it
satisfies (from `requirements.md`) and is tagged **[MVP]** or **[Later]**.
The MVP milestones (M0–M6) deliver the pipeline
**Discover → Normalize → Deduplicate → Verify → Rank → Display**. Milestones
M7–M9 are designed-for-now, built-later.

Ordering is dependency-driven: foundation → domain → pipeline stages → UI →
integrations.

---

## Milestone M0 — Project foundation **[MVP]**

- [x] **T0.1** Initialize repo, chosen stack (Python 3.11+), linting/formatting,
  test runner, and CI-ready `make test`. — *supports all*
- [x] **T0.2** Define the config module with defaults and offline mode:
  timezone, target window, reference location, source flags/creds, authority
  precedence, ranking weights, dedup thresholds, provider selection.
  — *CFG-1…CFG-8*
- [x] **T0.3** Define domain models: `Event`, `SourceRecord`,
  `FieldProvenance`, `Conflict`, `ScoreComponent`, `EventHistory`.
  — *FR-8, FR-31, FR-32*
- [x] **T0.4** Create the realistic **fixture corpus** (multi-source pizza
  night; dinner-with-menu vs refreshments; conflicting times; cancelled;
  calendar-only; unparseable page). — *Testing requirement*

## Milestone M1 — Persistence **[MVP]**

- [ ] **T1.1** Define `Repository` interface (save/upsert, get-for-day,
  find-by-dedup-key, append-history, get-conflicts, get-score-components).
  — *FR-33*
- [ ] **T1.2** Implement SQLite repository with schema for all entities incl.
  raw payloads, per-source `checked_at`, conflicts, score components, history.
  — *FR-31, FR-32*
- [ ] **T1.3** Repository tests: round-trip, upsert idempotency by `dedup_key`,
  history append. — *FR-42, AC-10*

## Milestone M2 — Source ingestion (Discover) **[MVP]**

- [ ] **T2.1** Define `SourceAdapter` interface + injected `HttpFetcher`
  (timeouts/retries, fixture-swappable). — *FR-4, FR-7*
- [ ] **T2.2** `AnchorLinkAdapter` filtered by the Free Food perk; returns raw
  payload + parsed view + `checked_at` + `parse_status`. — *FR-1, FR-5*
- [ ] **T2.3** `GoogleCalendarAdapter` for the configured calendar.
  — *FR-2, FR-5, E-14*
- [ ] **T2.4** `OfficialPageFetcher` for linked source pages (used by verify).
  — *FR-3*
- [ ] **T2.5** Soft-failure handling: `fetch_error`/`parse_error` recorded, run
  continues. — *FR-7, AC-9, E-11*
- [ ] **T2.6** Adapter tests against fixtures (no live network). — *Testing*

## Milestone M3 — Normalization **[MVP]**

- [ ] **T3.1** Normalizer: source parsed fields → canonical shape; preserve
  originals per source. — *FR-8, FR-9*
- [ ] **T3.2** Timezone-aware date/time parsing; flag unparseable, do not drop.
  — *FR-10, E-12*
- [ ] **T3.3** Food classifier (keyword table → `food_category`,
  `food_confirmed`): full_meal / snacks_or_refreshments / unspecified / none.
  — *FR-11, E-6*
- [ ] **T3.4** Normalization tests incl. bad dates, vague food text, missing
  fields. — *Testing, E-6, E-12*

## Milestone M4 — Deduplication **[MVP]**

- [ ] **T4.1** Similarity function (title/time/location/organizer) with
  configurable weights; blocking by `event_date`. — *FR-13, E-1, E-10*
- [ ] **T4.2** Merge logic → single `Event` linking all `SourceRecord`s;
  `possible_duplicate` flag for borderline. — *FR-12, FR-14, FR-15*
- [ ] **T4.3** Deterministic `dedup_key` generation for idempotent upsert.
  — *FR-42*
- [ ] **T4.4** Dedup tests: slight-name merge (AC-4), same-time different events
  not merged (E-13), recurring across days not merged (E-10). — *Testing*

## Milestone M5 — Verification & conflict resolution (Verify) **[MVP]**

- [ ] **T5.1** Per-field cross-check with agreement detection + provenance.
  — *FR-16, FR-17*
- [ ] **T5.2** Conflict resolver: authority precedence, recency tie-break,
  preserve losing values as `Conflict`. — *FR-18, FR-19, AC-5*
- [ ] **T5.3** Official-page verification wired in with top authority; parse
  failures degrade gracefully. — *FR-3, FR-7, AC-9*
- [ ] **T5.4** Event-level `verification_state` + derived `confidence`; food
  disagreement handling. — *FR-20, FR-21, E-5, AC-6*
- [ ] **T5.5** Cancellation detection → `cancelled` state + history entry.
  — *E-4, AC-12*
- [ ] **T5.6** Verification tests: precedence, tie-break, losers preserved,
  food conflict, cancellation, RSVP link broken (E-8). — *Testing*

## Milestone M6 — Ranking + Web UI (Rank → Display) **[MVP]**

- [ ] **T6.1** `LocationProvider` interface + `Haversine` and `Null` providers;
  reference location from config; unknown-walking neutral default.
  — *FR-28, FR-29, FR-30, AC-7, AC-8*
- [ ] **T6.2** Ranking engine: weighted factor sum, store `ScoreComponent`
  breakdown, deterministic tie-breaks. — *FR-22, FR-23, FR-24, FR-26, FR-27*
- [ ] **T6.3** Explanation generator from score components. — *FR-25, US-3*
- [ ] **T6.4** Ranking tests: full-meal>refreshments (AC-3), determinism
  (AC-2), weight-change reorders, unknown-walking fallback (AC-8). — *Testing*
- [ ] **T6.5** Pipeline orchestrator: ingest→normalize→dedup→verify→score→save,
  idempotent upsert + history diff. — *FR-41(shape), FR-42, FR-43, AC-11*
- [ ] **T6.6** Server-rendered main page: next-day ranked cards with title,
  time, location, food, RSVP, walking time, source links, verification badge,
  ranking explanation; expandable conflicts. — *FR-34, FR-35, FR-36, FR-38*
- [ ] **T6.7** State styling: verified / partially_verified / conflicting /
  food_unconfirmed / cancelled; density-first layout. — *FR-36, FR-37*
- [ ] **T6.8** "Refresh now" action invoking the pipeline for tomorrow.
  — *FR-41(shape)*
- [ ] **T6.9** End-to-end pipeline test over the fixture corpus asserting the
  full Discover→Display path and expected ordering/states. — *Testing, AC-1*

### ✅ MVP complete at end of M6.

---

## Milestone M7 — Scheduled automation **[Later]**

- [ ] **T7.1** Daily scheduler (cron/APScheduler) invoking `pipeline.run()` for
  tomorrow. — *FR-41*
- [ ] **T7.2** Verify idempotency & change detection across real re-runs (late
  additions E-9, time/venue changes E-2/E-3, cancellations E-4). — *FR-42,
  FR-43, AC-10, AC-11*
- [ ] **T7.3** Structured run log (fetched/merged/conflicts/cancelled/scored).
  — *Deployment/observability*

## Milestone M8 — Google Calendar write integration **[Later]**

- [ ] **T8.1** `CalendarProvider` interface (already declared) →
  `GoogleCalendarWriter` (OAuth, add selected event only, no auto-add).
  — *FR-39, FR-40, US-9*
- [ ] **T8.2** UI "Add to Calendar" action on an event; idempotent (no dup
  calendar entries). — *FR-40*
- [ ] **T8.3** Integration tests with a mocked calendar client. — *Testing*

## Milestone M9 — Live maps provider **[Later]**

- [ ] **T9.1** `GoogleMapsLocationProvider` (or alternative) behind the existing
  `LocationProvider` interface; config toggle. — *FR-29*
- [ ] **T9.2** Real walking-time display + caching; graceful fallback to
  Haversine/Null on failure. — *FR-30*

---

## Future extensions (out of MVP scope — noted only)

Multi-user (`owner_id`/workspace, per-user config), additional sources,
richer notifications/digest email. **Not** planned: social, reviews, chat, ML
recommendation, payments, public submission, native mobile.

---

## Requirements → Task traceability (key items)

| Requirement | Task(s) |
|---|---|
| FR-1/FR-2/FR-3 sources | T2.2, T2.3, T2.4 |
| FR-7 soft parse failure | T2.5, T5.3 |
| FR-8–FR-11 normalization | T3.1–T3.4 |
| FR-12–FR-15 dedup | T4.1–T4.4 |
| FR-16–FR-21 verify/conflict | T5.1–T5.6 |
| FR-22–FR-27 ranking | T6.1–T6.4 |
| FR-28–FR-30 location | T6.1 |
| FR-31–FR-33 persistence | T1.1–T1.3, T0.3 |
| FR-34–FR-38 UI | T6.6–T6.7 |
| FR-39/FR-40 calendar | T8.1–T8.2 |
| FR-41–FR-43 automation | T6.5, T7.1–T7.2 |
| Testing strategy | T0.4, and *tests* subtask in every milestone |
