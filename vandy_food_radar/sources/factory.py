"""Source wiring factory (design.md §1.1/§3, T2.6, FR-4).

Builds the enabled source adapters for a run and wires the offline
:class:`FixtureFetcher` by default so the corpus is ingested with no live
network. Selection follows the per-source ``enabled`` flags in
:class:`~vandy_food_radar.config.SourcesConfig`.
"""

from __future__ import annotations

from ..config import Config
from ..models import SourceId, SourceRecord
from ._common import build_source_record, corpus_records_for
from .anchor_link import AnchorLinkAdapter
from .base import HttpFetcher, SourceAdapter, Window
from .fixture_fetcher import FixtureFetcher
from .google_calendar import GoogleCalendarAdapter
from .official_page import OfficialPageAdapter


def default_fetcher(config: Config) -> HttpFetcher:
    """Return the fetcher to inject for ``config``.

    Offline runs (the MVP default) use the corpus-backed
    :class:`FixtureFetcher`; a live fetcher is out of scope for the MVP, so an
    online config also falls back to the fixture fetcher for now.
    """

    return FixtureFetcher()


def build_sources(config: Config, fetcher: HttpFetcher) -> list[SourceAdapter]:
    """Return the enabled source adapters, each injected with ``fetcher``.

    When ``config.offline`` is set the ``fetcher`` is expected to be a
    :class:`FixtureFetcher`, so no network is touched.
    """

    adapters: list[SourceAdapter] = []
    if config.sources.anchor_link.enabled:
        adapters.append(AnchorLinkAdapter(fetcher))
    if config.sources.google_calendar.enabled:
        adapters.append(GoogleCalendarAdapter(fetcher))
    if config.sources.official_page.enabled:
        adapters.append(OfficialPageAdapter(fetcher))
    return adapters


class FixtureSourceAdapter:
    """A single adapter that yields every corpus record across all sources.

    Convenience for offline demos/tests that want the whole corpus without
    composing the per-source adapters. Each record keeps its own ``source_id``
    and ``parse_status`` (soft-fails per record, FR-7).
    """

    source_id = "fixture"

    def __init__(self, fetcher: HttpFetcher) -> None:
        self._fetcher = fetcher

    def fetch(self, window: Window) -> list[SourceRecord]:
        """Return one :class:`SourceRecord` per corpus fixture record."""

        records: list[SourceRecord] = []
        for source_id in (
            SourceId.ANCHOR_LINK,
            SourceId.GOOGLE_CALENDAR,
            SourceId.OFFICIAL_PAGE,
        ):
            for raw in corpus_records_for(source_id):
                records.append(build_source_record(source_id, raw, self._fetcher))
        return records
