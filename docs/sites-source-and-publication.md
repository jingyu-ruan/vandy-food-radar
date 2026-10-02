# Sites source and publication

The root of this repository retains the Python application. The ordinary `sites/`
directory contains the complete React/Vinext Worker application, locked dependencies,
D1 migrations, browser modules, campus dataset, and tests. A GitHub clone includes
all source files without a second repository login.

The live Site has a separate Sites-managed Git repository:

- Site project: `appgprj_6abda08653248191bd4377356f3e0a33`
- Production URL: https://vandy-food-radar.rjy020128.chatgpt.site
- Access: owner-private

## Release sequence

1. Open the existing Sites-owned checkout and validate the changes using the
   commands in `sites/README.md`. Preserve applied migrations; add a new delta
   for a schema change.
2. Synchronize all source additions, edits, and removals into GitHub's ordinary
   `sites/` directory. Commit and push GitHub first.
3. Build the same source through the bundled Sites workflow, commit and push it
   to the Site's own repository, and package the output from that exact commit.
4. Save and deploy that commit and archive through Sites, preserving owner-only
   access. Check the deployment status until it reaches a terminal state.
5. Compare the Sites source commit's tree with GitHub's `HEAD:sites` tree. These
   trees must match byte for byte, including file modes. The commit hashes differ
   because GitHub contains the larger Python repository and release records.

A GitHub push stores source. Sites publication rebuilds the deployed application.
The existing GitHub workflow refreshes data on the published application and
verifies each date's durable readback. Runtime secrets and production D1 data live
separately from both source repositories.

## Workspace publication on October 2, 2026

The GitHub implementation commit is
`d125b03d4466dd46da4b930c2738306ea9121192`. It was pushed before the Sites release.
Sites source commit `1b96f892efdac72efd6c6d2859a7326b0d0ee9cd` was packaged locally
and deployed successfully under owner-private access. Both source trees equal
`709dd281b1da6de5e4d69c3cf8d49cb0f314f4e5`.

- Saved version: `appgprj_6abda08653248191bd4377356f3e0a33~appgver_5507dd24f75c81919f0bba676f821976`
- Deployment: `appgdep_6ac03ee348a08191946cb31ca1d45ed3`
- Validation: 327 Python tests, 106 Sites tests, browser itinerary checks,
  TypeScript checking, lint with zero errors, and a successful Sites build.

## Previous publication baseline

The original migration published version 1 from Sites source commit
`a3ab09abecb55e0cb158fddf67c72542ba492e0e`, with source tree
`8cc3d8d68c10936a4325f407a1c761ef5ad8fa58`. GitHub retained that tree before
this workspace update. These identifiers describe the previous baseline.

## Runtime operation

The workflow refreshes two days every two hours at minute 17, and seven days every
six hours at minute 47. It holds `VFR_SITES_SERVICE_TOKEN` in GitHub secrets and
sends that token only to the fixed Site origin. Service-token rotation requires
updating the repository secret. The existing native Sites automation remains
paused; the GitHub workflow provides the active schedule.

`sites/.openai/hosting.json` identifies the existing Site. Reuse that project ID
when preparing a Sites-owned checkout and preserve the current audience.
Local secrets, captured live data, logs, dependencies, build artifacts, runtime
state, and Git metadata are excluded from source synchronization.
