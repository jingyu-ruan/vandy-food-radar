"""Tests for the deduplication stage (FEAT-004, M4, FR-12-FR-15, E-1, E-10, E-13).

Deterministic behavior over normalized records: title/time/location/organizer
similarity with date blocking, threshold-driven clustering that flags borderline
merges as ``possible_duplicate``, and a stable ``dedup_key`` for idempotent
upsert. No network/DB/file I/O beyond loading the offline fixture corpus.
"""

from __future__ import annotations

from datetime import date, time
from zoneinfo import ZoneInfo

from vandy_food_radar.config import DedupConfig
from vandy_food_radar.dedup import (
    compute_dedup_key,
    compute_identity_key,
    deduplicate,
    time_proximity,
    title_sim,
)
from vandy_food_radar.fixtures import load_json_fixture
from vandy_food_radar.models import (
    FoodCategory,
    FoodConfirmed,
    ParseStatus,
    SourceId,
    SourceRecord,
)
from vandy_food_radar.normalize import NormalizedRecord, normalize

TZ = "America/Chicago"
CFG = DedupConfig()


def _normalized_from_fixture(name: str) -> NormalizedRecord:
    """Build a NormalizedRecord from a fixture's parsed_fields (no network)."""

    fixture = load_json_fixture(name)
    record = SourceRecord(
        id=f"src-{name}",
        event_id="",
        source_id=SourceId(fixture["source_id"]),
        source_url=fixture.get("source_url"),
        raw_payload=None,
        parsed_fields=dict(fixture["parsed_fields"]),
        parse_status=ParseStatus(fixture.get("parse_status", "ok")),
    )
    return normalize(record, timezone=TZ)


def _synthetic(
    *,
    record_id: str,
    source_id: SourceId,
    title: str,
    event_date: date,
    start_time: time | None,
    location: str | None = None,
    organizer: str | None = None,
) -> NormalizedRecord:
    """A minimal NormalizedRecord for controlled dedup scenarios."""

    return NormalizedRecord(
        source_id=source_id,
        source_record_id=record_id,
        parse_status=ParseStatus.OK,
        title=title,
        event_date=event_date,
        start_time=start_time,
        location=location,
        organizer=organizer,
        food_confirmed=FoodConfirmed.CONFIRMED,
        food_category=FoodCategory.FULL_MEAL,
    )


# ---------------------------------------------------------------------------
# similarity primitives
# ---------------------------------------------------------------------------


def test_title_sim_matches_reworded_titles() -> None:
    # "Free Pizza Night" vs "Pizza Night (Free!)" -> tokens {pizza, night}.
    assert title_sim("Free Pizza Night", "Pizza Night (Free!)") == 1.0


def test_title_sim_distinguishes_different_events() -> None:
    assert title_sim("Salsa Dance Social", "Chess Club Meetup") == 0.0


def test_time_proximity_decays_within_window() -> None:
    at_six = time(18, 0, tzinfo=ZoneInfo(TZ))
    same = time(18, 0, tzinfo=ZoneInfo(TZ))
    fifteen_later = time(18, 15, tzinfo=ZoneInfo(TZ))
    far = time(19, 0, tzinfo=ZoneInfo(TZ))
    assert time_proximity(at_six, same, window_minutes=30) == 1.0
    assert time_proximity(at_six, fifteen_later, window_minutes=30) == 0.5
    assert time_proximity(at_six, far, window_minutes=30) == 0.0


def test_time_proximity_unknown_time_is_zero() -> None:
    assert time_proximity(None, time(18, 0), window_minutes=30) == 0.0


# ---------------------------------------------------------------------------
# merge behavior (AC-4, E-10, E-13)
# ---------------------------------------------------------------------------


def test_pizza_night_sources_merge_into_one_event() -> None:
    anchor = _normalized_from_fixture("pizza_night_anchor_link")
    gcal = _normalized_from_fixture("pizza_night_google_calendar")

    merged = deduplicate([anchor, gcal], config=CFG)

    assert len(merged) == 1
    event = merged[0]
    # Both source records are linked to the single merged event (AC-4).
    assert len(event.members) == 2
    linked_sources = {m.source_id for m in event.members}
    assert linked_sources == {SourceId.ANCHOR_LINK, SourceId.GOOGLE_CALENDAR}
    # High-confidence match, not a borderline one.
    assert event.possible_duplicate is False


def test_same_time_different_events_do_not_merge() -> None:
    # Two genuinely different events at the same start time (E-13).
    day = date(2025, 3, 11)
    at_six = time(18, 0, tzinfo=ZoneInfo(TZ))
    salsa = _synthetic(
        record_id="salsa",
        source_id=SourceId.ANCHOR_LINK,
        title="Salsa Dance Social",
        event_date=day,
        start_time=at_six,
        location="Student Life Center, Ballroom A",
        organizer="Latin Dance Club",
    )
    chess = _synthetic(
        record_id="chess",
        source_id=SourceId.ANCHOR_LINK,
        title="Chess Club Tournament",
        event_date=day,
        start_time=at_six,
        location="Sarratt Student Center, Room 189",
        organizer="Chess Club",
    )

    merged = deduplicate([salsa, chess], config=CFG)

    assert len(merged) == 2
    assert {len(m.members) for m in merged} == {1}


def test_recurring_title_on_different_days_does_not_merge() -> None:
    # Same recurring event on two different dates must stay separate (E-10).
    at_three = time(15, 0, tzinfo=ZoneInfo(TZ))
    tuesday = _synthetic(
        record_id="week1",
        source_id=SourceId.ANCHOR_LINK,
        title="Weekly Free Coffee Hour",
        event_date=date(2025, 3, 11),
        start_time=at_three,
        location="Central Library Commons",
        organizer="Library Services",
    )
    next_tuesday = _synthetic(
        record_id="week2",
        source_id=SourceId.ANCHOR_LINK,
        title="Weekly Free Coffee Hour",
        event_date=date(2025, 3, 18),
        start_time=at_three,
        location="Central Library Commons",
        organizer="Library Services",
    )

    merged = deduplicate([tuesday, next_tuesday], config=CFG)

    assert len(merged) == 2
    assert {m.members[0].event_date for m in merged} == {
        date(2025, 3, 11),
        date(2025, 3, 18),
    }


# ---------------------------------------------------------------------------
# dedup_key determinism (FR-42)
# ---------------------------------------------------------------------------


def test_dedup_key_is_stable_across_repeated_runs() -> None:
    anchor = _normalized_from_fixture("pizza_night_anchor_link")
    gcal = _normalized_from_fixture("pizza_night_google_calendar")

    first = deduplicate([anchor, gcal], config=CFG)
    second = deduplicate([gcal, anchor], config=CFG)

    assert len(first) == len(second) == 1
    # Stable regardless of input order across runs (idempotent upsert).
    assert first[0].dedup_key == second[0].dedup_key


def test_dedup_key_reworded_titles_share_key() -> None:
    day = date(2025, 3, 11)
    at_six = time(18, 0, tzinfo=ZoneInfo(TZ))
    key_a = compute_dedup_key(day, "Free Pizza Night", "Sarratt 216", at_six)
    key_b = compute_dedup_key(day, "Pizza Night (Free!)", "Sarratt 216", at_six)
    assert key_a == key_b


def test_dedup_key_differs_by_date() -> None:
    at_six = time(18, 0, tzinfo=ZoneInfo(TZ))
    key_tue = compute_dedup_key(date(2025, 3, 11), "Coffee Hour", "Library", at_six)
    key_next = compute_dedup_key(date(2025, 3, 18), "Coffee Hour", "Library", at_six)
    assert key_tue != key_next


def test_identity_key_is_stable_across_time_and_venue_changes() -> None:
    # A verified time or venue change must keep the same cross-run identity so
    # the event updates in place rather than duplicating (FR-42, E-2, E-3).
    day = date(2025, 3, 11)
    base = compute_identity_key(day, "Gala Dinner")
    assert compute_identity_key(day, "Gala Dinner (Free!)") == base
    # dedup_key, by contrast, shifts when the time or venue moves.
    at_six = time(18, 0, tzinfo=ZoneInfo(TZ))
    at_seven = time(19, 0, tzinfo=ZoneInfo(TZ))
    assert compute_dedup_key(day, "Gala Dinner", "Hall A", at_six) != compute_dedup_key(
        day, "Gala Dinner", "Hall A", at_seven
    )


def test_identity_key_differs_by_date_and_title() -> None:
    day = date(2025, 3, 11)
    assert compute_identity_key(day, "Coffee Hour") != compute_identity_key(
        date(2025, 3, 18), "Coffee Hour"
    )
    assert compute_identity_key(day, "Coffee Hour") != compute_identity_key(
        day, "Tea Social"
    )


def test_distinct_provider_events_with_same_fingerprint_have_unique_ids() -> None:
    records = []
    for source_number in (101, 102):
        record = _synthetic(
            record_id=f"anchor-{source_number}",
            source_id=SourceId.ANCHOR_LINK,
            title="Community Study Break",
            event_date=date(2026, 9, 30),
            start_time=time(20, 30),
            location="Memorial Circle",
            organizer="Residential Education",
        )
        record.source_identity = f"anchorlink:{source_number}"
        records.append(record)

    first = deduplicate(records, config=CFG)
    repeated = deduplicate(records, config=CFG)
    assert len(first) == 2
    assert first[0].dedup_key == first[1].dedup_key
    assert first[0].event.id != first[1].event.id
    assert [item.event.id for item in first] == [item.event.id for item in repeated]


def test_borderline_match_flags_possible_duplicate() -> None:
    # Same title/day and same venue but times ~20 min apart with differing
    # organizers -> mid-range score that merges yet is flagged for review
    # ([review_low, merge_threshold)).
    day = date(2025, 3, 11)
    a = _synthetic(
        record_id="a",
        source_id=SourceId.ANCHOR_LINK,
        title="Study Break Snacks",
        event_date=day,
        start_time=time(14, 0, tzinfo=ZoneInfo(TZ)),
        location="Commons Center",
        organizer="Residential Education",
    )
    b = _synthetic(
        record_id="b",
        source_id=SourceId.GOOGLE_CALENDAR,
        title="Study Break Snacks",
        event_date=day,
        start_time=time(14, 20, tzinfo=ZoneInfo(TZ)),
        location="Commons Center",
        organizer="Housing Office",
    )

    merged = deduplicate([a, b], config=CFG)

    assert len(merged) == 1
    assert merged[0].possible_duplicate is True
