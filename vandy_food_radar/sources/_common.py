"""Shared helpers for source adapters (design.md §3, T2.3).

Small pure helpers for enumerating the offline corpus by source, parsing ISO
timestamps into aware datetimes, and building a
:class:`~vandy_food_radar.models.SourceRecord` from a fetched fixture body. Kept
free of I/O beyond the injected fetcher so adapter behavior stays deterministic
and testable offline.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any

from ..fixtures import load_all_json_fixtures
from ..models import ParseStatus, SourceId, SourceRecord
from .base import FetchResult, HttpFetcher, Window

# Placeholder used until dedup/normalize assigns a canonical event id (FEAT-003).
UNASSIGNED_EVENT_ID = ""


def corpus_records_for(source_id: SourceId) -> list[dict[str, Any]]:
    """Return corpus fixture records for ``source_id``, sorted by source URL."""

    matches = [
        record
        for record in load_all_json_fixtures().values()
        if record.get("source_id") == source_id.value
    ]
    return sorted(matches, key=lambda record: str(record.get("source_url", "")))


def parse_iso_datetime(value: Any) -> datetime | None:
    """Parse an ISO-8601 string into a datetime, or return ``None``.

    Never raises: a missing or malformed timestamp yields ``None`` so a bad
    field cannot abort ingestion (FR-7).
    """

    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _decode_body(result: FetchResult) -> dict[str, Any] | None:
    """Decode a fetched JSON body into a fixture record, or ``None``."""

    if result.text is None:
        return None
    try:
        decoded = json.loads(result.text)
    except json.JSONDecodeError:
        return None
    return decoded if isinstance(decoded, dict) else None


def build_source_record(
    source_id: SourceId,
    record: dict[str, Any],
    fetcher: HttpFetcher,
) -> SourceRecord:
    """Fetch and build a :class:`SourceRecord` for one corpus ``record``.

    Reads the body through the injected ``fetcher`` (honoring the network seam),
    then maps the fixture's fields onto a ``SourceRecord``. A fetch failure, an
    undecodable body, or a fixture that itself reports a parse error all yield a
    record with empty ``parsed_fields`` and a non-``ok`` ``parse_status`` — the
    adapter never raises (FR-7, E-11).
    """

    source_url = record.get("source_url")
    checked_at = parse_iso_datetime(record.get("checked_at"))
    source_updated_at = parse_iso_datetime(record.get("source_updated_at"))
    record_id = f"src-{uuid.uuid4().hex}"

    result = fetcher.get(str(source_url)) if isinstance(source_url, str) else None
    if result is None or not result.ok:
        error = result.error if result is not None else "missing source_url"
        return SourceRecord(
            id=record_id,
            event_id=UNASSIGNED_EVENT_ID,
            source_id=source_id,
            source_url=source_url if isinstance(source_url, str) else None,
            raw_payload=error,
            parsed_fields={},
            checked_at=checked_at,
            parse_status=ParseStatus.FETCH_ERROR,
            source_updated_at=source_updated_at,
        )

    body = _decode_body(result)
    # HTML/unparseable bodies do not decode to a fixture dict; fall back to the
    # corpus record for its declared parse_status and raw payload.
    payload = body if body is not None else record
    parse_status = _resolve_parse_status(payload)
    parsed_fields: dict[str, Any] = {}
    if parse_status is ParseStatus.OK:
        candidate = payload.get("parsed_fields")
        if isinstance(candidate, dict):
            parsed_fields = candidate

    return SourceRecord(
        id=record_id,
        event_id=UNASSIGNED_EVENT_ID,
        source_id=source_id,
        source_url=source_url if isinstance(source_url, str) else None,
        raw_payload=_raw_payload_text(payload, result),
        parsed_fields=parsed_fields,
        checked_at=checked_at,
        parse_status=parse_status,
        source_updated_at=source_updated_at,
    )


def _resolve_parse_status(payload: dict[str, Any]) -> ParseStatus:
    """Read a fixture's declared parse status, defaulting to ``ok``."""

    raw_status = payload.get("parse_status")
    if isinstance(raw_status, str):
        try:
            return ParseStatus(raw_status)
        except ValueError:
            return ParseStatus.PARSE_ERROR
    return ParseStatus.OK


def _raw_payload_text(payload: dict[str, Any], result: FetchResult) -> str | None:
    """Return a text representation of the raw payload for persistence."""

    raw = payload.get("raw_payload")
    if isinstance(raw, str):
        return raw
    if raw is not None:
        return json.dumps(raw, sort_keys=True)
    # HTML page: the fetched text is the raw payload.
    return result.text


__all__ = [
    "UNASSIGNED_EVENT_ID",
    "Window",
    "build_source_record",
    "corpus_records_for",
    "parse_iso_datetime",
]
