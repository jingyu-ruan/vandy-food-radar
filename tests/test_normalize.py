"""Tests for the normalization stage (FEAT-003, M3, FR-8-FR-11, E-6, E-12).

These exercise pure, deterministic behavior: tz-aware date/time parsing that
flags (never drops) unparseable values, the documented keyword-table food
classifier, and the per-source normalizer that preserves originals.
"""

from __future__ import annotations

from datetime import date

from vandy_food_radar.fixtures import load_json_fixture
from vandy_food_radar.models import (
    FoodCategory,
    FoodConfirmed,
    ParseStatus,
    SourceId,
    SourceRecord,
)
from vandy_food_radar.normalize import (
    classify_food,
    normalize,
    parse_event_date,
    parse_event_time,
)

TZ = "America/Chicago"


def _record_from_fixture(name: str) -> SourceRecord:
    """Build a SourceRecord from a fixture's parsed_fields (no adapter/network)."""

    fixture = load_json_fixture(name)
    return SourceRecord(
        id=f"src-{name}",
        event_id="",
        source_id=SourceId(fixture["source_id"]),
        source_url=fixture.get("source_url"),
        raw_payload=None,
        parsed_fields=dict(fixture["parsed_fields"]),
        parse_status=ParseStatus(fixture.get("parse_status", "ok")),
    )


# ---------------------------------------------------------------------------
# datetime parsing
# ---------------------------------------------------------------------------


def test_valid_date_parses() -> None:
    result = parse_event_date("2025-03-11")
    assert result.ok is True
    assert result.value == date(2025, 3, 11)


def test_valid_time_parses_tz_aware() -> None:
    result = parse_event_time("18:30", TZ)
    assert result.ok is True
    assert result.value is not None
    assert result.value.hour == 18
    assert result.value.minute == 30
    # Timezone-aware: tzinfo attached (FR-10).
    assert result.value.tzinfo is not None


def test_bad_date_is_flagged_not_dropped() -> None:
    result = parse_event_date("March 11")
    assert result.ok is False
    assert result.value is None
    # Raw input preserved so the failure stays explainable (E-12).
    assert result.raw == "March 11"


def test_bad_time_is_flagged_not_dropped() -> None:
    result = parse_event_time("6pm", TZ)
    assert result.ok is False
    assert result.value is None
    assert result.raw == "6pm"


def test_missing_date_and_time_do_not_crash() -> None:
    assert parse_event_date(None).ok is False
    assert parse_event_time(None, TZ).ok is False


def test_unknown_timezone_falls_back_without_raising() -> None:
    result = parse_event_time("09:00", "Not/AZone")
    assert result.ok is True
    assert result.value is not None
    assert result.value.tzinfo is not None


# ---------------------------------------------------------------------------
# food classifier
# ---------------------------------------------------------------------------


def test_refreshments_classified_as_snacks() -> None:
    result = classify_food("Refreshments provided")
    assert result.category is FoodCategory.SNACKS_OR_REFRESHMENTS
    assert result.confirmed is FoodConfirmed.CONFIRMED


def test_dinner_with_menu_is_full_meal_and_confirmed() -> None:
    result = classify_food(
        "Full dinner: chicken tikka masala, jollof rice, dessert. Menu below."
    )
    assert result.category is FoodCategory.FULL_MEAL
    assert result.confirmed is FoodConfirmed.CONFIRMED


def test_empty_description_is_none_unconfirmed() -> None:
    result = classify_food(None)
    assert result.category is FoodCategory.NONE
    assert result.confirmed is FoodConfirmed.UNCONFIRMED


def test_negation_contradicts_food_claim() -> None:
    result = classify_food("Talk only, no free food available.")
    assert result.confirmed is FoodConfirmed.CONTRADICTED


def test_vague_text_without_food_keyword_is_unspecified_unconfirmed() -> None:
    result = classify_food("Come join us for a fun evening.")
    assert result.category is FoodCategory.UNSPECIFIED
    assert result.confirmed is FoodConfirmed.UNCONFIRMED


def test_full_meal_keyword_wins_over_snack_keyword() -> None:
    result = classify_food("Pizza dinner with cookies for dessert.")
    assert result.category is FoodCategory.FULL_MEAL


# ---------------------------------------------------------------------------
# normalizer
# ---------------------------------------------------------------------------


def test_normalize_dinner_fixture() -> None:
    record = _record_from_fixture("dinner_confirmed_menu_anchor_link")
    normalized = normalize(record, timezone=TZ)
    assert normalized.title == "International Student Dinner"
    assert normalized.event_date == date(2025, 3, 11)
    assert normalized.start_time is not None
    assert (normalized.start_time.hour, normalized.start_time.minute) == (18, 30)
    assert normalized.start_time.tzinfo is not None
    assert normalized.food_category is FoodCategory.FULL_MEAL
    assert normalized.food_confirmed is FoodConfirmed.CONFIRMED
    assert normalized.cancelled is False


def test_normalize_refreshments_fixture() -> None:
    record = _record_from_fixture("refreshments_only_anchor_link")
    normalized = normalize(record, timezone=TZ)
    assert normalized.food_category is FoodCategory.SNACKS_OR_REFRESHMENTS


def test_normalize_detects_cancelled_signal() -> None:
    record = _record_from_fixture("cancelled_event_anchor_link")
    normalized = normalize(record, timezone=TZ)
    assert normalized.cancelled is True


def test_normalize_preserves_per_source_originals() -> None:
    record = _record_from_fixture("dinner_confirmed_menu_anchor_link")
    normalized = normalize(record, timezone=TZ)
    # Originals preserved verbatim (FR-9) and the source record is not mutated.
    assert normalized.original_fields == record.parsed_fields
    assert normalized.original_fields is not record.parsed_fields


def test_normalize_flags_unparseable_without_dropping() -> None:
    record = SourceRecord(
        id="src-bad",
        event_id="",
        source_id=SourceId.ANCHOR_LINK,
        parsed_fields={
            "title": "Mystery Event",
            "event_date": "not-a-date",
            "start_time": "later",
            "end_time": None,
        },
    )
    normalized = normalize(record, timezone=TZ)
    assert normalized.title == "Mystery Event"
    assert normalized.event_date is None
    assert normalized.date_flagged is True
    assert normalized.start_time is None
    assert normalized.start_time_flagged is True
    # A missing (None) value is not "flagged" as a parse failure.
    assert normalized.end_time_flagged is False


def test_normalize_tolerates_missing_and_null_fields() -> None:
    record = SourceRecord(
        id="src-empty",
        event_id="",
        source_id=SourceId.GOOGLE_CALENDAR,
        parsed_fields={},
    )
    normalized = normalize(record, timezone=TZ)
    assert normalized.title is None
    assert normalized.location is None
    assert normalized.rsvp_required is None
    assert normalized.food_category is FoodCategory.NONE
    assert normalized.food_confirmed is FoodConfirmed.UNCONFIRMED


def test_normalize_soft_fails_on_parse_error_record() -> None:
    record = SourceRecord(
        id="src-perr",
        event_id="",
        source_id=SourceId.OFFICIAL_PAGE,
        parsed_fields={},
        parse_status=ParseStatus.PARSE_ERROR,
    )
    normalized = normalize(record, timezone=TZ)
    assert normalized.parse_status is ParseStatus.PARSE_ERROR
    assert normalized.title is None
