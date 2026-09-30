"""WSGI entry point for offline demos and live Vercel production."""

from __future__ import annotations

import os
from datetime import datetime
from zoneinfo import ZoneInfo

from flask import Flask

from ..config import Config
from ..pipeline import seed_demo
from ..sources import Window
from ..store import (
    SqliteRepository,
    UpstashSqliteRepository,
    build_snapshot_store,
)
from .app import create_app

DEFAULT_DB_PATH = "/tmp/store.db"


def build_app() -> Flask:
    """Create a fixture-backed local app or a strictly durable live app.

    ``VFR_OFFLINE=true`` preserves the zero-configuration demo. Live mode never
    seeds fixtures and refuses to boot without durable Upstash credentials and
    a refresh bearer token.
    """

    config = Config.from_env()
    if config.offline:
        db_path = os.environ.get("VFR_DB", DEFAULT_DB_PATH)
        repository = SqliteRepository(db_path, check_same_thread=False)
        _seed_if_empty(repository, config)
    else:
        if not config.refresh_token:
            raise RuntimeError("live mode requires CRON_SECRET or VFR_REFRESH_TOKEN")
        repository = UpstashSqliteRepository(
            config.snapshot.upstash_rest_url,
            config.snapshot.upstash_rest_token,
        )

    store = build_snapshot_store(config)
    return create_app(config, repository=repository, snapshot_store=store)


def _seed_if_empty(repository: SqliteRepository, config: Config) -> None:
    """Seed only an explicitly offline demo, using Vanderbilt local today."""

    today = datetime.now(tz=ZoneInfo(config.timezone)).date()
    window = Window.from_config(config, today=today)
    if repository.get_events_for_day(window.target_date):
        return
    seed_demo(repository=repository, config=config, today=today)


app = build_app()

__all__ = ["app", "build_app"]
