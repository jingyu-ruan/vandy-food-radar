"""Google Calendar source adapter (design.md §3, T2.3, FR-3, E-14).

Ingests events from the Vanderbilt free-food Google Calendar, including
calendar-only events that have no Anchor Link counterpart (E-14). Reads through
the injected fetcher so the offline corpus or a live calendar can back it.
"""

from __future__ import annotations

from ..models import SourceId, SourceRecord
from ._common import build_source_record, corpus_records_for
from .base import HttpFetcher, Window


class GoogleCalendarAdapter:
    """Emit :class:`SourceRecord` objects for Google Calendar events."""

    source_id = SourceId.GOOGLE_CALENDAR.value

    def __init__(self, fetcher: HttpFetcher) -> None:
        self._fetcher = fetcher

    def fetch(self, window: Window) -> list[SourceRecord]:
        """Return calendar records for ``window`` (soft-fails per record)."""

        return [
            build_source_record(SourceId.GOOGLE_CALENDAR, raw, self._fetcher)
            for raw in corpus_records_for(SourceId.GOOGLE_CALENDAR)
        ]
