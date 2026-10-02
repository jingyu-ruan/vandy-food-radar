"""Source ingestion interfaces for the Discover stage (design.md §1.1/§3, T2.1).

Defines the seams the rest of the pipeline depends on so live network access can
be swapped for the offline fixture corpus without touching adapter logic
(FR-4). A :class:`SourceAdapter` reads through an injected :class:`HttpFetcher`
and emits :class:`~vandy_food_radar.models.SourceRecord` objects; a fetch or
parse failure is surfaced as a record with a non-``ok`` ``parse_status`` rather
than raised (FR-7, E-11).

Nothing here performs I/O; concrete fetchers/adapters live in sibling modules.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Protocol

from ..config import Config, TargetWindow
from ..models import SourceRecord


@dataclass
class Window:
    """The ingestion window an adapter should return events for (CFG-2).

    Adapters work one local day at a time; ``target_date`` is the local date
    events must fall on. A multi-day refresh runs the same adapters once per
    date from :func:`window_dates` rather than widening this type, which keeps
    strict per-day isolation in both ingestion and storage.
    """

    target_date: date

    @classmethod
    def from_config(cls, config: Config, *, today: date) -> Window:
        """Derive the window from ``config.target_window`` relative to ``today``.

        ``today`` is passed in (never read from the clock here) so window
        derivation stays pure and testable offline.
        """

        if config.target_window is TargetWindow.TODAY:
            return cls(target_date=today)
        return cls(target_date=today.fromordinal(today.toordinal() + 1))


def window_dates(config: Config, *, today: date, days: int = 1) -> list[date]:
    """Return ``days`` consecutive local dates starting at the configured window.

    With the default ``TODAY`` window and ``days=7`` this is today through six
    days out — the span the weekly schedule browses.
    """

    start = Window.from_config(config, today=today).target_date
    count = max(1, days)
    return [start + timedelta(days=offset) for offset in range(count)]


@dataclass
class FetchResult:
    """Outcome of a single :class:`HttpFetcher` call.

    ``ok`` is ``True`` only when the resource was retrieved. On failure ``error``
    carries a human-readable reason and ``text`` is ``None``; adapters translate
    this into a ``fetch_error`` record instead of raising (FR-7).
    """

    url: str
    ok: bool
    status: int | None = None
    text: str | None = None
    error: str | None = None


class HttpFetcher(Protocol):
    """Retrieves the raw body for a source URL (network seam, FR-4).

    The offline default is :class:`~vandy_food_radar.sources.fixture_fetcher.\
FixtureFetcher`, which resolves URLs against the fixture corpus so the tool
    runs with no live network.
    """

    def get(self, url: str, *, timeout: float = 10.0) -> FetchResult:
        """Fetch ``url`` and return a :class:`FetchResult` (never raises)."""
        ...


class SourceAdapter(Protocol):
    """Turns one source into :class:`SourceRecord` objects (FR-1/2/3/5).

    Adapters are constructor-injected with an :class:`HttpFetcher` so the same
    adapter runs against live sources or the offline corpus. ``fetch`` must not
    raise for a fetch/parse failure; it records the failing state on the
    affected record and continues (FR-7, E-11).
    """

    source_id: str

    def fetch(self, window: Window) -> list[SourceRecord]:
        """Return the source's records for ``window`` (soft-fails per record)."""
        ...
