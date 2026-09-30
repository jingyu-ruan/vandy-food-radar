"""End-to-end pipeline test over the fixture corpus (FEAT-006, M6, AC-1).

Runs the full Discover -> Normalize -> Deduplicate -> Verify -> Rank -> Save
pass over the offline corpus and asserts the integrated behavior: the two
pizza-night sources merge to one event; the career mixer resolves to the
official 18:00 with the 18:30 loser preserved; the cancelled event is marked
cancelled; the dinner-with-menu outranks the refreshments talk; and a repeated
run is idempotent (no duplicate events) while recording history for changed
fields. No network I/O beyond loading the offline corpus.
"""

from __future__ import annotations

from datetime import date, time

from vandy_food_radar.config import Config
from vandy_food_radar.models import (
    SourceId,
    SourceRecord,
    VerificationState,
)
from vandy_food_radar.pipeline import run as run_pipeline
from vandy_food_radar.providers.location import HaversineLocationProvider
from vandy_food_radar.sources import build_sources, default_fetcher
from vandy_food_radar.sources.base import Window
from vandy_food_radar.store import SqliteRepository

TARGET_DAY = date(2025, 3, 11)  # fixtures are dated 2025-03-11


def _run(repository: SqliteRepository, config: Config) -> None:
    fetcher = default_fetcher(config)
    sources = build_sources(config, fetcher)
    run_pipeline(
        Window(target_date=TARGET_DAY),
        repository=repository,
        sources=sources,
        location_provider=HaversineLocationProvider(),
        config=config,
    )


def _events_by_title(repository: SqliteRepository) -> dict[str, object]:
    return {e.title: e for e in repository.get_events_for_day(TARGET_DAY)}


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


def _run_single(repository: SqliteRepository, adapter: _SingleRecordAdapter) -> None:
    run_pipeline(
        Window(target_date=TARGET_DAY),
        repository=repository,
        sources=[adapter],
        location_provider=HaversineLocationProvider(),
        config=Config(),
    )


def test_full_pipeline_over_corpus() -> None:
    config = Config()
    repository = SqliteRepository(":memory:")
    try:
        _run(repository, config)
        events = repository.get_events_for_day(TARGET_DAY)
        titles = [e.title for e in events]

        # Two pizza-night sources merge to a single event.
        assert titles.count("Free Pizza Night") == 1
        pizza = next(e for e in events if e.title == "Free Pizza Night")
        pizza_sources = repository.get_source_records(pizza.id)
        source_ids = {s.source_id for s in pizza_sources}
        assert SourceId.ANCHOR_LINK in source_ids
        assert SourceId.GOOGLE_CALENDAR in source_ids

        # Career mixer resolves to the official 18:00 with the 18:30 loser kept.
        mixer = next(e for e in events if e.title == "Engineering Career Mixer")
        assert mixer.start_time == time(18, 0)
        assert mixer.verification_state is VerificationState.CONFLICTING
        mixer_conflicts = repository.get_conflicts(mixer.id)
        start_conflicts = [c for c in mixer_conflicts if c.field_name == "start_time"]
        assert start_conflicts
        competing = {str(cv.value) for cv in start_conflicts[0].competing_values}
        assert "18:00:00" in competing
        assert "18:30:00" in competing

        # Cancelled event is marked cancelled.
        movie = next(e for e in events if e.title == "Outdoor Movie Night")
        assert movie.verification_state is VerificationState.CANCELLED

        # Dinner-with-menu outranks the refreshments-only talk.
        dinner = next(e for e in events if e.title == "International Student Dinner")
        refreshments = next(
            e for e in events if e.title == "Undergraduate Research Talk"
        )
        assert dinner.score_total is not None and refreshments.score_total is not None
        assert dinner.score_total > refreshments.score_total
    finally:
        repository.close()


def test_repeat_run_is_idempotent_and_records_history() -> None:
    config = Config()
    repository = SqliteRepository(":memory:")
    try:
        _run(repository, config)
        first = repository.get_events_for_day(TARGET_DAY)
        first_keys = sorted(e.dedup_key for e in first)

        _run(repository, config)
        second = repository.get_events_for_day(TARGET_DAY)
        second_keys = sorted(e.dedup_key for e in second)

        # No duplicate events created on re-run (FR-42, AC-10).
        assert len(second) == len(first)
        assert first_keys == second_keys

        # Each event's source records are replaced, not duplicated.
        for event in second:
            records = repository.get_source_records(event.id)
            assert len(records) == len({r.source_url for r in records})

        # History is not re-appended on an unchanged re-run: the cancelled
        # Outdoor Movie Night keeps exactly one cancellation entry, not one per
        # pass (FR-42, AC-10). A third run must not grow it either.
        _run(repository, config)
        movie = next(e for e in second if e.title == "Outdoor Movie Night")
        cancellation_rows = [
            h
            for h in repository.get_history(movie.id)
            if h.new_value == VerificationState.CANCELLED.value
        ]
        assert len(cancellation_rows) == 1
    finally:
        repository.close()


def test_time_and_venue_change_update_in_place_with_history() -> None:
    """A verified time/venue change updates the event, not duplicates it (E-2/E-3)."""

    repository = SqliteRepository(":memory:")
    try:
        _run_single(
            repository, _SingleRecordAdapter(start_time="18:00", location="Hall A")
        )
        first = repository.get_events_for_day(TARGET_DAY)
        assert len(first) == 1
        event_id = first[0].id

        # Time change 18:00 -> 19:00 (AC-11, E-2): still one event, in place.
        _run_single(
            repository, _SingleRecordAdapter(start_time="19:00", location="Hall A")
        )
        after_time = repository.get_events_for_day(TARGET_DAY)
        assert len(after_time) == 1
        assert after_time[0].id == event_id
        assert after_time[0].start_time == time(19, 0)
        start_history = [
            h for h in repository.get_history(event_id) if h.field_name == "start_time"
        ]
        assert len(start_history) == 1
        assert start_history[0].old_value == "18:00:00"
        assert start_history[0].new_value == "19:00:00"

        # Venue change Hall A -> Hall B (E-3): still one event, in place.
        _run_single(
            repository, _SingleRecordAdapter(start_time="19:00", location="Hall B")
        )
        after_venue = repository.get_events_for_day(TARGET_DAY)
        assert len(after_venue) == 1
        assert after_venue[0].location == "Hall B"
        location_history = [
            h for h in repository.get_history(event_id) if h.field_name == "location"
        ]
        assert len(location_history) == 1
        assert location_history[0].old_value == "Hall A"
        assert location_history[0].new_value == "Hall B"
    finally:
        repository.close()
