# Sites source and publication

The GitHub repository contains the retained Python application at its root and
the complete migrated React/Vinext application in `sites/`. The latter is an
ordinary directory, not a submodule, so a GitHub clone includes its source,
locked dependencies, migrations, and tests without another repository login.

The live Site has a separate Sites-managed source repository. In the original
migration workspace, `sites/` also has its own local Git metadata. That metadata
is checkout-local and is excluded from the GitHub commit.

## Verified source correspondence

- Site: `appgprj_6abda08653248191bd4377356f3e0a33`
- Production URL: https://vandy-food-radar.rjy020128.chatgpt.site
- Published Sites version: 1
- Sites source commit: `a3ab09abecb55e0cb158fddf67c72542ba492e0e`
- Source tree: `8cc3d8d68c10936a4325f407a1c761ef5ad8fa58`

The GitHub `sites/` tree matches that published source tree byte for byte,
including file modes. The commits have different hashes because GitHub wraps
this source in the larger repository alongside the Python application,
workflow, and migration records.

## Future changes

1. Edit the Sites-owned checkout and validate the relevant changes using the
   commands in `sites/README.md`. Preserve applied database migrations and add
   a new delta when changing the schema.
2. Push the reviewed source to the Site's own repository and publish that exact
   source through Sites. Source pushes alone require an explicitly accepted
   Sites publish-on-push window to trigger automatic publication.
3. Synchronize the same source files, including additions and removals, into
   GitHub's ordinary `sites/` directory. Compare its tree hash with the published
   source tree, then commit and push the GitHub repository.

A push to this GitHub repository stores the source; it does not rebuild or
publish the Site. The existing GitHub hourly workflow only calls the already
published API and verifies durable readback. Sites holds runtime secrets and
production D1 data separately from either source repository.

When cloning GitHub elsewhere, `sites/.openai/hosting.json` identifies this
existing Site. Reuse that project ID when preparing a Sites-owned source
checkout; never register a replacement Site for this application. Preserve the
current private audience unless a sharing change has been explicitly requested.

The native hourly Sites task could not be created because the account's five
scheduled-task slots were occupied. The existing GitHub workflow supplies the
hourly timer at minute 17. Its `VFR_SITES_SERVICE_TOKEN` is held in GitHub secrets;
future service-token rotation requires updating that secret as well.

Local secrets, captured live data, runtime logs, dependency installations,
build artifacts, and Git metadata are excluded from source synchronization.
The three migration records under `.agents/tasks/sites-migration-*.md` document
the implementation request, review findings, and verification results.
