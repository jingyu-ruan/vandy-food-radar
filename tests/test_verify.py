"""Tests for the verification & conflict-resolution stage (FEAT-005, M5).

Deterministic behavior over merged events: per-field cross-check with
provenance, authority-precedence conflict resolution with a recency tie-break
that preserves losing values, official-page verification that degrades
gracefully on parse failure, event-level ``verification_state`` + confidence
(including food disagreement and broken RSVP links), and cancellation detection
with a history entry. No network/DB/file I/O beyond loading the offline corpus.
"""

from __future__ import annotations

from datetime import UTC, datetime, time
from zoneinfo import ZoneInfo

from vandy_food_radar.config import Config, DedupConfig
from vandy_food_radar.dedup import MergedEvent, deduplicate
from vandy_food_radar.fixtures import load_json_fixture
from vandy_food_radar.models import (
    FieldAgreement,
    FoodConfirmed,
    ParseStatus,
    SourceId,
    SourceRecord,
    VerificationState,
)
from vandy_food_radar.normalize import NormalizedRecord, normalize
from vandy_food_radar.verify import CROSS_CHECKED_FIELDS, verify

TZ = "America/Chicago"
CFG = Config()
DEDUP = DedupConfig()


def _source_record_from_fixture(name: str) -> SourceRecord:
    """Build a SourceRecord from a fixture, preserving its timestamps (no net)."""

    fixture = load_json_fixture(name)
    return SourceRecord(
        id=f"src-{name}",
        event_id="",
        source_id=SourceId(fixture["source_id"]),
        source_url=fixture.get("source_url"),
        raw_payload=None,
        parsed_fields=dict(fixture.get("parsed_fields") or {}),
        checked_at=_iso(fixture.get("checked_at")),
        parse_status=ParseStatus(fixture.get("parse_status", "ok")),
        source_updated_at=_iso(fixture.get("source_updated_at")),
    )


def _iso(value: object) -> datetime | None:
    if isinstance(value, str) and value:
        return datetime.fromisoformat(value)
    return None


def _normalized(record: SourceRecord) -> NormalizedRecord:
    return normalize(record, timezone=TZ)


def _merged_from(
    names: list[str],
) -> tuple[MergedEvent, dict[str, SourceRecord]]:
    """Deduplicate the named fixtures into one MergedEvent + a source map."""

    sources = [_source_record_from_fixture(name) for name in names]
    source_map = {s.id: s for s in sources}
    records = [_normalized(s) for s in sources]
    merged = deduplicate(records, config=DEDUP)
    assert len(merged) == 1, f"expected a single merged event, got {len(merged)}"
    return merged[0], source_map


# ---------------------------------------------------------------------------
# per-field provenance (T5.1, FR-16/17)
# ---------------------------------------------------------------------------


def test_provenance_covers_every_cross_checked_field() -> None:
    merged, sources = _merged_from(
        ["pizza_night_anchor_link", "pizza_night_google_calendar"]
    )
    result = verify(merged, sources, config=CFG)

    covered = {p.field_name for p in result.provenance}
    assert covered == set(CROSS_CHECKED_FIELDS)


# ---------------------------------------------------------------------------
# conflict resolution + recency tie-break (T5.2, AC-5)
# ---------------------------------------------------------------------------


def test_career_mixer_resolves_to_official_page_and_keeps_loser() -> None:
    merged, sources = _merged_from(
        [
            "conflicting_time_anchor_link",
            "conflicting_time_google_calendar",
            "conflicting_time_official_page",
        ]
    )
    result = verify(merged, sources, config=CFG)

    # Canonical start time comes from the higher-authority official page.
    assert result.event.start_time == time(18, 0)
    assert result.event.verification_state is VerificationState.CONFLICTING

    start_conflicts = [c for c in result.conflicts if c.field_name == "start_time"]
    assert len(start_conflicts) == 1
    conflict = start_conflicts[0]
    # All competing values preserved, including the losing 18:30.
    competing = {(c.source_id, c.value) for c in conflict.competing_values}
    assert (SourceId.OFFICIAL_PAGE, time(18, 0)) in competing
    assert (SourceId.GOOGLE_CALENDAR, time(18, 30)) in competing
    provenance = {p.field_name: p for p in result.provenance}
    assert provenance["start_time"].agreement is FieldAgreement.RESOLVED_CONFLICT
    assert provenance["start_time"].chosen_source_id is SourceId.OFFICIAL_PAGE


def test_recency_tie_break_selects_most_recently_updated() -> None:
    # Two records of equal authority (both anchor_link): the newer update wins.
    day_time = time(18, 0, tzinfo=ZoneInfo(TZ))
    older = SourceRecord(
        id="older",
        event_id="",
        source_id=SourceId.ANCHOR_LINK,
        parsed_fields={"title": "Gala", "event_date": "2025-03-11", "location": "A"},
        source_updated_at=datetime(2025, 3, 8, tzinfo=UTC),
    )
    newer = SourceRecord(
        id="newer",
        event_id="",
        source_id=SourceId.ANCHOR_LINK,
        parsed_fields={"title": "Gala", "event_date": "2025-03-11", "location": "B"},
        source_updated_at=datetime(2025, 3, 10, tzinfo=UTC),
    )
    sources = {older.id: older, newer.id: newer}
    records = [_normalized(older), _normalized(newer)]
    for r in records:
        r.start_time = day_time
    merged = deduplicate(records, config=DEDUP)
    assert len(merged) == 1

    result = verify(merged[0], sources, config=CFG)
    # Location "B" (from the more recently updated record) wins the tie.
    assert result.event.location == "B"


# ---------------------------------------------------------------------------
# food disagreement (T5.4, AC-6, E-5)
# ---------------------------------------------------------------------------


def test_food_confirmed_on_one_source_only_is_not_fully_verified() -> None:
    confirmed = SourceRecord(
        id="confirmed",
        event_id="",
        source_id=SourceId.OFFICIAL_PAGE,
        parsed_fields={
            "title": "Study Jam",
            "event_date": "2025-03-11",
            "start_time": "18:00",
            "location": "Commons",
            "food_confirmed": "confirmed",
            "food_description": "Free pizza.",
        },
        source_updated_at=datetime(2025, 3, 10, tzinfo=UTC),
    )
    silent = SourceRecord(
        id="silent",
        event_id="",
        source_id=SourceId.GOOGLE_CALENDAR,
        parsed_fields={
            "title": "Study Jam",
            "event_date": "2025-03-11",
            "start_time": "18:00",
            "location": "Commons",
        },
        source_updated_at=datetime(2025, 3, 10, tzinfo=UTC),
    )
    sources = {confirmed.id: confirmed, silent.id: silent}
    merged = deduplicate([_normalized(confirmed), _normalized(silent)], config=DEDUP)
    assert len(merged) == 1

    result = verify(merged[0], sources, config=CFG)
    assert result.event.food_confirmed is FoodConfirmed.UNCONFIRMED
    assert result.event.verification_state is VerificationState.FOOD_UNCONFIRMED

    # Confidence is lower than the same event with food confirmed on both.
    confirmed_both = SourceRecord(
        id="silent2",
        event_id="",
        source_id=SourceId.GOOGLE_CALENDAR,
        parsed_fields={**silent.parsed_fields, "food_confirmed": "confirmed"},
        source_updated_at=datetime(2025, 3, 10, tzinfo=UTC),
    )
    sources2 = {confirmed.id: confirmed, confirmed_both.id: confirmed_both}
    merged2 = deduplicate(
        [_normalized(confirmed), _normalized(confirmed_both)], config=DEDUP
    )
    result2 = verify(merged2[0], sources2, config=CFG)
    assert result2.event.confidence is not None and result.event.confidence is not None
    assert result.event.confidence < result2.event.confidence


# ---------------------------------------------------------------------------
# cancellation (T5.5, AC-12, E-4)
# ---------------------------------------------------------------------------


def test_cancelled_event_sets_state_and_appends_history() -> None:
    source = _source_record_from_fixture("cancelled_event_anchor_link")
    sources = {source.id: source}
    merged = deduplicate([_normalized(source)], config=DEDUP)

    result = verify(merged[0], sources, config=CFG)

    assert result.event.verification_state is VerificationState.CANCELLED
    assert len(result.history) == 1
    entry = result.history[0]
    assert entry.field_name == "verification_state"
    assert entry.new_value == VerificationState.CANCELLED.value
    assert entry.event_id == result.event.id


# ---------------------------------------------------------------------------
# graceful degradation on unparseable official page (T5.3, AC-9, E-11)
# ---------------------------------------------------------------------------


def test_unparseable_official_page_degrades_gracefully() -> None:
    anchor = _source_record_from_fixture("conflicting_time_anchor_link")
    unparseable = _source_record_from_fixture("unparseable_official_page")
    # Force the two onto the same cluster so the bad official record is a member.
    anchor_norm = _normalized(anchor)
    bad_norm = _normalized(unparseable)
    bad_norm.title = anchor_norm.title
    bad_norm.event_date = anchor_norm.event_date
    bad_norm.start_time = anchor_norm.start_time
    bad_norm.location = anchor_norm.location
    sources = {anchor.id: anchor, unparseable.id: unparseable}
    merged = deduplicate([anchor_norm, bad_norm], config=DEDUP)
    assert len(merged) == 1

    result = verify(merged[0], sources, config=CFG)

    # Event is still produced from the parseable source; no crash.
    assert result.event.start_time == time(18, 0)
    # The unparseable official page contributed no field values.
    assert result.event.title is not None


# ---------------------------------------------------------------------------
# broken RSVP link (E-8)
# ---------------------------------------------------------------------------


def test_broken_rsvp_link_is_flagged() -> None:
    source = SourceRecord(
        id="broken-rsvp",
        event_id="",
        source_id=SourceId.ANCHOR_LINK,
        parsed_fields={
            "title": "RSVP Dinner",
            "event_date": "2025-03-11",
            "start_time": "18:00",
            "location": "Commons",
            "rsvp_required": True,
            "rsvp_url": "https://anchorlink.vanderbilt.edu/rsvp/dead",
            "food_confirmed": "confirmed",
            "food_description": "Catered dinner.",
        },
        checked_at=datetime(2025, 3, 10, tzinfo=UTC),
        parse_status=ParseStatus.FETCH_ERROR,
    )
    sources = {source.id: source}
    merged = deduplicate([_normalized(source)], config=DEDUP)

    result = verify(merged[0], sources, config=CFG)
    assert result.event.rsvp_link_ok is False


def test_healthy_rsvp_link_is_ok() -> None:
    source = _source_record_from_fixture("conflicting_time_anchor_link")
    sources = {source.id: source}
    merged = deduplicate([_normalized(source)], config=DEDUP)
    result = verify(merged[0], sources, config=CFG)
    assert result.event.rsvp_link_ok is True
