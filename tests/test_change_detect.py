"""Offline tests for pure change detection (M7-M9, FEAT-001, E-2/E-3/E-4/E-9)."""

from __future__ import annotations

from datetime import date, time

from vandy_food_radar.models import Event, VerificationState
from vandy_food_radar.pipeline import (
    ChangeKind,
    detect_changes,
    tally_changes,
)

TARGET_DAY = date(2025, 3, 11)


def _event(
    identity_key: str,
    *,
    start_time: time | None = time(18, 0),
    end_time: time | None = time(19, 0),
    location: str | None = "Hall A",
    verification_state: VerificationState = VerificationState.VERIFIED,
) -> Event:
    return Event(
        id="ignored",
        dedup_key="ignored",
        title="Event",
        event_date=TARGET_DAY,
        identity_key=identity_key,
        start_time=start_time,
        end_time=end_time,
        location=location,
        verification_state=verification_state,
    )


def test_previous_none_all_new() -> None:
    fresh = [_event("k1"), _event("k2")]
    changes = detect_changes(fresh, None)
    assert changes == {"k1": ChangeKind.NEW, "k2": ChangeKind.NEW}


def test_previous_empty_all_new() -> None:
    fresh = [_event("k1")]
    assert detect_changes(fresh, []) == {"k1": ChangeKind.NEW}


def test_new_when_absent_in_previous() -> None:
    changes = detect_changes([_event("k1"), _event("k2")], [_event("k1")])
    assert changes["k2"] is ChangeKind.NEW
    assert changes["k1"] is ChangeKind.UNCHANGED


def test_unchanged_when_identical() -> None:
    prev = [_event("k1")]
    fresh = [_event("k1")]
    assert detect_changes(fresh, prev) == {"k1": ChangeKind.UNCHANGED}


def test_time_changed() -> None:
    prev = [_event("k1", start_time=time(18, 0))]
    fresh = [_event("k1", start_time=time(19, 0))]
    assert detect_changes(fresh, prev) == {"k1": ChangeKind.TIME_CHANGED}


def test_venue_changed() -> None:
    prev = [_event("k1", location="Hall A")]
    fresh = [_event("k1", location="Hall B")]
    assert detect_changes(fresh, prev) == {"k1": ChangeKind.VENUE_CHANGED}


def test_cancelled_when_newly_cancelled() -> None:
    prev = [_event("k1", verification_state=VerificationState.VERIFIED)]
    fresh = [_event("k1", verification_state=VerificationState.CANCELLED)]
    assert detect_changes(fresh, prev) == {"k1": ChangeKind.CANCELLED}


def test_already_cancelled_is_unchanged() -> None:
    prev = [_event("k1", verification_state=VerificationState.CANCELLED)]
    fresh = [_event("k1", verification_state=VerificationState.CANCELLED)]
    assert detect_changes(fresh, prev) == {"k1": ChangeKind.UNCHANGED}


def test_cancelled_takes_precedence_over_time_change() -> None:
    prev = [
        _event(
            "k1",
            start_time=time(18, 0),
            verification_state=VerificationState.VERIFIED,
        )
    ]
    fresh = [
        _event(
            "k1",
            start_time=time(19, 0),
            verification_state=VerificationState.CANCELLED,
        )
    ]
    assert detect_changes(fresh, prev) == {"k1": ChangeKind.CANCELLED}


def test_time_takes_precedence_over_venue() -> None:
    prev = [_event("k1", start_time=time(18, 0), location="Hall A")]
    fresh = [_event("k1", start_time=time(19, 0), location="Hall B")]
    assert detect_changes(fresh, prev) == {"k1": ChangeKind.TIME_CHANGED}


def test_tally_changes_counts() -> None:
    changes = {
        "a": ChangeKind.NEW,
        "b": ChangeKind.NEW,
        "c": ChangeKind.TIME_CHANGED,
        "d": ChangeKind.VENUE_CHANGED,
        "e": ChangeKind.CANCELLED,
        "f": ChangeKind.UNCHANGED,
    }
    counts = tally_changes(changes)
    assert counts.new == 2
    assert counts.time_changed == 1
    assert counts.venue_changed == 1
    assert counts.cancelled == 1
    assert counts.unchanged == 1
