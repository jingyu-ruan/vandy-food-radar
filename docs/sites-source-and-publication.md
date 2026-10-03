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

## Frontend browsing refinements on October 2, 2026

GitHub implementation commit `0a3c2b7` was pushed before Sites publication.
Sites source commit `2f8ab6764cd2ea58911aa7d9855ae908845357cc` was built and
packaged locally, then deployed successfully with owner-private access. Its tree
matches GitHub's `sites/` tree: `dc22df453aa9e12343bb2991440ddffd70fbb85b`.

- Saved version: `appgprj_6abda08653248191bd4377356f3e0a33~appgver_2a828ebdd2308191880f255a6723dc40`
- Deployment: `appgdep_6ac0598b42708191a2de311c6d7a87ea`
- Validation: 110 Sites pipeline tests and 10 browser-module tests, TypeScript
  checking, successful production build, and local browser checks at 1366,
  390, and 320 pixels. Checked light and dark appearances, keyboard campus
  search, location settings focus, saved-state feedback, event and walking links,
  map selection mode, and repeated view switches.

The header location opens the origin settings and focuses campus search. Settings
uses a gear in the event toolbar, and My day has been removed. The week shows only
today and future dates; event rows open AnchorLink, with separate yellow save
stars and walking links. The map uses a desktop sidebar and a mobile overlay,
local campus searches, an event dropdown, and concise From/To labels. View
transitions slide horizontally and respect reduced motion.

## Event presentation and motion refinements on October 2, 2026

GitHub implementation commit `61190d2e53dc2a2ce10fef58290499632fbecec7` was
pushed before Sites publication. Sites source commit
`b9dbc4b4b54521537b142e6321d236f797513f0f` was built, packaged, and deployed
successfully. Both application source trees equal
`f0ed0be859d04cfb9b98c12f4d497fcd2725d569`.

- Saved version: `appgprj_6abda08653248191bd4377356f3e0a33~appgver_45580250538481918c3b7dae3a02cb25`
- Deployment: `appgdep_6ac078ff7d408191ab7f13972ba88b18`
- Validation: 110 Sites pipeline tests, 12 browser-module tests, TypeScript
  checking, and a successful production build. Browser checks covered 1366,
  390, and 320 pixels, light and dark appearances, both clock formats, footer
  alignment, full-width PHield Day food text, menu keyboard and touch-sized
  controls, save/unsave focus retention, Escape dismissal, walking URL endpoints,
  repeated view changes, snapshot cleanup, and map zoom retention.

Recommendation scores use labeled numbers; stars consistently denote saving.
Confirmed food badges read Meal, Snacks, or Free food. Twelve-hour whole-hour
labels omit `:00`. Event footer controls share a common height and alignment.
Week rows expose a contextual menu on hover or focus on desktops; its entrance
remains visible on narrow screens. Unresolved destinations remain address queries.

View changes use an interruptible critically damped spring that retains position
and velocity. A temporary inaccessible outgoing map snapshot avoids a blank
panel while the persistent live canvas changes hosts. The map warms its library
while idle, updates changed markers, retains cached tiles, and preserves its
camera across tab switches. The first loaded week is framed once.

The daily brief remains deterministic. Research and a proposed once-per-local-day
D1 cache are recorded in `docs/daily-brief-model-options.md`. No model billing,
inference credential, or new scheduled job was enabled in this release.

## Campus map colors on October 2, 2026

GitHub implementation commit `78b0e00` was pushed before Sites publication.
Sites source commit `28864c2f75c5c9862f037af994390d8ff886d173` was built,
packaged, and deployed successfully under the existing owner-private access.
Both application source trees equal `fab86c3548dcaf60d3a4ce3b1029da388e0194f7`.

- Saved version: `appgprj_6abda08653248191bd4377356f3e0a33~appgver_fd1190497a3481918982c8c09e072bcd`
- Deployment: `appgdep_6ac080980e6c8191b2869892319f355b`
- Validation: 122 Sites pipeline and browser-module tests, TypeScript checking,
  JavaScript syntax checks, a successful production build, and local visual
  checks of map loading, activity selection, gold saved markers, attribution,
  and 44-pixel zoom controls. Targeted runtime checks covered vector-asset,
  WebGL, and map-request failures falling back to standard OSM tiles.

The map uses an OpenFreeMap Liberty vector basemap with light neutral buildings,
natural green parks, and fewer low-priority labels. Leaflet retains selection,
markers, and controls; MapLibre renders the basemap. Blue activity markers, gold
saved markers, and a selection ring remain centered on their coordinates.
The previous grayscale filters were removed. CARTO was evaluated but required
an API key and returned placeholder tiles, so it was excluded from the release.

## Week event interactions on October 2, 2026

GitHub implementation commit `ffa9e13` was pushed before Sites publication.
Sites source commit `9bf0f7f83b5b46f79b8433c7af512ac8545c82e7` was built,
packaged, and deployed successfully under the existing owner-private access.
Both application source trees equal `a23ecd8f32d96969f1761c1ebbd6807098833410`.

- Saved version: `appgprj_6abda08653248191bd4377356f3e0a33~appgver_3a4dc2ced6f88191b9a8288c43e12c6e`
- Deployment: `appgdep_6ac0862a3ba08191898c3417c321c0f0`
- Validation: 122 existing pipeline and browser-module tests, final browser-module
  checks, TypeScript checking, lint with zero errors, JavaScript syntax checks,
  and successful production packaging. Browser checks covered 1366, 390, and
  320 pixels, both appearances, keyboard selection, repeated selection,
  save/unsave focus retention, single-menu expansion, Escape dismissal, menu URLs,
  unresolved-location feedback, and cross-date map selection.

Week rows select their map location; Source and Walking directions live in the
ellipsis menu. Saving displays a gold star immediately before the ellipsis,
and clicking that star unsaves. Hover and focus backgrounds cover the entire
row. Desktop columns use a 40/60 split, the first day has no top separator,
and the date input and outer display switch both measure 44 pixels tall.
Desktop selection preserves the browsing date; mobile selection loads the
event's date before showing the Map view. Location tooltips wrap long names.

## Responsive settings, rating, and map browsing on October 3, 2026

GitHub implementation commit `bc6c58606c37de8d6667905c53edb931e9f759b8`
was pushed before Sites publication. Sites source commit
`ff348e3e58edc7d46a034fcc77d05bf3430ed66e` was built, packaged, and deployed
successfully under the existing owner-private audience. Both application source
trees equal `643a883061f3764f0ca51168a3557194479a5e86`.

- Saved version: `appgprj_6abda08653248191bd4377356f3e0a33~appgver_b52258e8b3908191ba10ff3068b86da1`
- Deployment: `appgdep_6ac0930dde90819193e27f3154f6ae4b`
- Validation: 125 pipeline and browser-module tests, TypeScript checking,
  lint with zero errors, JavaScript syntax checks, and successful production
  packaging. Local production and development browser checks covered 1366,
  390, and 320 pixels, light/system and dark settings, fixed dialog headers,
  independent list scrolling, selection borders, keyboard origin search,
  mobile cross-date map selection, rating popup bounds, footer controls,
  page and segmented transitions, preserved list focus, and walking URL endpoints.

The header origin opens an independent campus picker. Long names truncate to one
line. Settings scroll inside a fixed header and use mobile form type of at least
16 pixels; closing restores focus and page position. The intermittent iPhone
zoom report was addressed through input sizing and focus/scroll handling, but
was not reproduced on a physical iPhone during this release.

Day event titles link to AnchorLink. Fact labels use matching type sizes and
functional icons; footer actions remain in one row at 320 pixels. Rating exposes
stored component weights, normalized values, contributions, and notes without
recalculating the published score from current preferences.

The desktop Map list sits beneath its endpoint controls. Mobile controls appear
in normal flow above the map. Week lists scroll independently of their map, and
their markers use the same today-and-future date range. Coordinate changes pan
the persistent map; label updates and save actions retain its camera. The walking
action reads Open in Google Map. The page title and slogan remain pending review.
