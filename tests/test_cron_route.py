"""Tests for the scheduler-facing /cron/refresh route.

Exercises the snapshot-backed refresh over an in-memory repository and an
InMemorySnapshotStore: GET and POST both return 200 application/json with the
RunReport counts plus a change object, the run populates the target day, a
second call is idempotent while repopulating the snapshot, and ``days=2``/
``days=7`` refresh a consecutive span in one durable publication. There is no
in-process scheduler — an external scheduler is the trigger. No network I/O
beyond the offline corpus.
"""

from __future__ import annotations

import json
from datetime import date, timedelta

from vandy_food_radar.config import Config
from vandy_food_radar.store import InMemorySnapshotStore, SqliteRepository
from vandy_food_radar.web import create_app

FIXED_TODAY = date(2025, 3, 11)  # fixtures are dated 2025-03-11
TARGET_DAY = FIXED_TODAY


def _app() -> tuple[object, SqliteRepository, InMemorySnapshotStore]:
    config = Config()
    repository = SqliteRepository(":memory:")
    store = InMemorySnapshotStore()
    app = create_app(
        config,
        repository=repository,
        today_provider=lambda: FIXED_TODAY,
        snapshot_store=store,
    )
    return app, repository, store


def test_post_cron_refresh_returns_json_report_and_populates_day() -> None:
    app, repository, store = _app()
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        response = client.post("/cron/refresh")
        assert response.status_code == 200
        assert response.mimetype == "application/json"

        payload = json.loads(response.get_data(as_text=True))
        assert payload["target_date"] == TARGET_DAY.isoformat()
        assert payload["days"] == [TARGET_DAY.isoformat()]
        assert "fetched" in payload
        assert "merged" in payload
        assert "scored" in payload
        assert "changes" in payload
        # First run: every event is NEW against an empty snapshot.
        assert payload["changes"]["new"] > 0

        # The pipeline populated the target day and repopulated the snapshot.
        assert len(repository.get_events_for_day(TARGET_DAY)) > 0
        assert store.load_snapshot(TARGET_DAY) is not None
    finally:
        repository.close()


def test_get_cron_refresh_works() -> None:
    app, repository, _ = _app()
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        response = client.get("/cron/refresh")
        assert response.status_code == 200
        assert response.mimetype == "application/json"
        payload = json.loads(response.get_data(as_text=True))
        assert "changes" in payload
    finally:
        repository.close()


def test_second_call_is_idempotent_and_repopulates_snapshot() -> None:
    app, repository, store = _app()
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        client.post("/cron/refresh")
        first_count = len(repository.get_events_for_day(TARGET_DAY))

        response = client.post("/cron/refresh")
        payload = json.loads(response.get_data(as_text=True))

        # No duplicate events on the second run (idempotent upsert).
        second_count = len(repository.get_events_for_day(TARGET_DAY))
        assert second_count == first_count
        # The second identical run classifies everything as unchanged.
        assert payload["changes"]["new"] == 0
        assert payload["changes"]["unchanged"] == second_count
        # Snapshot remains populated for the next run.
        assert store.load_snapshot(TARGET_DAY) is not None
    finally:
        repository.close()


def test_days_parameter_refreshes_a_consecutive_span() -> None:
    app, repository, _ = _app()
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        response = client.post("/cron/refresh?days=2")
        assert response.status_code == 200
        payload = json.loads(response.get_data(as_text=True))
        assert payload["days"] == [
            FIXED_TODAY.isoformat(),
            (FIXED_TODAY + timedelta(days=1)).isoformat(),
        ]

        week = client.post("/cron/refresh?days=7")
        week_payload = json.loads(week.get_data(as_text=True))
        assert len(week_payload["days"]) == 7
        assert week_payload["days"][0] == FIXED_TODAY.isoformat()
    finally:
        repository.close()


def test_unsupported_day_count_falls_back_to_one_day() -> None:
    app, repository, _ = _app()
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        payload = json.loads(
            client.post("/cron/refresh?days=99").get_data(as_text=True)
        )
        assert payload["days"] == [FIXED_TODAY.isoformat()]
    finally:
        repository.close()


def test_no_scheduler_symbol_exists() -> None:
    """An external scheduler is the trigger; no in-process scheduler is built."""

    import vandy_food_radar.web.app as app_module

    assert not hasattr(app_module, "BackgroundScheduler")
    assert not hasattr(app_module, "APScheduler")
    assert not hasattr(app_module, "scheduler")
