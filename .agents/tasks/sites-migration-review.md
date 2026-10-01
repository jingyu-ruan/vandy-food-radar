# Sites migration review

The migration source is in `sites/`, a separate Sites-owned Git checkout. Site ID:
`appgprj_6abda08653248191bd4377356f3e0a33`. The source commit submitted for publication
is `a3ab09abecb55e0cb158fddf67c72542ba492e0e`.

Kiro CLI with Claude Opus 5 authored the migration and implemented review findings.
Codex reviewed the implementation and performed independent data and SQL checks.

## Architecture

- React/Vinext page and API run as one Sites Worker.
- D1 stores published feeds, raw sources, field provenance, scoring, conflicts,
  change history, refresh runs, and the refresh lease.
- A protected `POST /api/refresh` fetches real public AnchorLink data and publishes
  a complete target day in one transaction. GET requests read durable data.
- Publication checks the lease holder inside its transaction. A superseded slow
  publisher is rejected, preserving the newer publication.
- Feed metadata and child records are read in one transaction.
- Calendar actions export `.ics` files, which the user imports explicitly.
- The Chicago next-day target and original seven ranking factors are retained.

## Validation

- 87 offline tests pass, including real SQLite migrations, rollback, lease loss,
  consistent snapshots, unique provider identities, strict timestamps, and ICS.
- Lint, TypeScript typecheck, and the Worker build pass.
- A captured real AnchorLink response produces the same 9 source URLs, food
  classifications, confidence values, verification states, and 63 numeric score
  factors as the original Python pipeline, with matching rank order.
- A separate real SQL check pauses worker A, lets worker B publish, resumes A,
  and verifies A is rejected while B's location remains stored.
- Local Worker API refresh returns 9 events; GET reads them back, and calendar
  download returns a correctly framed `text/calendar` attachment.

## Publication

The installed Sites publishing helper disappeared during the session, and the
Codex marketplace could not restore that package. Native Sites APIs remained
available. Source was pushed using a short-lived repository credential supplied
through hidden stdin; the remote commit was verified. The native private publish
API built that source remotely, without a local archive, and publication succeeded.

Production URL: https://vandy-food-radar.rjy020128.chatgpt.site
Deployment: `appgdep_6abdad263c94819199e8c527a87182b1` (succeeded).
The Site remains owner-private. Hosted refresh, database readback, health, and
calendar download all returned HTTP 200. The persisted listing contains 9 real
October 1, 2026 activities and matches all 63 ranking factors and their order
from the Python pipeline.

## Automatic updates

Sites rejected native task creation because the account already uses the plan's
five scheduled-task slots. Existing user tasks were preserved. The original
GitHub hourly workflow now calls this Site at minute 17 and then verifies the
published date, timezone, freshness, count, and durable readback. The workflow
rejects redirects and keeps its Site service credential in repository secrets.
GitHub provides only the timer; all processing and storage run on Sites.

First hosted workflow run succeeded:
https://github.com/jingyu-ruan/vandy-food-radar/actions/runs/36798981562
At 2026-10-01T01:00:33.027Z it published and read back 9 events for October 1;
all 9 were unchanged, with no new, cancelled, time-changed, or venue-changed
records. The workflow commit is `aebeb73132fe0dce8708c20cee9d0ab87480b964`.

The original Python/Vercel deployment and its credentials remain available as a
rollback option. Frontend redesign is deferred following the user's instruction.
The temporary local preview was stopped after production verification.
