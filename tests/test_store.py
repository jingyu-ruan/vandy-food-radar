"""Tests for the SQLite persistence layer (design.md §2.2, T1.3, FR-42, AC-10).

Covers a full round-trip of every entity, upsert idempotency by ``dedup_key``,
and history accumulation across saves. All in-memory / tmp file — no network.
"""

from __future__ import annotations

from datetime import date, datetime, time
from pathlib import Path

from vandy_food_radar.models import (
    CompetingValue,
    Conflict,
    Event,
    EventHistory,
    FieldAgreement,
    FieldProvenance,
    FoodCategory,
    FoodConfirmed,
    GeoPoint,
    ParseStatus,
    ScoreComponent,
    ScoreFactor,
    SourceId,
    SourceRecord,
    VerificationState,
)
from vandy_food_radar.store import SqliteRepository


def _make_event(dedup_key: str = "2025-03-11:dinner") -> Event:
    return Event(
        id="evt-1",
        dedup_key=dedup_key,
        title="International Student Dinner",
        event_date=date(2025, 3, 11),
        start_time=time(18, 0),
        end_time=time(20, 0),
        location="Student Life Center, Ballroom A",
        location_geo=GeoPoint(lat=36.14, lng=-86.80),
        organizer="International Student Services",
        rsvp_required=True,
        rsvp_url="https://example.edu/rsvp",
        rsvp_link_ok=True,
        event_url="https://example.edu/event",
        food_confirmed=FoodConfirmed.CONFIRMED,
        food_category=FoodCategory.FULL_MEAL,
        food_description="Full dinner with a specific menu.",
        verification_state=VerificationState.VERIFIED,
        confidence=0.9,
        score_total=0.82,
        created_at=datetime(2025, 3, 10, 18, 0, 0),
        updated_at=datetime(2025, 3, 10, 18, 0, 0),
    )


def _make_children(
    event_id: str = "evt-1",
) -> tuple[
    list[SourceRecord],
    list[FieldProvenance],
    list[Conflict],
    list[ScoreComponent],
]:
    source_records = [
        SourceRecord(
            id="src-1",
            event_id=event_id,
            source_id=SourceId.OFFICIAL_PAGE,
            source_url="https://example.edu/event",
            raw_payload='{"raw": true}',
            parsed_fields={"title": "International Student Dinner", "rsvp": True},
            checked_at=datetime(2025, 3, 10, 17, 0, 0),
            parse_status=ParseStatus.OK,
            source_updated_at=datetime(2025, 3, 10, 16, 0, 0),
        ),
        SourceRecord(
            id="src-2",
            event_id=event_id,
            source_id=SourceId.GOOGLE_CALENDAR,
            source_url="https://calendar.example.edu/e/2",
            raw_payload='{"raw": false}',
            parsed_fields={"title": "Intl Student Dinner"},
            checked_at=datetime(2025, 3, 10, 17, 5, 0),
            parse_status=ParseStatus.OK,
            source_updated_at=None,
        ),
    ]
    provenance = [
        FieldProvenance(
            id="prov-1",
            event_id=event_id,
            field_name="start_time",
            chosen_value="18:00",
            chosen_source_id=SourceId.OFFICIAL_PAGE,
            agreement=FieldAgreement.RESOLVED_CONFLICT,
        )
    ]
    conflicts = [
        Conflict(
            id="conf-1",
            event_id=event_id,
            field_name="start_time",
            competing_values=[
                CompetingValue(value="18:00", source_id=SourceId.OFFICIAL_PAGE),
                CompetingValue(
                    value="18:30",
                    source_id=SourceId.GOOGLE_CALENDAR,
                    source_updated_at=datetime(2025, 3, 9, 12, 0, 0),
                ),
            ],
            resolution="authority: official_page",
        )
    ]
    score_components = [
        ScoreComponent(
            id="score-1",
            event_id=event_id,
            factor=ScoreFactor.FULL_MEAL,
            raw_value=1.0,
            weight=0.25,
            contribution=0.25,
            note="Confirmed full meal.",
        )
    ]
    return source_records, provenance, conflicts, score_components


def test_round_trip_event_and_children() -> None:
    repo = SqliteRepository(":memory:")
    event = _make_event()
    source_records, provenance, conflicts, score_components = _make_children()
    repo.save_event(event, source_records, provenance, conflicts, score_components)

    stored = repo.find_by_dedup_key(event.dedup_key)
    assert stored == event

    day_events = repo.get_events_for_day(date(2025, 3, 11))
    assert day_events == [event]

    assert repo.get_source_records(event.id) == source_records
    assert repo.get_conflicts(event.id) == conflicts
    assert repo.get_score_components(event.id) == score_components


def test_upsert_is_idempotent_by_dedup_key() -> None:
    repo = SqliteRepository(":memory:")
    event = _make_event()
    children = _make_children()
    repo.save_event(event, *children)

    # Second save with the same dedup_key updates in place.
    updated = _make_event()
    updated.location = "Student Life Center, Ballroom B"
    updated.updated_at = datetime(2025, 3, 10, 19, 0, 0)
    repo.save_event(updated, *_make_children())

    assert repo.get_events_for_day(date(2025, 3, 11)) == [updated]

    stored = repo.find_by_dedup_key(event.dedup_key)
    assert stored is not None
    assert stored.location == "Student Life Center, Ballroom B"

    # No duplicated child rows after re-save.
    assert len(repo.get_source_records(event.id)) == 2
    assert len(repo.get_conflicts(event.id)) == 1
    assert len(repo.get_score_components(event.id)) == 1


def test_append_history_accumulates_without_duplication() -> None:
    repo = SqliteRepository(":memory:")
    event = _make_event()
    repo.save_event(event, *_make_children())

    repo.append_history(
        EventHistory(
            id="hist-1",
            event_id=event.id,
            changed_at=datetime(2025, 3, 10, 18, 0, 0),
            field_name="start_time",
            old_value="18:00",
            new_value="18:30",
            reason="source update",
        )
    )

    # Second save (same dedup_key) followed by another history row.
    changed = _make_event()
    changed.start_time = time(18, 30)
    repo.save_event(changed, *_make_children())
    repo.append_history(
        EventHistory(
            id="hist-2",
            event_id=event.id,
            changed_at=datetime(2025, 3, 11, 9, 0, 0),
            field_name="location",
            old_value="Ballroom A",
            new_value="Ballroom B",
            reason="venue change",
        )
    )

    history = repo.get_history(event.id)
    assert [h.id for h in history] == ["hist-1", "hist-2"]
    assert history[0].new_value == "18:30"
    assert history[1].field_name == "location"


def test_find_by_dedup_key_missing_returns_none() -> None:
    repo = SqliteRepository(":memory:")
    assert repo.find_by_dedup_key("nope") is None


def test_accepts_tmp_path_db_file(tmp_path: Path) -> None:
    db_file = str(tmp_path / "store.db")
    repo = SqliteRepository(db_file)
    event = _make_event()
    repo.save_event(event, *_make_children())
    repo.close()

    reopened = SqliteRepository(db_file)
    assert reopened.find_by_dedup_key(event.dedup_key) == event
    reopened.close()
