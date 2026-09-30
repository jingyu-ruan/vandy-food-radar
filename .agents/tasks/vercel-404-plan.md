# Vercel production 404 — root cause and fix plan

## Root cause (reproduced)

Vercel now treats this repo as a **zero-config Flask backend-framework project**,
not the old `/api` file-based functions model. Flask is listed in
`pyproject.toml` and `requirements.txt`, and `api/index.py` exports `app`. The
user's build log (Vercel CLI 61.1.0) confirms this: "Using Python 3.12 from
pyproject.toml … Installing required dependencies from pyproject.toml". The one
build warning is the cause of the bug:

> Internal rewrites in backend framework projects now route requests using the
> rewritten destination path.

`vercel.json` rewrites every path (`/(.*)`) to `/api/index`. So Flask gets
`PATH_INFO=/api/index` for **every** URL. The app has no such route, so every
page returns Flask's default 404. That matches the screenshot exactly. The
earlier fixes (ee2b328, f9947ee) only changed the rewrite. The real fix is to
**delete the rewrite**, because in framework mode Vercel already sends every
request to the Flask app.

### What was run and observed

With `VERCEL=1` set, `VFR_DB` unset (so the default `/tmp/store.db` is used),
and `uv run python /tmp/repro.py` importing `api.index.app`:

- `app.url_map` has `/static/<path:filename>` (GET), `/` (GET), `/refresh`
  (POST), `/cron/refresh` (GET, POST), `/seed` (POST) and
  `/calendar/add/<identity_key>` (POST).
- `APPLICATION_ROOT` is `/`. There is no url_prefix and no conditional route
  registration. On a cold `/tmp`, the app seeds its fixture data and boots fine.

| PATH_INFO | Status |
|---|---|
| `/` | **200** (index HTML) |
| `/cron/refresh` | 200 (JSON RunReport) |
| `/static/app.css` | 200 locally |
| `/api/index` (GET and POST) | **404**: the same Flask "Not Found" page seen in production |
| `/api/index.py` | 404 |
| `/` with `SCRIPT_NAME=/api/index` | 200 |

Baseline: `uv run pytest` → 138 passed.

### Doc findings

- [Flask on Vercel docs](https://vercel.com/docs/frameworks/backend/flask) and the
  [Ship a Flask app KB guide](https://vercel.com/kb/guide/ship-a-flask-app-on-vercel):
  - Vercel finds a top-level `app` in `app.py`, `index.py`, `server.py`,
    `main.py`, `wsgi.py` or `asgi.py`, either at the project root or under
    `src/`, `app/` or `api/`. So `api/index.py` is a valid entrypoint and no
    `tool.vercel.entrypoint` is needed.
  - Vercel sends every request to the Flask app and lets Flask's router match
    the path, so no rewrite is needed.
  - Cron jobs just call the route with a GET.
  - Flask's `app.static_folder` is **ignored** for static files on Vercel.
    Static files must go in `public/**`, which the CDN serves.
- [Python functions in /api](https://vercel.com/docs/functions/runtimes/python/api-directory):
  when a framework preset is detected, it takes precedence, and files under
  `/api` don't become separate functions.
- [Python runtime](https://vercel.com/docs/functions/runtimes/python): the
  default Python version is 3.12, and `requires-python` in `pyproject.toml` is
  honored. `>=3.11` resolves to 3.12, which is fine.
- `pyproject.toml` dependencies (flask, google-api-python-client, google-auth)
  match `requirements.txt` (`-e .` plus pins), so nothing is missing from what
  Vercel installs.

Content was rephrased for compliance with licensing restrictions.

### Second issue the fix would expose: CSS

`index.html` loads `url_for('static', filename='app.css')` → `/static/app.css`,
served from `vandy_food_radar/web/static/`. On Vercel the Flask static folder is
ignored, so the page would render without styles once `/` works. The fix below
moves the stylesheet into `public/static/app.css`. The CDN then serves it at the
same `/static/app.css` URL, and Flask is pointed at that same folder, so local
`make demo` and the tests keep working.

## Implementation plan

- [ ] 1. Remove the catch-all rewrite from `vercel.json` and keep only
      `$schema` and the `crons` entry (`/cron/refresh`, `0 11 * * *`).
      Do not add `functions`, `builds` or `routes`.
      Add a regression test `tests/test_vercel_config.py` that:
      - loads `vercel.json` and asserts there are no `rewrites`/`routes`
        pointing to `/api` (ideally no `rewrites` key at all);
      - asserts every `crons[].path` matches a rule in `app.url_map`, using the
        app from `vandy_food_radar.web.wsgi.build_app()` with `VFR_DB` set to
        a `tmp_path` DB via monkeypatch, following the pattern in
        `tests/test_cron_route.py` / `tests/test_web.py`;
      - asserts `from api.index import app` exists (importlib) and that
        `app.test_client().get("/")` returns 200 with `VFR_DB` monkeypatched to
        `tmp_path`.
      Files: `vercel.json`, `tests/test_vercel_config.py`
      Verify: `uv run pytest tests/test_vercel_config.py` passes, and
      `uv run pytest` shows all 138+ tests passing.

- [ ] 2. Move the stylesheet to Vercel's CDN folder: `git mv
      vandy_food_radar/web/static/app.css public/static/app.css`. In
      `create_app` (`vandy_food_radar/web/app.py`, `app = Flask(__name__)`),
      pass `static_folder` pointing to the repo's `public/static`:
      `Path(__file__).resolve().parents[2] / "public" / "static"`, as a module
      constant `STATIC_DIR`. Keep `static_url_path` as the default `/static`.
      The template's `url_for('static', filename='app.css')` then keeps
      producing `/static/app.css`, which the CDN serves on Vercel and Flask
      serves locally.
      Remove the now-empty `vandy_food_radar/web/static/` directory.
      Add a test to `tests/test_vercel_config.py` that GETs `/static/app.css`
      → 200 and asserts `public/static/app.css` exists.
      Files: `public/static/app.css` (moved), `vandy_food_radar/web/app.py`,
      `tests/test_vercel_config.py`
      Verify: `make check` passes (lint, format-check, mypy strict, pytest).
      `VERCEL=1 uv run python -c "from api.index import app; c=app.test_client(); print([c.get(p).status_code for p in ['/','/static/app.css','/cron/refresh']])"`
      prints `[200, 200, 200]`.

- [ ] 3. Update the README deploy section (currently lines ~113–149).
      - Say Vercel detects Flask (zero-config framework preset, installing from
        `pyproject.toml`) with `api/index.py` as the entrypoint.
      - Say every request goes straight to Flask with no rewrite, and why: a
        rewrite would change the path Flask sees and 404 every page.
      - Say static assets live in `public/`.
      - Keep the existing Hobby-plan commit-author note.
      Update the `serve-vercel` help text in the `Makefile` only if its wording
      mentions rewrites (it currently doesn't, so there is likely no change).
      Files: `README.md`
      Verify: `make check` passes. `make serve-vercel` starts and
      `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5000/` → 200 and
      `/static/app.css` → 200 (stop the server afterwards).

## Notes for implementer / merge

- Do not add a `CRON_SECRET` check to `/cron/refresh` here: it changes
  behavior. Mention it as an optional follow-up.
- **Hobby-plan constraint at merge time:** Vercel Hobby blocks deployments of
  commits whose author isn't the GitHub account that owns the Vercel project.
  Commits made by the workflow must be authored as the repo owner
  (`jingyu-ruan`'s `user.name` / `user.email`), or the user must re-commit or
  squash under their own identity before pushing. Otherwise the fix never
  deploys. Never push from the workflow; the user pushes and then checks
  `https://vandy-food-radar-pi.vercel.app/` and `/static/app.css`.
- The build warning about internal rewrites should disappear after step 1.
