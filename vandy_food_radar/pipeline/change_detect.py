"""Pure cross-run change detection (FR-42/FR-43, E-2/E-3/E-4/E-9).

Compares a fresh run's canonical events against the previous run's snapshot
and classifies each event by ``identity_key``. Deterministic and I/O-free: it
operates only on the events handed to it (typically decoded from a
:class:`~vandy_food_radar.store.SnapshotStore`).

Classification precedence, highest first:
CANCELLED > TIME_CHANGED > VENUE_CHANGED > NEW > UNCHANGED.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from ..models import Event, VerificationState


class ChangeKind(StrEnum):
    """How a fresh event compares to the previous snapshot."""

    NEW = "new"
    TIME_CHANGED = "time_changed"
    VENUE_CHANGED = "venue_changed"
    CANCELLED = "cancelled"
    UNCHANGED = "unchanged"


@dataclass
class ChangeFlag:
    """A single event's change classification."""

    identity_key: str
    kind: ChangeKind


def _classify(fresh: Event, previous: Event) -> ChangeKind:
    """Classify ``fresh`` against its ``previous`` counterpart (same key)."""

    was_cancelled = previous.verification_state is VerificationState.CANCELLED
    is_cancelled = fresh.verification_state is VerificationState.CANCELLED
    if is_cancelled and not was_cancelled:
        return ChangeKind.CANCELLED
    if fresh.start_time != previous.start_time or fresh.end_time != previous.end_time:
        return ChangeKind.TIME_CHANGED
    if fresh.location != previous.location:
        return ChangeKind.VENUE_CHANGED
    return ChangeKind.UNCHANGED


def detect_changes(
    fresh: list[Event], previous: list[Event] | None
) -> dict[str, ChangeKind]:
    """Classify each fresh event by ``identity_key`` against ``previous``.

    A missing/empty ``previous`` means every fresh event is :attr:`ChangeKind.NEW`
    (E-9). An identity_key absent from ``previous`` is NEW; otherwise precedence
    is CANCELLED (E-4) > TIME_CHANGED (E-2) > VENUE_CHANGED (E-3) > UNCHANGED.
    """

    previous_by_key: dict[str, Event] = {}
    if previous:
        previous_by_key = {event.identity_key: event for event in previous}

    changes: dict[str, ChangeKind] = {}
    for event in fresh:
        prior = previous_by_key.get(event.identity_key)
        if prior is None:
            changes[event.identity_key] = ChangeKind.NEW
        else:
            changes[event.identity_key] = _classify(event, prior)
    return changes


@dataclass
class ChangeCounts:
    """Per-kind tallies over a change map."""

    new: int = 0
    time_changed: int = 0
    venue_changed: int = 0
    cancelled: int = 0
    unchanged: int = 0


def tally_changes(changes: dict[str, ChangeKind]) -> ChangeCounts:
    """Count occurrences of each :class:`ChangeKind` in ``changes``."""

    counts = ChangeCounts()
    for kind in changes.values():
        if kind is ChangeKind.NEW:
            counts.new += 1
        elif kind is ChangeKind.TIME_CHANGED:
            counts.time_changed += 1
        elif kind is ChangeKind.VENUE_CHANGED:
            counts.venue_changed += 1
        elif kind is ChangeKind.CANCELLED:
            counts.cancelled += 1
        else:
            counts.unchanged += 1
    return counts


__all__ = [
    "ChangeKind",
    "ChangeFlag",
    "ChangeCounts",
    "detect_changes",
    "tally_changes",
]
