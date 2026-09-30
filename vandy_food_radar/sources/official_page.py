"""Official/linked event page adapter (design.md §3/§5, T2.4, FR-5, E-11).

Official pages are the top authority for conflict resolution (verify stage) and
some cannot be parsed. This module both ingests official-page records like the
other adapters and exposes :func:`fetch_official_page`, a single-URL helper the
verify stage (FEAT-004) reuses to cross-check one event's details. An
unparseable page yields a ``parse_error`` record and never raises (FR-7, E-11).
"""

from __future__ import annotations

from ..models import SourceId, SourceRecord
from ._common import build_source_record, corpus_records_for
from .base import HttpFetcher, Window


class OfficialPageAdapter:
    """Emit :class:`SourceRecord` objects for official/linked event pages."""

    source_id = SourceId.OFFICIAL_PAGE.value

    def __init__(self, fetcher: HttpFetcher) -> None:
        self._fetcher = fetcher

    def fetch(self, window: Window) -> list[SourceRecord]:
        """Return official-page records for ``window`` (soft-fails per record)."""

        return [
            build_source_record(SourceId.OFFICIAL_PAGE, raw, self._fetcher)
            for raw in corpus_records_for(SourceId.OFFICIAL_PAGE)
        ]


def fetch_official_page(
    record: dict[str, object],
    fetcher: HttpFetcher,
) -> SourceRecord:
    """Fetch a single official-page ``record`` for on-demand verification.

    The verify stage supplies a corpus record (or, later, a live descriptor) and
    receives one :class:`SourceRecord`; a parse/fetch failure surfaces as a
    non-``ok`` ``parse_status`` (FR-7, E-11).
    """

    return build_source_record(SourceId.OFFICIAL_PAGE, dict(record), fetcher)


def official_page_records() -> list[dict[str, object]]:
    """Return the raw official-page corpus records (for verify wiring)."""

    return [dict(record) for record in corpus_records_for(SourceId.OFFICIAL_PAGE)]
