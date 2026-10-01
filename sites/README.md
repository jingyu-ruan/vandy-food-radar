# Vandy Food Radar

Ranked Vanderbilt events advertising free food, for one target day. The pipeline
is Discover → Normalize → Deduplicate → Verify → Rank → Display, and it is
**live-only**: there is no fixture corpus, no sample data, and no fallback. If
nothing has been published the page says so; if storage cannot be read it says
that instead of showing an empty day.

The single source is the Vanderbilt AnchorLink discovery API
(`/api/discovery/event/search` with `benefitNames=FreeFood`). A row is accepted
only when it carries the exact `Free Food` benefit, is `Approved` and `Public`,
matches institution 24 / branch 56623, has a numeric API-returned id, and starts
on the target local date without having already ended. Event links are built
only from ids the API returned. Descriptions are reduced to plain text.

## Layout

| Path | Purpose |
| --- | --- |
| `lib/vfr/` | The pipeline: source adapter, normalize, dedup, verify, rank, repository, read model, auth. |
| `db/schema.ts`, `drizzle/` | Drizzle schema and the generated migrations. |
| `app/` | Server-rendered page and the API routes. |
| `tests/` | Offline tests, including real-SQL checks over `node:sqlite`. |

## Commands

```sh
npm run install:ci   # one locked dependency install
npm test             # 87 tests, no network
npm run lint
npm run typecheck
npm run build
npm run db:generate  # regenerate migrations after editing db/schema.ts
```

Tests run under Node's strip-only TypeScript loader, so the source avoids
non-erasable syntax (parameter properties, `enum`, namespaces). `tsconfig.json`
sets `erasableSyntaxOnly` so a regression fails typecheck rather than the test
run.

Applied migrations are immutable. A schema change means a new numbered delta from
`npm run db:generate`, never an edit to an existing file.

## Refresh and unattended operation

`POST /api/refresh` is the primary writer. The token-protected `/cron/refresh` compatibility route also writes. One run fetches every source
page, computes the whole day in memory, and publishes it in a single D1 batch, so
a source outage or a storage failure leaves the previously published feed exactly
as it was. A successful response with zero events is a real empty day.

Concurrency is handled by a persistent lease with an expiry:

- The claim is conditional in SQL, so two overlapping refreshes cannot both
  proceed.
- The holder is re-validated **inside** the publish transaction. The first
  statement writes `app_state.value` from a sub-select of the publisher's own
  lease row, and that column is `NOT NULL`, so a run that overran its lease and
  was superseded rolls back instead of overwriting the newer feed.
- A lease that expired but was never taken over and never released may still
  finish, so a slow-but-uncontested run is not thrown away.

For the Site-linked hourly cloud task:

1. Reopen Site `appgprj_6abda08653248191bd4377356f3e0a33` through Sites
   `get_site`. Require an active published Site and use its current live URL.
2. Obtain the Site service-access token from that response. Keep the token in
   memory, send it only to this Site as `OAI-Sites-Authorization: Bearer <token>`,
   and never put it in source, prompts, URLs, or logs. This credential authorizes
   service access to shared Site data; it does not impersonate a visitor.
3. Send `POST /api/refresh`, then read `GET /api/events` using the same service
   header. Check the successful response and that the persisted target date is
   tomorrow in America/Chicago. A successful zero-event response is valid.
4. A `409` means a refresh is running; follow `Retry-After` for one bounded retry.
   A source or storage failure keeps the previous publication. Report an
   actionable failure or meaningful activity changes and stay quiet when the
   result is unchanged.

The inherited cadence is hourly at minute 17 in America/Chicago. Scheduling
updates data through this writer; it does not rebuild the Site. The optional
legacy `/cron/refresh` path additionally requires `Authorization: Bearer
<VFR_REFRESH_TOKEN>`, including for private Sites. `GET /api/health` reports
storage reachability, feed state, publication age, and the last run outcome.

## Owner-private assumptions

The deployment is owner-private: the hosting platform's dispatch layer authorizes
every inbound request before the Worker runs. `VFR_OWNER_PRIVATE=true` lets
`POST /api/refresh` rely on that boundary, narrowly:

- Only `POST /api/refresh`, never a GET, and never `/cron/refresh`.
- A configured `VFR_REFRESH_TOKEN` is always honoured and compared in constant
  time.
- Browser-originated mutations must carry a same-origin `Origin`. A service
  caller legitimately sends none, which is allowed; a foreign `Origin` is
  rejected, which is what blocks cross-site request forgery.
- With neither the flag nor a token the endpoint fails closed.

The bearer token is read from `Authorization` only. `OAI-Sites-Authorization` is
the platform's own service-access credential, checked and consumed by dispatch,
and is never compared against `VFR_REFRESH_TOKEN`. A service caller presenting
only that header still reaches refresh through the owner-private boundary.

If the Site is ever shared publicly, set `VFR_OWNER_PRIVATE=false` and configure
`VFR_REFRESH_TOKEN`.

## Configuration

Variables are read from the Worker environment; see `.dev.vars.example` for local
use and `lib/vfr/config.ts` for the full list and defaults. Every value has a
working default, and an unrecognized value falls back to it rather than throwing.
Common ones: `VFR_OWNER_PRIVATE`, `VFR_REFRESH_TOKEN` (or `CRON_SECRET`),
`VFR_TIMEZONE`, `VFR_TARGET_WINDOW`, `VFR_STALE_AFTER_HOURS`. Secrets live only
in the hosted environment or in `.dev.vars`, never in the repository.

Visitor-facing failures are plain: the page and the JSON routes say the listing
is temporarily unavailable. Storage diagnostics, including an unapplied
migration, go to the server log and `GET /api/health`, because a visitor cannot
act on a deployment fault.

## Local development

Use Node 24 for the test suite. Install the locked dependencies, copy
`.dev.vars.example` to ignored `.dev.vars`, and run `npm run build` once.
Apply pending local migrations in order, once each:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_harsh_banshee.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_common_black_knight.sql
npm run dev
```

Use the loopback URL printed by the server. `npm start` previews the built Worker
with the same local database. Production migrations are applied through Sites
publication. Runtime secrets belong in Sites environment settings.

## Migration adaptations

The React page, Worker API, and D1 persistence are hosted together on Sites.
Published snapshots, source payloads, per-field provenance, scoring, changes,
refresh logs, and leases are durable; the read path never triggers ingestion.
The original Python/Vercel checkout is retained separately as a rollback option.

The seven numeric ranking factors and their weights retain the original rules.
The description-detail label describes what the old specificity calculation
actually measures. A single AnchorLink source has confidence 0.30 and is marked
partially verified. Optional walking providers retain their configuration, with
unknown walks represented neutrally by default.

Calendar actions download one `.ics` file from `/api/calendar/<AnchorLink id>`.
The file contains the source URL and absolute event times. Importing the file is
an explicit action in the user's calendar app.
