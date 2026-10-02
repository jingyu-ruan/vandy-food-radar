# Local runtime

Use Python 3.11 or newer. Prefer the project virtual environment when it exists:
`.venv/bin/python`, `.venv/bin/pytest`, `.venv/bin/ruff`, `.venv/bin/black`, and
`.venv/bin/mypy`. Otherwise follow the installation instructions in README.md.

Browser JavaScript uses ES modules. With Node.js 18 or newer, run
`node tests/js/itinerary.test.mjs` to check itinerary time-window behavior.
