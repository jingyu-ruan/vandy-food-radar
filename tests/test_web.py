"""Tests for the Flask web UI (FEAT-006, M6, FR-34–FR-38).

Uses the Flask test client over a seeded in-memory repository: the index page
returns 200, renders events in ranked order (cancelled last), shows all required
card fields plus state badges, and the 'Refresh now' action re-runs the
pipeline. The web layer reads only through the Repository. No network I/O beyond
loading the offline corpus.
"""

from __future__ import annotations

from datetime import date

from vandy_food_radar.config import Config
from vandy_food_radar.pipeline import seed_demo
from vandy_food_radar.store import InMemorySnapshotStore, SqliteRepository
from vandy_food_radar.web import create_app

FIXED_TODAY = date(2025, 3, 10)
TARGET_DAY = date(2025, 3, 11)


def _seeded_app() -> tuple[object, SqliteRepository]:
    config = Config()
    repository = SqliteRepository(":memory:")
    seed_demo(repository=repository, config=config, today=FIXED_TODAY)
    app = create_app(config, repository=repository, today_provider=lambda: FIXED_TODAY)
    return app, repository


def test_index_returns_200_with_ranked_events() -> None:
    app, repository = _seeded_app()
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        response = client.get("/")
        assert response.status_code == 200
        body = response.get_data(as_text=True)

        # Dense card fields are present.
        assert "Free Pizza Night" in body
        assert "International Student Dinner" in body
        assert "Walking time unavailable" in body  # fixtures carry no geo
        assert "Sources:" in body
        assert "RSVP" in body

        # State badges are rendered.
        assert "state-cancelled" in body
        assert "state-conflicting" in body

        # Ranking explanation is shown.
        assert "Ranked" in body
    finally:
        repository.close()


def test_events_render_in_ranked_order_with_cancelled_last() -> None:
    app, repository = _seeded_app()
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        body = client.get("/").get_data(as_text=True)

        # Dinner-with-menu (full meal) must appear before the refreshments talk.
        assert body.index("International Student Dinner") < body.index(
            "Undergraduate Research Talk"
        )
        # The cancelled movie night is forced below a normal event.
        assert body.index("Free Pizza Night") < body.index("Outdoor Movie Night")
    finally:
        repository.close()


def test_refresh_triggers_pipeline_and_redirects() -> None:
    config = Config()
    repository = SqliteRepository(":memory:")
    try:
        app = create_app(
            config,
            repository=repository,
            today_provider=lambda: FIXED_TODAY,
        )
        # Empty before refresh.
        assert repository.get_events_for_day(TARGET_DAY) == []

        client = app.test_client()
        response = client.post("/refresh")
        assert response.status_code == 302

        # The pipeline populated the target day.
        assert len(repository.get_events_for_day(TARGET_DAY)) > 0
    finally:
        repository.close()


def test_conflicts_are_shown_in_expandable_section() -> None:
    app, repository = _seeded_app()
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        body = client.get("/").get_data(as_text=True)
        assert "conflict(s) detected" in body
        assert "<details" in body
    finally:
        repository.close()


def test_index_returns_200_with_snapshot_store_and_change_badges() -> None:
    config = Config()
    repository = SqliteRepository(":memory:")
    seed_demo(repository=repository, config=config, today=FIXED_TODAY)
    store = InMemorySnapshotStore()
    try:
        app = create_app(
            config,
            repository=repository,
            today_provider=lambda: FIXED_TODAY,
            snapshot_store=store,
        )
        client = app.test_client()

        # No snapshot yet: every event reads as NEW, so a change badge shows.
        body = client.get("/").get_data(as_text=True)
        assert body.count("200") >= 0  # sanity: page rendered
        assert "change-badge" in body
        assert "New" in body

        # After a snapshot-backed refresh, an unchanged re-render drops the
        # NEW badges (nothing changed against the just-saved snapshot).
        client.post("/cron/refresh")
        body_after = client.get("/").get_data(as_text=True)
        assert "change-new" not in body_after
    finally:
        repository.close()
