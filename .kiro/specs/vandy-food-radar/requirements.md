# Vandy Food Radar — Requirements

## 1. Overview

Vandy Food Radar is a lightweight, single-user personal tool for a Vanderbilt
student that:

1. **Discovers** upcoming campus events that offer free food.
2. **Normalizes** event data from multiple, potentially inconsistent sources.
3. **Deduplicates** events that appear in more than one source.
4. **Verifies** event details by cross-checking sources and, when possible,
   the official/linked event page.
5. **Ranks** events by how worthwhile they are to attend (food value +
   convenience + confidence).
6. **Displays** a dense, clear, ranked list focused on the next calendar day.

The MVP boundary is the pipeline **Discover → Normalize → Deduplicate →
Verify → Rank → Display**. Calendar writing, scheduled automation, and a live
maps provider are designed for but delivered as follow-on integration tasks.

### Non-goals (MVP)

Authentication, multi-user accounts, social features, reviews, chat, ML-based
recommendation, user profiles, payments, public event submission, native
mobile apps, and a general Vanderbilt event platform are explicitly **out of
scope**. They may appear only as documented future extensions.

### Guiding principles

- Single-user now, but the data model and architecture must make multi-user a
  later additive change, not a rewrite.
- Every external service (event sources, Google Calendar, maps) sits behind an
  adapter/interface.
- Ranking and normalization must be **deterministic** and testable without live
  network access.
- The user must always be able to understand **why** an event is ranked where
  it is and how confident the tool is in the data.

---

## 2. User Stories

- **US-1 — Daily digest.** As a hungry student, I want to see tomorrow's
  free-food events in ranked order so I can decide where to go without checking
  several calendars myself.
- **US-2 — Trust the data.** As a user, I want each event to show a
  verification status and the sources it came from so I can judge how much to
  trust it.
- **US-3 — Understand the ranking.** As a user, I want a short plain-language
  explanation of why an event ranks where it does so the list feels
  transparent, not magic.
- **US-4 — Full meal first.** As a user, I want events offering a confirmed
  full meal to rank above vague "refreshments provided" events so I spend my
  time on the best food.
- **US-5 — See conflicts.** As a user, I want to know when sources disagree
  (e.g., different times or "free food" claimed on one source only) so I am not
  misled.
- **US-6 — Convenience.** As a user, I want to know roughly how far/long a walk
  each event is from a reference location I configure so I can weigh effort vs.
  reward.
- **US-7 — Configurable home base.** As a user, I want to set my reference
  location (e.g., my dorm) rather than have it hard-coded.
- **US-8 — Handle RSVP.** As a user, I want to know whether an event requires
  RSVP and whether the RSVP link still works so I do not show up to nothing.
- **US-9 — Add to calendar (future).** As a user, I want to add a chosen event
  to my Google Calendar so I do not forget it. (Deferred integration.)
- **US-10 — Fresh automatically (future).** As a user, I want a daily job to
  refresh tomorrow's events, catch late additions, and detect
  cancellations/changes so the list stays current without manual re-runs.
- **US-11 — History.** As a user, I want to see when an event's details changed
  (time moved, venue changed, cancelled) so I can trust updates.

---

## 3. Functional Requirements

Requirements use RFC-2119 keywords. Each is testable and traced in `tasks.md`.

### 3.1 Source ingestion

- **FR-1** The system SHALL ingest events from **Anchor Link**, filtered to the
  "Free Food" perk.
- **FR-2** The system SHALL ingest events from a configured **Google Calendar**
  of Vanderbilt free-food events.
- **FR-3** When an event provides an **official/linked source page**, the
  system SHALL be able to fetch it to verify details (time, location, RSVP,
  food).
- **FR-4** Each source SHALL be implemented behind a common `SourceAdapter`
  interface so sources can be added, replaced, or disabled without changing
  core logic.
- **FR-5** For every ingested event the system SHALL record: the raw source
  payload, the source identifier, the source URL(s), and a
  `checked_at` timestamp.
- **FR-6** Ingestion SHALL default to the **next calendar day** window
  (configurable), computed in the configured local timezone.
- **FR-7** If a source page cannot be fetched or parsed, ingestion SHALL record
  a `parse_error` for that item and continue processing other items (fail
  soft, never crash the run).

### 3.2 Normalization

- **FR-8** The system SHALL normalize each source record into a canonical event
  shape with the fields: title, date, start time, end time, location,
  organizer, RSVP requirement, event URL, free-food-confirmed flag, and
  food type/menu (all nullable where unknown).
- **FR-9** Normalization SHALL preserve the **original per-source values**
  alongside the normalized values (no lossy overwrite).
- **FR-10** Normalization SHALL parse dates/times into timezone-aware values in
  the configured timezone and SHALL flag unparseable values rather than
  discarding them.
- **FR-11** Normalization SHALL classify the food signal into at least:
  `full_meal`, `snacks_or_refreshments`, `unspecified`, `none/unconfirmed`,
  using a documented keyword/heuristic mapping.

### 3.3 Deduplication

- **FR-12** The system SHALL detect probable duplicate events across sources
  even when titles differ slightly.
- **FR-13** Duplicate detection SHALL use a deterministic similarity score
  combining normalized title similarity, date match, time proximity, and
  location/organizer similarity, with a documented threshold.
- **FR-14** When records are judged duplicates, the system SHALL **merge** them
  into one canonical event that links back to every contributing source record.
- **FR-15** Deduplication SHALL be conservative: borderline matches SHALL be
  merged but flagged (`possible_duplicate`) rather than silently collapsed or
  silently kept separate.

### 3.4 Verification & conflict resolution

- **FR-16** For each canonical field, the system SHALL cross-check values from
  all contributing sources.
- **FR-17** When sources agree, the field SHALL be marked `verified`.
- **FR-18** When sources disagree, the system SHALL select the value from the
  **most authoritative** source, break ties by **most recently updated**, and
  SHALL record the conflict (all competing values + their sources) rather than
  discarding the losers.
- **FR-19** Source authority SHALL follow a documented, configurable precedence
  (default: official/linked event page > Anchor Link > Google Calendar).
- **FR-20** The system SHALL assign each event an overall **verification
  state**: `verified`, `partially_verified`, `conflicting`,
  `food_unconfirmed`, or `cancelled`.
- **FR-21** The system SHALL treat a "free food" claim present on one source but
  absent/contradicted on another as a conflict and reflect it in the food
  confirmation status and confidence.

### 3.5 Ranking

- **FR-22** The system SHALL compute a **transparent, rule-based score** (no
  opaque ML) for each event.
- **FR-23** The score SHALL consider at least: food confirmed, full-meal vs.
  snacks, food-description specificity/quality, RSVP requirement & likelihood
  of getting food, event timing, walking convenience from the reference
  location, and confidence in the information.
- **FR-24** The system SHALL store the **component breakdown** of every score
  (each factor's contribution) alongside the total.
- **FR-25** The system SHALL produce a short human-readable **explanation** of
  each event's ranking derived from its component breakdown.
- **FR-26** Given the same inputs, ranking SHALL be **deterministic** (stable
  ordering, documented tie-breaks).
- **FR-27** All weights and thresholds SHALL be configurable in one place, not
  scattered as magic numbers.

### 3.6 Location & walking convenience

- **FR-28** The reference location SHALL be **configurable** (never
  hard-coded).
- **FR-29** Walking distance/time SHALL be produced behind a
  `LocationProvider` interface so a maps API can be added/replaced later.
- **FR-30** The MVP SHALL ship a **fallback provider** (e.g., straight-line
  distance from static campus coordinates, or "unknown") so the system works
  with **no live maps API**; unknown walking time SHALL degrade gracefully and
  not zero out the whole score.

### 3.7 Persistence

- **FR-31** The system SHALL persist canonical events, per-source original
  records, source URLs, per-source `checked_at` timestamps, verification state,
  detected conflicts, ranking score, score components, and an event-change
  history.
- **FR-32** Persistence SHALL retain enough source detail to **reconstruct/
  explain** how each normalized field value was chosen.
- **FR-33** Storage SHALL be behind a repository interface so the backing store
  can change without touching business logic.

### 3.8 Presentation (Web UI)

- **FR-34** The main page SHALL show the **next day's** events in **ranked
  order**.
- **FR-35** Each event card SHALL display: title, time, location, food
  description, RSVP status, walking time (if available), source links,
  confidence/verification status, and the ranking explanation.
- **FR-36** The UI SHALL visibly distinguish the states: `verified`,
  `partially_verified`, `conflicting`, `food_unconfirmed`, and
  `cancelled/unavailable`.
- **FR-37** The UI SHALL prioritize **information density and clarity** over
  visual complexity.
- **FR-38** The UI SHALL allow the user to view the recorded conflicts for an
  event (e.g., an expandable detail).

### 3.9 Calendar integration (deferred)

- **FR-39** The system SHALL be designed so a **selected** event can later be
  written to Google Calendar via a `CalendarProvider` interface.
- **FR-40** The system SHALL NOT auto-add discovered events; adding SHALL be an
  explicit user action.

### 3.10 Automation / scheduled run (deferred)

- **FR-41** The system SHALL support a scheduled daily run that: fetches the
  next day's events, refreshes existing event info, discovers newly added
  events, detects cancellations/changes, and recalculates ranking.
- **FR-42** The scheduled run SHALL be **idempotent**: re-running for the same
  day SHALL update in place and SHALL NOT create duplicate records.
- **FR-43** The scheduled run SHALL append to event history when a tracked
  detail changes (time, venue, cancellation, food status).

---

## 4. Acceptance Criteria

Written in Given/When/Then. These are the concrete, testable checks.

### AC-1 Daily ranked list (FR-1, FR-2, FR-34, FR-35)
- **Given** at least one free-food event exists in Anchor Link and/or the
  Google Calendar for tomorrow,
- **When** the user opens the main page,
- **Then** those events appear as cards for tomorrow's date, sorted by ranking
  score descending, each showing title, time, location, food description, RSVP
  status, walking time (or "walking time unavailable"), source links,
  verification status, and a ranking explanation.

### AC-2 Deterministic ranking (FR-22, FR-26)
- **Given** a fixed set of normalized event fixtures,
- **When** ranking runs twice,
- **Then** the scores, component breakdowns, and ordering are identical both
  times.

### AC-3 Full meal beats refreshments (US-4, FR-23)
- **Given** Event A ("Dinner — confirmed menu: tacos, rice, beans") and Event B
  ("Refreshments provided"), equal on all other factors,
- **When** ranking runs,
- **Then** Event A scores higher than Event B, and the explanation for A cites
  the confirmed full meal / specific menu.

### AC-4 Cross-source dedup (FR-12–FR-15)
- **Given** the same event appears in Anchor Link as "Free Pizza Night" and in
  the Calendar as "Pizza Night (Free!)" on the same date/time/venue,
- **When** the pipeline runs,
- **Then** exactly one canonical event is produced, linked to both source
  records.

### AC-5 Conflict resolution keeps losers (FR-16–FR-19, FR-38)
- **Given** Anchor Link says start 6:00 PM and the Calendar says 6:30 PM for the
  same event, and the linked official page says 6:00 PM,
- **When** the pipeline runs,
- **Then** the canonical start time is 6:00 PM (from the higher-authority
  official page), the event is flagged `conflicting`, and the 6:30 PM value is
  retained in the recorded conflicts and viewable in the UI.

### AC-6 Free-food disagreement (FR-21)
- **Given** one source explicitly confirms free food and another does not
  mention it,
- **When** the pipeline runs,
- **Then** food-confirmation is not treated as fully verified, confidence is
  reduced, and the event shows `food_unconfirmed` or `conflicting` as
  appropriate.

### AC-7 Configurable reference location (FR-28)
- **Given** the user changes the reference location in config,
- **When** the pipeline recomputes,
- **Then** walking convenience contributions and displayed walking times change
  accordingly (relative ordering of near vs. far events reflects the new
  origin).

### AC-8 No maps API fallback (FR-30)
- **Given** no live maps provider is configured,
- **When** the pipeline runs,
- **Then** events still get scored and displayed, walking time shows as
  unavailable (or a coarse straight-line estimate), and ranking does not crash
  or collapse to zero.

### AC-9 Parse failure is soft (FR-7)
- **Given** a linked source page returns an error or unparseable HTML,
- **When** verification runs,
- **Then** the event is still produced from remaining sources, its verification
  reflects the missing check, and a `parse_error` is recorded — the run
  completes.

### AC-10 Idempotent scheduled run (FR-42, deferred)
- **Given** the scheduled run has already processed tomorrow,
- **When** it runs again for the same day with unchanged sources,
- **Then** no new canonical records are created and no duplicate history entries
  are appended.

### AC-11 Change history (FR-43, US-11)
- **Given** an event whose start time changes between two runs,
- **When** the second run processes it,
- **Then** the canonical record updates in place and a history entry records the
  old → new time with a timestamp.

### AC-12 Cancellation (edge case)
- **Given** an event that was present is later marked cancelled on an
  authoritative source,
- **When** the pipeline runs,
- **Then** its verification state becomes `cancelled`, it is visibly marked in
  the UI, and it is deprioritized/segregated rather than deleted.

---

## 5. Important Edge Cases (explicitly addressed)

| # | Edge case | Required behavior |
|---|-----------|-------------------|
| E-1 | Same event, slightly different names across sources | Detected as duplicate via fuzzy title + date/time/venue match (FR-12–FR-14); merged into one canonical event. |
| E-2 | Time change between runs | Update canonical in place; append history entry old→new; if sources currently disagree, flag `conflicting` (AC-11, FR-43). |
| E-3 | Room / venue change | Same as E-2 for location field; history entry recorded. |
| E-4 | Cancelled event | State `cancelled`; kept and marked, not silently dropped (AC-12). |
| E-5 | Free food on one source but not another | Treat as conflict; reduce confidence; `food_unconfirmed`/`conflicting` (AC-6, FR-21). |
| E-6 | Vague descriptions ("refreshments") | Classify as `snacks_or_refreshments`; lower food-value score; explanation notes vagueness (FR-11, AC-3). |
| E-7 | Events requiring RSVP | Detect and display RSVP requirement; factor RSVP likelihood into score (FR-23, US-8). |
| E-8 | RSVP link unavailable | Mark RSVP link broken; reduce RSVP-success factor & confidence; still show event. |
| E-9 | Events added late | Discovered on next ingestion/scheduled run; inserted without duplicating existing (FR-41, FR-42). |
| E-10 | Recurring events | Each occurrence treated as a distinct dated event; dedup keyed on date so occurrences are not merged across days. |
| E-11 | Source page cannot be parsed | `parse_error` recorded; event still produced from other sources; verification reflects gap (FR-7, AC-9). |
| E-12 | Missing location | Location null; walking convenience marked unavailable; verification `partially_verified`; event still shown. |
| E-13 | Multiple events at the same time | Both ranked and shown; ordering falls to score then documented tie-break; UI does not hide either. |
| E-14 | Calendar event with no Anchor Link page | Fully supported; produced from the calendar source alone with correspondingly limited verification. |

---

## 6. Configuration Requirements

- **CFG-1** Timezone (default America/Chicago).
- **CFG-2** Target day/window (default: next calendar day).
- **CFG-3** Reference location (coordinates and/or campus label).
- **CFG-4** Source enable/disable flags and per-source credentials/URLs
  (Anchor Link query, Google Calendar ID/key).
- **CFG-5** Authority precedence order for conflict resolution.
- **CFG-6** Ranking weights and thresholds (single config block).
- **CFG-7** Dedup similarity thresholds.
- **CFG-8** Active `LocationProvider` and `CalendarProvider` selection.

All configuration SHALL be external to code (env/config file) with sane
defaults so the tool runs out of the box in offline/fixture mode.
