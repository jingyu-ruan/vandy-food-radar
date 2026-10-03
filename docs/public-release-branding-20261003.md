# Original Codex branding and public release

Verified on October 3, 2026.

## Publication

- Public website: https://vandy-food-radar.rjy020128.chatgpt.site
- GitHub implementation commit: `11c063090719590d5c7d24cecd6a3bce94a0c4dd`.
- Sites source commit: `34e550f40e7cd92bd4c1b63f24a6fb084f891719`.
- Both source trees: `52a1658ab1f6199eb3f458cc1fecd224dcd6d41c`.
- Saved version: `appgprj_6abda08653248191bd4377356f3e0a33~appgver_83985f15a4048191b7fd76b0d08bc07a` (version 15).
- Successful deployment: `appgdep_6ac16ca597f48191a7f7c7518d666b85`.
- Sites access mode: `public`, policy revision 2.
- Runtime environment revision: 3; `VFR_OWNER_PRIVATE=false` and a secret application refresh token.
- GitHub repository visibility remains public. Its About website link points to the public Site.

The implementation commit includes all current local repository changes, including
the prior daily brief, walking and responsive refinements, and the complete brand
comparison artifacts. Generated output, dependencies, local runtime state and
ignored environment files stay outside the tracked source.

## Branding and layout

The original Codex cutlery V appears to the left of the main title. Its square
mark is 44 CSS pixels on desktop and 40 on mobile, within a home-link target of
at least 44 pixels. The adjacent heading remains HTML text. The SVG image is
decorative for assistive technology because its surrounding link has a complete
accessible name. Dedicated SVG and PNG favicons and an Apple touch icon use the
same original design.

This arrangement applies Apple's guidance on restrained branding, grouping
related content, alignment and responsive layout. The guidelines provide
principles rather than a universal rule requiring a website logo to sit left of
the heading.

- https://developer.apple.com/design/human-interface-guidelines/branding
- https://developer.apple.com/design/human-interface-guidelines/layout

The retained Flask page receives the same original mark and favicon assets.
The public page omits the owner-private manual refresh control; scheduled
refreshes authenticate from GitHub Actions using repository secrets.

## Validation

- 137 TypeScript/browser-module tests passed, including a check that routing,
  map, refresh and Gemini credentials never enter the client configuration.
- 327 Python tests passed.
- TypeScript checking and the production Sites build passed.
- Browser checks confirmed the mark and favicons on the published Site. Desktop
  at 1366 pixels and mobile at 390 pixels had no horizontal overflow; the local
  320-pixel preview also had no overflow.
- Cookie-free, unauthenticated HTTP requests returned 200 for `/`, `/api/meta`,
  `/api/day?date=2026-10-03`, `/api/health`, `/favicon.svg` and the header SVG.
  The served SVGs matched the original Codex files byte for byte.
- An anonymous `POST /api/refresh?days=2` returned 401 before any data mutation.
- [GitHub Actions run 37153601824](https://github.com/jingyu-ruan/vandy-food-radar/actions/runs/37153601824)
  succeeded using the protected refresh path and verified eight persisted events
  across October 3 and October 4.

## Secret scan

Gitleaks 8.30.1 found no credential matches in the working source, the 41 scanned
Git commits, or the built browser assets. Archive scanning and nested decoding
were enabled where relevant. No secret values are recorded in this document.

The deployment archive produced two generic-key matches, both named
`prerenderSecret`, in Vinext's generated server manifests. The installed
framework uses this value to authenticate its internal prerender requests. The
same value occurred only in `dist/server/vinext-server.json` and
`dist/server/ssr/vinext-server.json`, with no occurrence in browser assets.
Anonymous requests for `/vinext-server.json`, `/server/vinext-server.json` and
`/dist/server/vinext-server.json` returned 404. The generated server value was
absent from the public page and API responses checked above. These are private
framework build credentials rather than exposed provider API keys.

API and refresh credentials live in secret runtime settings; the refresh
credential is also stored in GitHub Actions secrets. Logs show masked values.
Pattern-based scanning and the listed runtime checks found no API-key exposure;
they do not establish a guarantee against every possible credential format.
