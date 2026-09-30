"""Timezone-aware date/time parsing for normalization (design.md §3.2, T3.2).

Parses the shallow ``parsed_fields`` date/time strings produced by source
adapters (``event_date`` as ``YYYY-MM-DD`` and ``start_time``/``end_time`` as
``HH:MM``) into ``date``/``time`` values interpreted in the configured local
timezone.

Per FR-10 and E-12 an unparseable or missing value is *flagged*, never dropped
and never raised: callers receive a result object that distinguishes a parsed
value from an unparseable one and carries the original raw text so the failure
stays explainable downstream.

Pure and deterministic: no network, DB, or file I/O.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


@dataclass(frozen=True)
class ParsedDate:
    """Result of parsing an ``event_date`` value.

    ``value`` is the parsed :class:`datetime.date` when ``ok`` is ``True``;
    otherwise it is ``None`` and ``raw`` preserves the original input so the
    unparseable value can be surfaced (FR-10, E-12).
    """

    ok: bool
    value: date | None
    raw: Any | None


@dataclass(frozen=True)
class ParsedTime:
    """Result of parsing a ``start_time``/``end_time`` value.

    ``value`` is a timezone-aware :class:`datetime.time` (its ``tzinfo`` is the
    configured local zone) when ``ok`` is ``True``; otherwise ``None`` with the
    original text preserved in ``raw``.
    """

    ok: bool
    value: time | None
    raw: Any | None


def resolve_timezone(timezone: str) -> tzinfo:
    """Resolve an IANA timezone name to a ``tzinfo``.

    Falls back to UTC for an unknown/blank name so parsing stays robust and
    never raises for a misconfigured zone.
    """

    try:
        return ZoneInfo(timezone)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def parse_event_date(raw: Any) -> ParsedDate:
    """Parse a ``YYYY-MM-DD`` string into a :class:`date`.

    A missing (``None``) or malformed value yields ``ok=False`` with the raw
    input preserved; it never raises (FR-10, E-12).
    """

    if not isinstance(raw, str) or not raw.strip():
        return ParsedDate(ok=False, value=None, raw=raw)
    try:
        parsed = datetime.strptime(raw.strip(), "%Y-%m-%d").date()
    except ValueError:
        return ParsedDate(ok=False, value=None, raw=raw)
    return ParsedDate(ok=True, value=parsed, raw=raw)


def parse_event_time(raw: Any, timezone: str) -> ParsedTime:
    """Parse an ``HH:MM`` string into a tz-aware :class:`time` in ``timezone``.

    The returned ``time`` carries the resolved zone as its ``tzinfo`` so the
    local wall-clock hour is unambiguous downstream (ranking's timing factor).
    A missing or malformed value yields ``ok=False`` with the raw input
    preserved; it never raises (FR-10, E-12).
    """

    if not isinstance(raw, str) or not raw.strip():
        return ParsedTime(ok=False, value=None, raw=raw)
    try:
        naive = datetime.strptime(raw.strip(), "%H:%M").time()
    except ValueError:
        return ParsedTime(ok=False, value=None, raw=raw)
    aware = naive.replace(tzinfo=resolve_timezone(timezone))
    return ParsedTime(ok=True, value=aware, raw=raw)


__all__ = [
    "ParsedDate",
    "ParsedTime",
    "parse_event_date",
    "parse_event_time",
    "resolve_timezone",
]
