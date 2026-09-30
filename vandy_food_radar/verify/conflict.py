"""Per-field cross-check and authority-precedence conflict resolution (§5).

For each canonical field of a merged event this module gathers every
contributing source's value (with its ``source_id`` and update timestamp),
decides whether the sources ``agreed`` / disagree / are ``single_source`` /
``missing``, and — on disagreement — resolves the value by the configured
authority precedence (``official_page`` > ``anchor_link`` > ``google_calendar``
by default, FR-19), breaking ties by the most recent ``source_updated_at``
(FR-18). Every losing value is preserved on the emitted
:class:`~vandy_food_radar.models.Conflict` so the discrepancy is never
discarded (FR-16–FR-18, AC-5).

Pure and deterministic given the records: no network, DB, or file I/O.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from ..config import Config
from ..models import (
    CompetingValue,
    Conflict,
    FieldAgreement,
    FieldProvenance,
    SourceId,
)

# Canonical fields cross-checked across sources, in a stable, documented order.
# These are the details the spec requires cross-checking (FR-16, US-2).
CROSS_CHECKED_FIELDS: tuple[str, ...] = (
    "title",
    "event_date",
    "start_time",
    "end_time",
    "location",
    "organizer",
    "rsvp_required",
    "rsvp_url",
    "event_url",
    "food_confirmed",
    "food_category",
    "food_description",
)


@dataclass
class SourceValue:
    """One source's contribution for a single field, with its provenance keys.

    ``source_updated_at`` (falling back to ``checked_at``) drives the recency
    tie-break; ``used_checked_at_fallback`` notes when the fallback was applied
    so the resolution rule can be transparent about it.
    """

    source_id: SourceId
    value: Any | None
    source_updated_at: datetime | None
    checked_at: datetime | None

    @property
    def recency(self) -> datetime | None:
        """Timestamp used for the recency tie-break (updated-at, else checked)."""

        return self.source_updated_at or self.checked_at

    @property
    def used_checked_at_fallback(self) -> bool:
        """True when ``checked_at`` stood in for a missing ``source_updated_at``."""

        return self.source_updated_at is None and self.checked_at is not None


@dataclass
class FieldResolution:
    """Outcome of resolving one canonical field across its sources."""

    field_name: str
    provenance: FieldProvenance
    conflict: Conflict | None
    chosen_value: Any | None
    chosen_source_id: SourceId | None


def _is_present(value: Any | None) -> bool:
    """A value counts as present unless it is ``None`` or an empty string."""

    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    return True


def _authority_rank(source_id: SourceId, precedence: list[SourceId]) -> int:
    """Lower rank = more authoritative; unknown sources sort last (stable)."""

    try:
        return precedence.index(source_id)
    except ValueError:
        return len(precedence)


def resolve_field(
    field_name: str,
    values: list[SourceValue],
    *,
    event_id: str,
    config: Config,
) -> FieldResolution:
    """Cross-check one field's per-source values and resolve any conflict (§5).

    Produces a :class:`FieldProvenance` for the field in every case and, when
    present values disagree, a :class:`Conflict` carrying all competing values
    (losers preserved) plus the resolution rule applied. Resolution is by
    authority precedence, then most-recent update; the choice is deterministic.
    """

    present = [v for v in values if _is_present(v.value)]

    if not present:
        return FieldResolution(
            field_name=field_name,
            provenance=FieldProvenance(
                id=_new_id(),
                event_id=event_id,
                field_name=field_name,
                chosen_value=None,
                chosen_source_id=None,
                agreement=FieldAgreement.MISSING,
            ),
            conflict=None,
            chosen_value=None,
            chosen_source_id=None,
        )

    distinct = {_normalize_for_compare(v.value) for v in present}

    if len(present) == 1:
        agreement = FieldAgreement.SINGLE_SOURCE
    elif len(distinct) == 1:
        agreement = FieldAgreement.AGREED
    else:
        agreement = FieldAgreement.RESOLVED_CONFLICT

    winner = _select_winner(present, config=config)

    conflict: Conflict | None = None
    if agreement is FieldAgreement.RESOLVED_CONFLICT:
        conflict = Conflict(
            id=_new_id(),
            event_id=event_id,
            field_name=field_name,
            competing_values=[
                CompetingValue(
                    value=v.value,
                    source_id=v.source_id,
                    source_updated_at=v.source_updated_at,
                )
                for v in present
            ],
            resolution=_resolution_note(winner),
        )

    return FieldResolution(
        field_name=field_name,
        provenance=FieldProvenance(
            id=_new_id(),
            event_id=event_id,
            field_name=field_name,
            chosen_value=winner.value,
            chosen_source_id=winner.source_id,
            agreement=agreement,
        ),
        conflict=conflict,
        chosen_value=winner.value,
        chosen_source_id=winner.source_id,
    )


def _select_winner(present: list[SourceValue], *, config: Config) -> SourceValue:
    """Pick the authoritative, most-recent value deterministically.

    Sort key: authority rank ascending, then recency descending (missing
    timestamps sort oldest), then ``source_id`` for a fully stable order.
    """

    precedence = config.authority_precedence

    def sort_key(v: SourceValue) -> tuple[int, float, str]:
        recency = v.recency
        recency_ordinal = -recency.timestamp() if recency is not None else float("inf")
        return (
            _authority_rank(v.source_id, precedence),
            recency_ordinal,
            v.source_id.value,
        )

    return sorted(present, key=sort_key)[0]


def _resolution_note(winner: SourceValue) -> str:
    """Human-readable description of the rule that chose ``winner`` (FR-38)."""

    note = f"authority_precedence -> {winner.source_id.value}"
    if winner.used_checked_at_fallback:
        note += " (recency tie-break used checked_at fallback)"
    return note


def _normalize_for_compare(value: Any | None) -> Any:
    """Normalize a value for equality comparison across sources.

    Strings are compared case-insensitively with surrounding/interior
    whitespace collapsed so trivially different renderings of the same value do
    not read as a conflict; other types compare as-is.
    """

    if isinstance(value, str):
        return " ".join(value.lower().split())
    return value


def _new_id() -> str:
    """Return a fresh unique id for a provenance/conflict row."""

    return uuid.uuid4().hex


__all__ = [
    "CROSS_CHECKED_FIELDS",
    "FieldResolution",
    "SourceValue",
    "resolve_field",
]
