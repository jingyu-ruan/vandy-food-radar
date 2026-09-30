"""Per-source normalizer (design.md §3.2, T3.1/T3.4, FR-8/FR-9, E-12).

Maps a single :class:`~vandy_food_radar.models.SourceRecord`'s shallow
``parsed_fields`` into canonical event field values, using
:mod:`.datetime_parse` for timezone-aware date/time parsing and
:mod:`.food_classifier` for food category/confirmation.

Normalization is *non-lossy*: the per-source originals are preserved verbatim on
the returned :class:`NormalizedRecord` (``original_fields``) so downstream dedup
/ verification / display can explain how the canonical record was produced and
resolve conflicts against the raw source values. The source record itself is
never mutated.

Pure and deterministic: no network, DB, or file I/O.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, time
from typing import Any

from ..models import (
    FoodCategory,
    FoodConfirmed,
    ParseStatus,
    SourceId,
    SourceRecord,
)
from .datetime_parse import (
    ParsedDate,
    ParsedTime,
    parse_event_date,
    parse_event_time,
)
from .food_classifier import FoodClassification, classify_food

# Marker that may appear in a title/status to signal a cancelled event (E-4).
CANCELLED_MARKER = "[cancelled]"


@dataclass
class NormalizedRecord:
    """Canonical view of one source's contribution to an event.

    Field values are ``None`` where the source omitted or could not parse them
    (FR-8). ``date_flagged`` / ``start_time_flagged`` / ``end_time_flagged`` are
    ``True`` when the source supplied a value that could not be parsed, so the
    unparseable input is flagged rather than silently dropped (FR-10, E-12).
    ``original_fields`` preserves the source's raw ``parsed_fields`` verbatim.
    """

    source_id: SourceId
    source_record_id: str
    parse_status: ParseStatus

    title: str | None = None
    event_date: date | None = None
    start_time: time | None = None
    end_time: time | None = None
    location: str | None = None
    organizer: str | None = None
    rsvp_required: bool | None = None
    rsvp_url: str | None = None
    event_url: str | None = None

    food_confirmed: FoodConfirmed = FoodConfirmed.UNCONFIRMED
    food_category: FoodCategory = FoodCategory.UNSPECIFIED
    food_description: str | None = None
    food_classification: FoodClassification | None = None

    cancelled: bool = False

    date_flagged: bool = False
    start_time_flagged: bool = False
    end_time_flagged: bool = False

    original_fields: dict[str, Any] = field(default_factory=dict)


def _as_str(value: Any) -> str | None:
    """Return a stripped string for a non-empty text value, else ``None``."""

    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def _as_bool(value: Any) -> bool | None:
    """Return a tri-state bool: ``None`` when the source did not specify one."""

    if isinstance(value, bool):
        return value
    return None


def _detect_cancelled(fields: dict[str, Any], title: str | None) -> bool:
    """Derive a per-record cancelled signal (E-4).

    Sourced from an explicit ``parsed_fields['cancelled']`` boolean, a
    ``status`` of ``"cancelled"``, or a ``[CANCELLED]`` marker in the title.
    """

    if _as_bool(fields.get("cancelled")) is True:
        return True
    status = _as_str(fields.get("status"))
    if status is not None and status.lower() == "cancelled":
        return True
    if title is not None and CANCELLED_MARKER in title.lower():
        return True
    return False


def _resolve_food_category(
    fields: dict[str, Any], derived: FoodCategory
) -> FoodCategory:
    """Prefer a valid source-declared category, else the text-derived one."""

    raw = _as_str(fields.get("food_category"))
    if raw is not None:
        try:
            return FoodCategory(raw)
        except ValueError:
            return derived
    return derived


def _resolve_food_confirmed(
    fields: dict[str, Any], derived: FoodConfirmed
) -> FoodConfirmed:
    """Prefer a valid source-declared confirmation, else the text-derived one."""

    raw = _as_str(fields.get("food_confirmed"))
    if raw is not None:
        try:
            return FoodConfirmed(raw)
        except ValueError:
            return derived
    return derived


def normalize(record: SourceRecord, *, timezone: str) -> NormalizedRecord:
    """Normalize one :class:`SourceRecord` into a :class:`NormalizedRecord`.

    Uses ``timezone`` (typically ``config.timezone``) for tz-aware time parsing.
    A record whose ``parse_status`` is not ``ok`` still yields a normalized
    record (empty canonical fields, originals preserved) so failures degrade
    gracefully rather than aborting the run (FR-7, E-11). The input record is
    not mutated (FR-9).
    """

    fields: dict[str, Any] = dict(record.parsed_fields)

    title = _as_str(fields.get("title"))

    parsed_date: ParsedDate = parse_event_date(fields.get("event_date"))
    parsed_start: ParsedTime = parse_event_time(fields.get("start_time"), timezone)
    parsed_end: ParsedTime = parse_event_time(fields.get("end_time"), timezone)

    food_description = _as_str(fields.get("food_description"))
    classification = classify_food(food_description)
    food_category = _resolve_food_category(fields, classification.category)
    food_confirmed = _resolve_food_confirmed(fields, classification.confirmed)

    return NormalizedRecord(
        source_id=record.source_id,
        source_record_id=record.id,
        parse_status=record.parse_status,
        title=title,
        event_date=parsed_date.value,
        start_time=parsed_start.value,
        end_time=parsed_end.value,
        location=_as_str(fields.get("location")),
        organizer=_as_str(fields.get("organizer")),
        rsvp_required=_as_bool(fields.get("rsvp_required")),
        rsvp_url=_as_str(fields.get("rsvp_url")),
        event_url=_as_str(fields.get("event_url")),
        food_confirmed=food_confirmed,
        food_category=food_category,
        food_description=food_description,
        food_classification=classification,
        cancelled=_detect_cancelled(fields, title),
        date_flagged=not parsed_date.ok and fields.get("event_date") is not None,
        start_time_flagged=not parsed_start.ok and fields.get("start_time") is not None,
        end_time_flagged=not parsed_end.ok and fields.get("end_time") is not None,
        original_fields=fields,
    )


__all__ = [
    "CANCELLED_MARKER",
    "NormalizedRecord",
    "normalize",
]
