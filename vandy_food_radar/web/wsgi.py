"""WSGI entry point for ``flask --app vandy_food_radar.web.wsgi`` (design.md §8).

Builds the offline application wired to the SQLite database (path from the
``VFR_DB`` environment variable, defaulting to an ephemeral ``/tmp/store.db``
suitable for the Vercel serverless filesystem), the fixture-backed sources, and
the configured location provider, so both ``make run`` / ``make demo`` and the
deployed serverless function serve the ranked events with no network access.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

from flask import Flask

from ..config import Config
from ..pipeline import seed_demo
from ..sources import Window
from ..store import SqliteRepository, build_snapshot_store
from .app import create_app

# Ephemeral path so the app boots with NO env vars on Vercel (its filesystem is
# read-only except for /tmp). Local `make run`/`make demo` override VFR_DB.
DEFAULT_DB_PATH = "/tmp/store.db"


def build_app() -> Flask:
    """Create the Flask app reading from the configured SQLite database.

    Wires the snapshot store (Upstash when the env vars are set, else the
    in-memory offline default) so the deployed app has cross-run change
    tracking (M7-M9). When the target day has no stored events (e.g. a fresh
    serverless instance with no env vars), seeds the offline fixture corpus once
    so the page is never empty; a populated store is never reseeded.
    """

    config = Config.from_env()
    db_path = os.environ.get("VFR_DB", DEFAULT_DB_PATH)
    # A real WSGI server (Flask dev server / Vercel) dispatches requests on
    # worker threads distinct from the one that runs build_app(), so the shared
    # connection must allow cross-thread use.
    repository = SqliteRepository(db_path, check_same_thread=False)
    _seed_if_empty(repository, config)
    store = build_snapshot_store(config)
    return create_app(config, repository=repository, snapshot_store=store)


def _seed_if_empty(repository: SqliteRepository, config: Config) -> None:
    """Seed the offline demo corpus when the target day is empty (guarded)."""

    today = datetime.now(tz=UTC).date()
    window = Window.from_config(config, today=today)
    if repository.get_events_for_day(window.target_date):
        return
    seed_demo(repository=repository, config=config, today=today)


app = build_app()

__all__ = ["app", "build_app"]
