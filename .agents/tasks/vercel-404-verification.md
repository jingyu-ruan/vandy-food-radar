# Vercel 404 fix — verification (branch fix/vercel-404-routing)

First iteration (no `vercel-404-review.json` present).

## Changes
- `vercel.json`: removed the catch-all `rewrites` (`/(.*)` → `/api/index`); only `$schema` + `crons` remain.
- `vandy_food_radar/web/static/app.css` → `public/static/app.css` (git mv); `create_app` uses
  `Flask(__name__, static_folder=STATIC_DIR)` with `STATIC_DIR = <repo>/public/static`. URL stays `/static/app.css`.
- `tests/test_vercel_config.py` (4 tests): no rewrites/routes/builds; each cron path is a Flask rule and GET → 200;
  `api.index.app` GET `/` → 200; `public/static/app.css` exists and `/static/app.css` → 200.
- README deploy section: Flask framework preset, installs from `pyproject.toml`, no rewrite (and why), static in `public/`.
  The Hobby-plan commit-author note is unchanged.

## (a) Test suite
`make check` → ruff: All checks passed; black: 64 files unchanged; mypy strict: no issues in 63 files;
pytest: **142 passed** (baseline 138 + 4 new).

## (b) Vercel-like simulation
`rm -f /tmp/store.db && VERCEL=1 uv run python -c "from api.index import app; ..."` (VFR_DB unset → /tmp/store.db):

| Request | Status |
|---|---|
| GET `/` | 200 |
| GET `/static/app.css` | 200 |
| GET `/cron/refresh` | 200 |
| POST `/cron/refresh` | 200 |
| GET `/` with `SCRIPT_NAME=/api/index` | 200 |
| GET `/api/index` (the path the old rewrite produced) | 404, which confirms the root cause; the rewrite that produced it is now gone |

`make serve-vercel`, then curl `/` → 200, `/static/app.css` → 200, `/cron/refresh` → 200. Server stopped afterwards.

## (c) vercel build
Not possible: the `vercel` CLI is not installed in the sandbox, and there are no Vercel credentials.

## Merge note
The commits are authored by the sandbox git identity (`Kiro Agent`). On the Vercel Hobby plan, the user should
squash-merge the PR (or re-commit) under the project-owner GitHub identity so that production deploys.
