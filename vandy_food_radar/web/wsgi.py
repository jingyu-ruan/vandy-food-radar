"""WSGI entry point for ``flask --app vandy_food_radar.web.wsgi`` (design.md §8).

Builds the offline application wired to the on-disk SQLite database (path from
the ``VFR_DB`` environment variable, default ``store.db``), the fixture-backed
sources, and the configured location provider, so ``make run`` / ``make demo``
serve the ranked events with no network access.
"""

from __future__ import annotations

import os

from flask import Flask

from ..config import Config
from ..store import SqliteRepository
from .app import create_app

DEFAULT_DB_PATH = "store.db"


def build_app() -> Flask:
    """Create the Flask app reading from the configured SQLite database."""

    config = Config.from_env()
    db_path = os.environ.get("VFR_DB", DEFAULT_DB_PATH)
    repository = SqliteRepository(db_path)
    return create_app(config, repository=repository)


app = build_app()

__all__ = ["app", "build_app"]
