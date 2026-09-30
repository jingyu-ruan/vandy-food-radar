"""Offline tests for the snapshot-backed run wrapper (M7-M9, FEAT-001)."""

from __future__ import annotations

from datetime import date, time

from vandy_food_radar.config import Config
from vandy_food_radar.models import SourceId, SourceRecord
from vandy_food_radar.pipeline import ChangeKind, run_with_snapshot
from vandy_food_radar.providers.location import HaversineLocationProvider
from vandy_food_radar.sources import build_sources, default_fetcher
from vandy_food_radar.sources.base import Window
from vandy_food_radar.store import InMemorySnapshotStore, SqliteRepository

TARGET_DAY = date(2025, 3, 11)


class _SingleRecordAdapter:
    """Minimal offline adapter emitting one anchor-link record (no network)."""

    source_id = "anchor_link"

    def __init__(self, *, start_time: str, location: str) -> None:
        self._start_time = start_time
        self._location = location
        self._counter = 0

    def fetch(self, window: object) -> list[SourceRecord]:  # noqa: ARG002
        self._counter += 1
        return [
            SourceRecord(
                id=f"rec-{self._counter}",
                event_id="",
                source_id=SourceId.ANCHOR_LINK,
                source_url="https://anchorlink.vanderbilt.edu/e/gala",
                parsed_fields={
                    "title": "Spring Gala Dinner",
                    "event_date": "2025-03-11",
                    "start_time": self._start_time,
                    "location": self._location,
                    "food_confirmed": "confirmed",
                    "food_description": "Catered dinner.",
                },
            )
        ]


def _run(
    repository: SqliteRepository,
    snapshot_store: InMemorySnapshotStore,
    config: Config,
) -> dict[str, ChangeKind]:
    sources = build_sources(config, default_fetcher(config))
    _, changes = run_with_snapshot(
        Window(target_date=TARGET_DAY),
        repository=repository,
        sources=sources,
        location_provider=HaversineLocationProvider(),
        config=config,
        snapshot_store=snapshot_store,
    )
    return changes


def test_first_run_all_new_second_run_unchanged() -> None:
    config = Config()
    repository = SqliteRepository(":memory:")
    snapshot_store = InMemorySnapshotStore()
    try:
        first = _run(repository, snapshot_store, config)
        assert first
        assert all(kind is ChangeKind.NEW for kind in first.values())
        assert snapshot_store.load_snapshot(TARGET_DAY) is not None

        second = _run(repository, snapshot_store, config)
        assert second
        assert all(kind is ChangeKind.UNCHANGED for kind in second.values())
        assert snapshot_store.load_snapshot(TARGET_DAY) is not None
    finally:
        repository.close()


def test_time_change_between_runs_is_time_changed() -> None:
    config = Config()
    repository = SqliteRepository(":memory:")
    snapshot_store = InMemorySnapshotStore()
    try:
        sources_first = [_SingleRecordAdapter(start_time="18:00", location="Hall A")]
        _, first = run_with_snapshot(
            Window(target_date=TARGET_DAY),
            repository=repository,
            sources=sources_first,
            location_provider=HaversineLocationProvider(),
            config=config,
            snapshot_store=snapshot_store,
        )
        assert len(first) == 1
        (identity_key,) = first.keys()
        assert first[identity_key] is ChangeKind.NEW

        # Confirm the event actually landed at 18:00 before changing it.
        stored = repository.get_events_for_day(TARGET_DAY)
        assert stored[0].start_time == time(18, 0)

        sources_second = [_SingleRecordAdapter(start_time="19:00", location="Hall A")]
        _, second = run_with_snapshot(
            Window(target_date=TARGET_DAY),
            repository=repository,
            sources=sources_second,
            location_provider=HaversineLocationProvider(),
            config=config,
            snapshot_store=snapshot_store,
        )
        assert second[identity_key] is ChangeKind.TIME_CHANGED
        assert snapshot_store.load_snapshot(TARGET_DAY) is not None
    finally:
        repository.close()
