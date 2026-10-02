"""Tests for provider-native event identity and title/time collisions.

AnchorLink publishes distinct events that can share a title, venue, and start
time (two sections of the same weekly meeting, for example). The date + title
fingerprint cannot separate them, so a provider-native id becomes the primary
key when exactly one is available. These tests pin that contract end to end:

* two rows from the same source with different native ids stay two events, with
  distinct ``identity_key`` and distinct stable ``id``, even though their
  ``dedup_key`` fingerprints collide;
* a repeated row with the *same* native id still merges;
* a listing with no native id keeps the legacy fingerprint identity, so stored
  fixture events are unaffected;
* the repository can hold the colliding pair without violating either key.
"""

from __future__ import annotations

from uuid import NAMESPACE_URL, uuid5

from vandy_food_radar.config import Config
from vandy_food_radar.dedup import (
    MergedEvent,
    compute_dedup_key,
    compute_identity_key,
    deduplicate,
)
from vandy_food_radar.models import SourceId, SourceRecord
from vandy_food_radar.normalize import normalize
from vandy_food_radar.pipeline import run
from vandy_food_radar.providers.location import NullLocationProvider
from vandy_food_radar.sources import Window
from vandy_food_radar.store import SqliteRepository

from .support import DEMO_DAY, DEMO_START, Listing, StubSourceAdapter, source_record

TZ = "America/Chicago"


def _merge(*records: SourceRecord) -> list[MergedEvent]:
    normalized = [normalize(record, timezone=TZ) for record in records]
    return deduplicate(normalized, config=Config().dedup)


def _collide(first_id: str | None, second_id: str | None) -> list[MergedEvent]:
    """Two listings identical in every field except the native id."""

    return _merge(
        source_record(
            Listing("Weekly Chapter Dinner", source_identity=first_id),
            DEMO_DAY,
            record_id="rec-a",
        ),
        source_record(
            Listing("Weekly Chapter Dinner", source_identity=second_id),
            DEMO_DAY,
            record_id="rec-b",
        ),
    )


def test_colliding_fingerprints_stay_separate_under_distinct_native_ids() -> None:
    merged = _collide("2001", "2002")
    assert len(merged) == 2

    identity_keys = sorted(item.event.identity_key for item in merged)
    assert identity_keys == ["source|2001", "source|2002"]

    # The fingerprint really does collide: only the native id separates them.
    fingerprints = {item.dedup_key for item in merged}
    assert len(fingerprints) == 1
    assert fingerprints == {
        compute_dedup_key(
            DEMO_DAY,
            "Weekly Chapter Dinner",
            "Sarratt Student Center, Room 216",
            DEMO_START,
        )
    }


def test_primary_keys_are_stable_uuid5_values_derived_from_the_native_key() -> None:
    merged = _collide("2001", "2002")
    ids = {item.event.id for item in merged}
    assert ids == {
        uuid5(NAMESPACE_URL, "source|2001").hex,
        uuid5(NAMESPACE_URL, "source|2002").hex,
    }
    # Re-running the same input reproduces the same ids.
    assert ids == {item.event.id for item in _collide("2001", "2002")}


def test_the_same_native_id_twice_still_merges_into_one_event() -> None:
    merged = _collide("2001", "2001")
    assert len(merged) == 1
    assert merged[0].event.identity_key == "source|2001"
    assert len(merged[0].members) == 2


def test_listings_without_a_native_id_keep_the_fingerprint_identity() -> None:
    merged = _collide(None, None)
    assert len(merged) == 1
    event = merged[0].event
    assert event.identity_key == compute_identity_key(DEMO_DAY, "Weekly Chapter Dinner")
    assert event.identity_key == "2025-03-11|chapter dinner weekly"
    # Legacy events keep the fingerprint as their primary key.
    assert event.id == event.dedup_key


def test_a_cross_source_merge_adopts_the_single_native_identity() -> None:
    merged = _merge(
        source_record(
            Listing("Weekly Chapter Dinner", source_identity="2001"),
            DEMO_DAY,
            record_id="anchor-1",
        ),
        source_record(
            Listing("Weekly Chapter Dinner"),
            DEMO_DAY,
            source_id=SourceId.GOOGLE_CALENDAR,
            record_id="gcal-1",
        ),
    )
    assert len(merged) == 1
    assert merged[0].event.identity_key == "source|2001"
    assert {m.source_id for m in merged[0].members} == {
        SourceId.ANCHOR_LINK,
        SourceId.GOOGLE_CALENDAR,
    }


def test_the_repository_stores_both_colliding_events_on_the_same_day() -> None:
    repository = SqliteRepository(":memory:")
    try:
        report = run(
            Window(target_date=DEMO_DAY),
            repository=repository,
            sources=[
                StubSourceAdapter(
                    {
                        DEMO_DAY: [
                            Listing("Weekly Chapter Dinner", source_identity="2001"),
                            Listing("Weekly Chapter Dinner", source_identity="2002"),
                        ]
                    }
                )
            ],
            location_provider=NullLocationProvider(),
            config=Config(),
        )
        assert report.merged == 2
        assert report.scored == 2

        stored = repository.get_events_for_day(DEMO_DAY)
        assert len(stored) == 2
        assert sorted(event.identity_key for event in stored) == [
            "source|2001",
            "source|2002",
        ]
        assert len({event.id for event in stored}) == 2
        # Each stored event keeps its own source row and real source URL.
        for event in stored:
            records = repository.get_source_records(event.id)
            assert len(records) == 1
            native = event.identity_key.removeprefix("source|")
            assert records[0].source_url == (
                f"https://anchorlink.vanderbilt.edu/event/{native}"
            )
    finally:
        repository.close()


def test_a_repeated_run_over_colliding_events_is_idempotent() -> None:
    repository = SqliteRepository(":memory:")
    adapter = StubSourceAdapter(
        {
            DEMO_DAY: [
                Listing("Weekly Chapter Dinner", source_identity="2001"),
                Listing("Weekly Chapter Dinner", source_identity="2002"),
            ]
        }
    )
    try:
        for _ in range(2):
            run(
                Window(target_date=DEMO_DAY),
                repository=repository,
                sources=[adapter],
                location_provider=NullLocationProvider(),
                config=Config(),
            )
        stored = repository.get_events_for_day(DEMO_DAY)
        assert len(stored) == 2
        # No spurious history: nothing about either event changed.
        assert all(repository.get_history(event.id) == [] for event in stored)
    finally:
        repository.close()


def test_native_identity_lookup_finds_the_right_event() -> None:
    repository = SqliteRepository(":memory:")
    try:
        run(
            Window(target_date=DEMO_DAY),
            repository=repository,
            sources=[
                StubSourceAdapter(
                    {
                        DEMO_DAY: [
                            Listing("Weekly Chapter Dinner", source_identity="2001"),
                            Listing("Weekly Chapter Dinner", source_identity="2002"),
                        ]
                    }
                )
            ],
            location_provider=NullLocationProvider(),
            config=Config(),
        )
        found = repository.find_by_identity_key("source|2002")
        assert found is not None
        assert found.id == uuid5(NAMESPACE_URL, "source|2002").hex
        assert repository.find_by_identity_key("source|9999") is None
    finally:
        repository.close()
