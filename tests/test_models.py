"""Tests that all six domain entities and their enums import and construct.

Pure data classes — these tests only confirm the shape defined in design.md
§2.1, with nullable fields where the spec allows unknown values.
"""

from __future__ import annotations

from datetime import date, datetime, time

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


def test_event_constructs_with_minimal_fields() -> None:
    event = Event(
        id="evt-1",
        dedup_key="2025-03-11:pizza-night",
        title="Free Pizza Night",
        event_date=date(2025, 3, 11),
    )
    # Nullable fields default to None / unknown.
    assert event.start_time is None
    assert event.location is None
    assert event.rsvp_required is None
    assert event.food_confirmed is FoodConfirmed.UNCONFIRMED
    assert event.food_category is FoodCategory.UNSPECIFIED
    assert event.verification_state is VerificationState.FOOD_UNCONFIRMED


def test_event_accepts_full_field_set() -> None:
    event = Event(
        id="evt-2",
        dedup_key="2025-03-11:dinner",
        title="International Student Dinner",
        event_date=date(2025, 3, 11),
        start_time=time(18, 30),
        end_time=time(20, 30),
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
    assert event.location_geo is not None
    assert event.food_category is FoodCategory.FULL_MEAL


def test_source_record() -> None:
    record = SourceRecord(
        id="src-1",
        event_id="evt-1",
        source_id=SourceId.ANCHOR_LINK,
        source_url="https://anchorlink.vanderbilt.edu/event/1",
        raw_payload="{}",
        parsed_fields={"title": "Free Pizza Night"},
        checked_at=datetime(2025, 3, 10, 18, 0, 0),
        parse_status=ParseStatus.OK,
    )
    assert record.parse_status is ParseStatus.OK
    assert record.parsed_fields["title"] == "Free Pizza Night"


def test_field_provenance() -> None:
    prov = FieldProvenance(
        id="prov-1",
        event_id="evt-1",
        field_name="start_time",
        chosen_value="18:00",
        chosen_source_id=SourceId.OFFICIAL_PAGE,
        agreement=FieldAgreement.RESOLVED_CONFLICT,
    )
    assert prov.agreement is FieldAgreement.RESOLVED_CONFLICT


def test_conflict_preserves_competing_values() -> None:
    conflict = Conflict(
        id="conf-1",
        event_id="evt-1",
        field_name="start_time",
        competing_values=[
            CompetingValue(value="18:00", source_id=SourceId.OFFICIAL_PAGE),
            CompetingValue(value="18:30", source_id=SourceId.GOOGLE_CALENDAR),
        ],
        resolution="authority: official_page",
    )
    assert len(conflict.competing_values) == 2


def test_score_component() -> None:
    component = ScoreComponent(
        id="score-1",
        event_id="evt-1",
        factor=ScoreFactor.FULL_MEAL,
        raw_value=1.0,
        weight=0.25,
        contribution=0.25,
        note="Confirmed full meal.",
    )
    assert component.factor is ScoreFactor.FULL_MEAL
    assert component.contribution == 0.25


def test_event_history() -> None:
    history = EventHistory(
        id="hist-1",
        event_id="evt-1",
        changed_at=datetime(2025, 3, 10, 18, 0, 0),
        field_name="start_time",
        old_value="18:00",
        new_value="18:30",
        reason="source update",
    )
    assert history.reason == "source update"


def test_all_enum_members_present() -> None:
    assert {s.value for s in VerificationState} == {
        "verified",
        "partially_verified",
        "conflicting",
        "food_unconfirmed",
        "cancelled",
    }
    assert {f.value for f in FoodConfirmed} == {
        "confirmed",
        "unconfirmed",
        "contradicted",
    }
    assert {c.value for c in FoodCategory} == {
        "full_meal",
        "snacks_or_refreshments",
        "unspecified",
        "none",
    }
    assert {s.value for s in SourceId} == {
        "anchor_link",
        "google_calendar",
        "official_page",
    }
    assert {p.value for p in ParseStatus} == {
        "ok",
        "parse_error",
        "fetch_error",
    }
