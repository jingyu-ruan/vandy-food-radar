"""Repository interface for persistence (design.md §2.2, T1.1, FR-33).

Defines the boundary every other layer reads/writes events through. The web,
pipeline, and integration layers depend only on this :class:`typing.Protocol`,
never on a concrete database, so the SQLite backend can be swapped without
touching the core logic.
"""

from __future__ import annotations

from datetime import date
from typing import Protocol

from ..models import (
    Conflict,
    Event,
    EventHistory,
    FieldProvenance,
    ScoreComponent,
    SourceRecord,
)


class Repository(Protocol):
    """Persistence boundary for events and all their attached records.

    Implementations must upsert by ``dedup_key`` so that a repeated scheduled
    run never creates duplicate events or duplicate child rows (FR-42, AC-10).
    """

    def save_event(
        self,
        event: Event,
        source_records: list[SourceRecord],
        provenance: list[FieldProvenance],
        conflicts: list[Conflict],
        score_components: list[ScoreComponent],
    ) -> None:
        """Upsert an event and replace its child rows, keyed on ``dedup_key``.

        A subsequent call with the same ``dedup_key`` updates the existing
        event row in place and replaces its source records, provenance,
        conflicts, and score components rather than duplicating them.
        """
        ...

    def get_events_for_day(self, day: date) -> list[Event]:
        """Return all stored events whose ``event_date`` matches ``day``."""
        ...

    def find_by_dedup_key(self, key: str) -> Event | None:
        """Return the event with ``dedup_key == key``, or ``None``."""
        ...

    def append_history(self, entry: EventHistory) -> None:
        """Append one history row recording a changed detail (FR-43)."""
        ...

    def get_conflicts(self, event_id: str) -> list[Conflict]:
        """Return the recorded conflicts for an event (FR-18)."""
        ...

    def get_score_components(self, event_id: str) -> list[ScoreComponent]:
        """Return the score components for an event (FR-24)."""
        ...

    def get_source_records(self, event_id: str) -> list[SourceRecord]:
        """Return the per-source records for an event (read helper for web)."""
        ...

    def get_history(self, event_id: str) -> list[EventHistory]:
        """Return the change history for an event (read helper for web)."""
        ...
