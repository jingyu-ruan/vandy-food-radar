"""Domain models for Vandy Food Radar (design.md §2.1).

These are pure data classes with no persistence or business logic. They mirror
the canonical/per-source separation described in the design so that any
normalized field value can later be explained from its provenance and conflicts.

Fields are nullable wherever the spec allows unknown values (FR-8, FR-31,
FR-32). Enumerations capture the discrete states named in the requirements.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time
from enum import StrEnum
from typing import Any

# ---------------------------------------------------------------------------
# Enumerations (the discrete states named in requirements.md / design.md §2.1)
# ---------------------------------------------------------------------------


class VerificationState(StrEnum):
    """Overall event-level verification state (FR-20)."""

    VERIFIED = "verified"
    PARTIALLY_VERIFIED = "partially_verified"
    CONFLICTING = "conflicting"
    FOOD_UNCONFIRMED = "food_unconfirmed"
    CANCELLED = "cancelled"


class FoodConfirmed(StrEnum):
    """Whether free food is confirmed for the event (FR-21)."""

    CONFIRMED = "confirmed"
    UNCONFIRMED = "unconfirmed"
    CONTRADICTED = "contradicted"


class FoodCategory(StrEnum):
    """Classified food signal (FR-11)."""

    FULL_MEAL = "full_meal"
    SNACKS_OR_REFRESHMENTS = "snacks_or_refreshments"
    UNSPECIFIED = "unspecified"
    NONE = "none"


class SourceId(StrEnum):
    """Identifier of an event data source (FR-4, FR-5)."""

    ANCHOR_LINK = "anchor_link"
    GOOGLE_CALENDAR = "google_calendar"
    OFFICIAL_PAGE = "official_page"


class ParseStatus(StrEnum):
    """Outcome of fetching/parsing a source record (FR-7)."""

    OK = "ok"
    PARSE_ERROR = "parse_error"
    FETCH_ERROR = "fetch_error"


class FieldAgreement(StrEnum):
    """How a canonical field's value was chosen across sources (§5)."""

    AGREED = "agreed"
    RESOLVED_CONFLICT = "resolved_conflict"
    SINGLE_SOURCE = "single_source"
    MISSING = "missing"


class ScoreFactor(StrEnum):
    """Ranking factors that contribute to an event's score (design.md §6.1)."""

    FOOD_CONFIRMED = "food_confirmed"
    FULL_MEAL = "full_meal"
    FOOD_SPECIFICITY = "food_specificity"
    RSVP_LIKELIHOOD = "rsvp_likelihood"
    TIMING = "timing"
    WALKING = "walking"
    CONFIDENCE = "confidence"


# ---------------------------------------------------------------------------
# Value objects
# ---------------------------------------------------------------------------


@dataclass
class GeoPoint:
    """A latitude/longitude coordinate pair."""

    lat: float
    lng: float


# ---------------------------------------------------------------------------
# Entities (design.md §2.1)
# ---------------------------------------------------------------------------


@dataclass
class Event:
    """Canonical, normalized, and merged event.

    Fields are nullable where the underlying data may be unknown. `unknown`
    tri-state fields (rsvp_required, rsvp_link_ok) use ``None`` for "unknown".
    """

    id: str
    dedup_key: str
    title: str
    event_date: date
    start_time: time | None = None
    end_time: time | None = None
    location: str | None = None
    location_geo: GeoPoint | None = None
    organizer: str | None = None
    rsvp_required: bool | None = None
    rsvp_url: str | None = None
    rsvp_link_ok: bool | None = None
    event_url: str | None = None
    food_confirmed: FoodConfirmed = FoodConfirmed.UNCONFIRMED
    food_category: FoodCategory = FoodCategory.UNSPECIFIED
    food_description: str | None = None
    verification_state: VerificationState = VerificationState.FOOD_UNCONFIRMED
    confidence: float | None = None
    score_total: float | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass
class SourceRecord:
    """Raw contribution from a single source for one event."""

    id: str
    event_id: str
    source_id: SourceId
    source_url: str | None = None
    raw_payload: str | None = None
    parsed_fields: dict[str, Any] = field(default_factory=dict)
    checked_at: datetime | None = None
    parse_status: ParseStatus = ParseStatus.OK
    source_updated_at: datetime | None = None


@dataclass
class FieldProvenance:
    """Records how a single canonical field value was chosen."""

    id: str
    event_id: str
    field_name: str
    chosen_value: Any | None = None
    chosen_source_id: SourceId | None = None
    agreement: FieldAgreement = FieldAgreement.MISSING


@dataclass
class CompetingValue:
    """One source's value for a field involved in a conflict."""

    value: Any | None
    source_id: SourceId
    source_updated_at: datetime | None = None


@dataclass
class Conflict:
    """A detected disagreement between sources for a field (FR-18)."""

    id: str
    event_id: str
    field_name: str
    competing_values: list[CompetingValue] = field(default_factory=list)
    resolution: str | None = None


@dataclass
class ScoreComponent:
    """One factor's contribution to an event's total score (FR-24)."""

    id: str
    event_id: str
    factor: ScoreFactor
    raw_value: float | None = None
    weight: float = 0.0
    contribution: float = 0.0
    note: str | None = None


@dataclass
class EventHistory:
    """A recorded change to a tracked event detail (FR-43)."""

    id: str
    event_id: str
    changed_at: datetime
    field_name: str
    old_value: Any | None = None
    new_value: Any | None = None
    reason: str | None = None
