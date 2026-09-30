"""Source ingestion layer for Vandy Food Radar (design.md §1.1/§3, T2.1-T2.6).

Exposes the ingestion seams (:class:`HttpFetcher`, :class:`SourceAdapter`,
:class:`Window`, :class:`FetchResult`), the offline :class:`FixtureFetcher`, the
three concrete source adapters, and the :func:`build_sources` factory that wires
fixture sources by default so the app discovers events with no live network.
"""

from __future__ import annotations

from .anchor_link import AnchorLinkAdapter
from .base import FetchResult, HttpFetcher, SourceAdapter, Window
from .factory import FixtureSourceAdapter, build_sources, default_fetcher
from .fixture_fetcher import FixtureFetcher
from .google_calendar import GoogleCalendarAdapter
from .official_page import (
    OfficialPageAdapter,
    fetch_official_page,
    official_page_records,
)

__all__ = [
    "AnchorLinkAdapter",
    "FetchResult",
    "FixtureFetcher",
    "FixtureSourceAdapter",
    "GoogleCalendarAdapter",
    "HttpFetcher",
    "OfficialPageAdapter",
    "SourceAdapter",
    "Window",
    "build_sources",
    "default_fetcher",
    "fetch_official_page",
    "official_page_records",
]
