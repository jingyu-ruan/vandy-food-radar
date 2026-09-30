# Vandy Food Radar — developer tasks
#
# Uses uv to manage the virtual environment and run tools. All targets are
# offline; no target makes a live network call except `install`, which resolves
# dev dependencies.

.DEFAULT_GOAL := help

# Pin the interpreter to Python 3.11 (see README for pyenv notes).
PYTHON_VERSION := 3.11

# SQLite database path and web bind address (override on the command line).
DB_PATH := store.db
WEB_HOST := 127.0.0.1
WEB_PORT := 5000

.PHONY: help install lint format format-check typecheck test check clean \
	seed run web demo serve-vercel

help: ## Show this help.
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Create the venv and install the package with dev dependencies.
	uv sync --python $(PYTHON_VERSION) --extra dev

lint: ## Run ruff lint checks.
	uv run ruff check .

format: ## Auto-format with black and ruff import sorting.
	uv run ruff check --select I --fix .
	uv run black .

format-check: ## Verify formatting without modifying files.
	uv run black --check .

typecheck: ## Run mypy in strict mode.
	uv run mypy

test: ## Run the test suite.
	uv run pytest

check: lint format-check typecheck test ## Run all checks (lint, format, types, tests).

seed: ## Seed SQLite with the fixture corpus, dates retargeted to tomorrow.
	uv run python -m vandy_food_radar --db $(DB_PATH) seed

run: ## Run the pipeline over the configured sources for the target day.
	uv run python -m vandy_food_radar --db $(DB_PATH) run

web: ## Serve the ranked-events web UI on localhost (reads $(DB_PATH)).
	VFR_DB=$(DB_PATH) uv run flask --app vandy_food_radar.web.wsgi run \
		--host $(WEB_HOST) --port $(WEB_PORT)

demo: seed ## Seed the corpus then serve the web UI at http://127.0.0.1:5000/.
	VFR_DB=$(DB_PATH) uv run flask --app vandy_food_radar.web.wsgi run \
		--host $(WEB_HOST) --port $(WEB_PORT)

serve-vercel: ## Serve the Vercel entrypoint (api/index.py) locally in demo mode.
	uv run flask --app api.index run --host $(WEB_HOST) --port $(WEB_PORT)

clean: ## Remove caches and build artifacts.
	rm -rf .pytest_cache .mypy_cache .ruff_cache build dist *.egg-info
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
