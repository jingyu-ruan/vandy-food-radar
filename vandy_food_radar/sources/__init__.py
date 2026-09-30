"""Source ingestion seams and offline/live adapters."""

from __future__ import annotations

from .anchor_link import (
    AnchorLinkAdapter,
    AnchorLinkFetchError,
    LiveAnchorLinkAdapter,
)
from .base import FetchResult, HttpFetcher, SourceAdapter, Window
from .factory import FixtureSourceAdapter, build_sources, default_fetcher
from .fixture_fetcher import FixtureFetcher
from .google_calendar import GoogleCalendarAdapter
from .live_fetcher import UrllibHttpFetcher
from .official_page import (
    OfficialPageAdapter,
    fetch_official_page,
    official_page_records,
)

__all__ = [
    "AnchorLinkAdapter",
    "AnchorLinkFetchError",
    "FetchResult",
    "FixtureFetcher",
    "FixtureSourceAdapter",
    "GoogleCalendarAdapter",
    "HttpFetcher",
    "LiveAnchorLinkAdapter",
    "OfficialPageAdapter",
    "SourceAdapter",
    "UrllibHttpFetcher",
    "Window",
    "build_sources",
    "default_fetcher",
    "fetch_official_page",
    "official_page_records",
]
