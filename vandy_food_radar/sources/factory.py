"""Mode-aware source wiring for offline fixtures and live AnchorLink."""

from __future__ import annotations

from ..config import Config
from ..models import SourceId, SourceRecord
from ._common import build_source_record, corpus_records_for
from .anchor_link import AnchorLinkAdapter, LiveAnchorLinkAdapter
from .base import HttpFetcher, SourceAdapter, Window
from .fixture_fetcher import FixtureFetcher
from .google_calendar import GoogleCalendarAdapter
from .live_fetcher import UrllibHttpFetcher
from .official_page import OfficialPageAdapter


def default_fetcher(config: Config) -> HttpFetcher:
    """Select a corpus fetcher offline and a real HTTP fetcher live."""

    if config.offline:
        return FixtureFetcher()
    return UrllibHttpFetcher()


def build_sources(config: Config, fetcher: HttpFetcher) -> list[SourceAdapter]:
    """Build only sources that are genuinely implemented for the active mode.

    Offline mode preserves the complete fixture demo. Live mode deliberately
    enables only the native AnchorLink discovery adapter: the calendar and
    official-page adapters currently enumerate fixture manifests and therefore
    must never run in production or manufacture fixture-backed provenance.
    """

    if not config.offline:
        if not config.sources.anchor_link.enabled:
            return []
        return [
            LiveAnchorLinkAdapter(
                fetcher,
                config.sources.anchor_link,
                timezone=config.timezone,
            )
        ]

    adapters: list[SourceAdapter] = []
    if config.sources.anchor_link.enabled:
        adapters.append(AnchorLinkAdapter(fetcher))
    if config.sources.google_calendar.enabled:
        adapters.append(GoogleCalendarAdapter(fetcher))
    if config.sources.official_page.enabled:
        adapters.append(OfficialPageAdapter(fetcher))
    return adapters


class FixtureSourceAdapter:
    """A single adapter that yields every corpus record across all sources."""

    source_id = "fixture"

    def __init__(self, fetcher: HttpFetcher) -> None:
        self._fetcher = fetcher

    def fetch(self, window: Window) -> list[SourceRecord]:
        records: list[SourceRecord] = []
        for source_id in (
            SourceId.ANCHOR_LINK,
            SourceId.GOOGLE_CALENDAR,
            SourceId.OFFICIAL_PAGE,
        ):
            for raw in corpus_records_for(source_id):
                records.append(build_source_record(source_id, raw, self._fetcher))
        return records
