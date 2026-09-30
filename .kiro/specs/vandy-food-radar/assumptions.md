# Vandy Food Radar — Assumptions

Assumptions made while writing this spec. None of these, on their own, changes
the architecture (which is why I proceeded rather than asking). They are called
out so they can be corrected cheaply.

1. **Stack.** Python 3.11+ with a minimal server-rendered web layer (FastAPI/
   Flask + Jinja) and SQLite via a repository interface. The design is
   interface-driven and language-agnostic; Node/TypeScript would work equally
   well. Changing the stack does not change the component boundaries.

2. **Timezone.** Default `America/Chicago` (Vanderbilt / Nashville). Configurable
   (CFG-1).

3. **"Next calendar day."** Interpreted as the full local calendar day after
   today (midnight→midnight in the configured tz). Window is configurable
   (CFG-2).

4. **Authority precedence.** Default: official/linked event page > Anchor Link >
   Google Calendar. Configurable (CFG-5). This encodes "prefer the most
   authoritative and most recently updated official source."

5. **Recency signal.** Conflict tie-breaks use each source's own
   last-modified/updated timestamp when exposed; when a source does not expose
   one, `checked_at` is used as a fallback and this is noted in the conflict
   record.

6. **Google Calendar access.** MVP reads a calendar the user can access via API
   key or OAuth; the specific auth method is a config concern, not an
   architectural one. Calendar **writing** is deferred (M8).

7. **Maps.** MVP ships with no paid maps dependency. `HaversineLocationProvider`
   (straight-line distance from static campus coordinates) and a `Null`
   provider satisfy FR-30 offline. A real maps provider is M9. Walking-time
   "unknown" contributes a neutral value so it never zeroes an event's score.

8. **Anchor Link retrieval.** Assumed reachable via its events listing/feed with
   a Free Food perk filter. Whether that is an API, feed, or HTML scrape is an
   adapter implementation detail; the `SourceAdapter` interface + `HttpFetcher`
   isolate it, and fixtures make the rest of the system testable regardless.

9. **Food classification.** A documented keyword/heuristic table (not ML) maps
   descriptions to `full_meal` / `snacks_or_refreshments` / `unspecified` /
   `none`. The exact keyword lists are tunable in config/code and covered by
   tests; the classification approach is fixed, the vocabulary is not.

10. **Ranking weights.** The default weights in `design.md` §6.1 are a
    reasonable starting point that produces the required "dinner-with-menu >
    refreshments" behavior. They are all configurable (CFG-6) and expected to be
    tuned with real data.

11. **Recurring events.** Treated as independent per-date occurrences; dedup
    blocks on `event_date`, so occurrences are never merged across days.

12. **Single-user now.** No auth/accounts. Multi-user is enabled later by an
    additive `owner_id`/workspace on `Event` and config — no core rewrite.

13. **Cancelled events retained.** Cancelled events are kept, marked, and
    segregated/deprioritized rather than deleted, so the change is visible and
    auditable.

## Open questions (would only matter if answered a specific way)

These do **not** block implementation; defaults are chosen above.

- Exact Anchor Link access mechanism (official API vs. scrape) — affects only
  the `AnchorLinkAdapter` internals.
- Which maps provider (if any) you want first for M9 — affects only that one
  provider class.
- Preferred good/bad **timing windows** for the ranking `timing` factor (e.g.,
  is a late-night event penalized?) — a config value, easily changed.
