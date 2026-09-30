"""Verification stage: apply resolved values + derive state (§5, T5.3–T5.5).

Consumes a :class:`~vandy_food_radar.dedup.MergedEvent` (its ``members`` are the
contributing :class:`~vandy_food_radar.normalize.NormalizedRecord` objects) plus
the originating :class:`~vandy_food_radar.models.SourceRecord` map (for the
update/checked timestamps and parse status), and produces a
:class:`VerifiedEvent`:

* the canonical :class:`~vandy_food_radar.models.Event` with authority-resolved
  field values applied;
* per-field :class:`~vandy_food_radar.models.FieldProvenance`;
* preserved :class:`~vandy_food_radar.models.Conflict` rows (losers kept);
* a derived ``verification_state`` and deterministic ``confidence`` in ``[0, 1]``;
* an :class:`~vandy_food_radar.models.EventHistory` entry when the event is
  detected as cancelled.

Records whose ``parse_status`` is not ``ok`` (an unparseable official page, a
failed fetch) are dropped from the field comparison so the run degrades
gracefully rather than crashing (FR-7, E-11, AC-9). Pure given its inputs: no
network, DB, or file I/O.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime

from ..config import Config
from ..dedup import MergedEvent
from ..models import (
    Conflict,
    Event,
    EventHistory,
    FieldAgreement,
    FieldProvenance,
    FoodCategory,
    FoodConfirmed,
    ParseStatus,
    SourceId,
    SourceRecord,
    VerificationState,
)
from ..normalize import NormalizedRecord
from .conflict import CROSS_CHECKED_FIELDS, SourceValue, resolve_field

# Fields whose disagreement makes the whole event ``conflicting`` (FR-20).
_KEY_FIELDS: frozenset[str] = frozenset({"event_date", "start_time", "location"})

# Weights for the deterministic confidence blend (§5, sums to 1.0).
_W_AGREEMENT = 0.5
_W_TOP_AUTHORITY = 0.2
_W_FOOD = 0.2
_W_RSVP = 0.1


@dataclass
class VerifiedEvent:
    """A verified canonical event plus its provenance, conflicts, and history."""

    event: Event
    provenance: list[FieldProvenance] = field(default_factory=list)
    conflicts: list[Conflict] = field(default_factory=list)
    history: list[EventHistory] = field(default_factory=list)


def _now_utc() -> datetime:
    """Current UTC timestamp (single injection point for history stamps)."""

    return datetime.now(tz=UTC)


def _field_value(record: NormalizedRecord, field_name: str) -> object | None:
    """Read one cross-checked field from a normalized record.

    Enum-valued food fields are compared/stored by their string value so
    provenance and conflict rows carry plain, serializable values.
    """

    value = getattr(record, field_name, None)
    if isinstance(value, (FoodConfirmed, FoodCategory)):
        return value.value
    return value


def _comparable_members(
    merged: MergedEvent,
    source_records: Mapping[str, SourceRecord],
) -> tuple[list[NormalizedRecord], list[NormalizedRecord]]:
    """Split members into ok (comparable) and dropped (non-ok parse status).

    A record is dropped from field comparison when either the normalized record
    or its originating source record reports a non-``ok`` parse status — e.g. an
    unparseable official page (E-11, AC-9).
    """

    comparable: list[NormalizedRecord] = []
    dropped: list[NormalizedRecord] = []
    for member in merged.members:
        source = source_records.get(member.source_record_id)
        status_ok = member.parse_status is ParseStatus.OK and (
            source is None or source.parse_status is ParseStatus.OK
        )
        (comparable if status_ok else dropped).append(member)
    return comparable, dropped


def _source_values(
    members: list[NormalizedRecord],
    source_records: Mapping[str, SourceRecord],
    field_name: str,
) -> list[SourceValue]:
    """Gather each member's value for ``field_name`` with its timestamps."""

    values: list[SourceValue] = []
    for member in members:
        source = source_records.get(member.source_record_id)
        values.append(
            SourceValue(
                source_id=member.source_id,
                value=_field_value(member, field_name),
                source_updated_at=source.source_updated_at if source else None,
                checked_at=source.checked_at if source else None,
            )
        )
    return values


def verify(
    merged: MergedEvent,
    source_records: Mapping[str, SourceRecord],
    *,
    config: Config,
) -> VerifiedEvent:
    """Cross-check, resolve conflicts, and derive verification state (§5).

    Returns a :class:`VerifiedEvent`: the canonical event with authority-
    resolved values applied, per-field provenance, preserved conflicts, a
    derived ``verification_state``/``confidence``, and a history entry when the
    event is cancelled. Never raises for an unparseable source (FR-7, E-11).
    """

    event = _clone_event(merged.event)
    comparable, dropped = _comparable_members(merged, source_records)

    provenance: list[FieldProvenance] = []
    conflicts: list[Conflict] = []
    agreed = 0
    resolved_conflicts = 0
    key_conflict = False

    for field_name in CROSS_CHECKED_FIELDS:
        values = _source_values(comparable, source_records, field_name)
        resolution = resolve_field(field_name, values, event_id=event.id, config=config)
        provenance.append(resolution.provenance)
        if resolution.conflict is not None:
            conflicts.append(resolution.conflict)
        agreement = resolution.provenance.agreement
        if agreement is FieldAgreement.AGREED:
            agreed += 1
        elif agreement is FieldAgreement.RESOLVED_CONFLICT:
            resolved_conflicts += 1
            if field_name in _KEY_FIELDS:
                key_conflict = True
        _apply_field(event, field_name, resolution.chosen_value)

    food_state = _resolve_food(comparable, source_records)
    event.food_confirmed = food_state.confirmed
    food_conflicting = food_state.conflicting

    # The event-level food_confirmed decision is made by the dedicated
    # _resolve_food path (E-5), not the generic field resolver, so mirror that
    # decision onto the food_confirmed provenance row rather than leaving the
    # generic (often "missing") result, which would misrepresent the choice.
    _sync_food_provenance(
        provenance,
        confirmed=food_state.confirmed,
        conflicting=food_conflicting,
        members=comparable,
    )

    # RSVP health considers every member (including a dropped source page whose
    # RSVP link itself is broken), not just the comparable ones (E-8).
    event.rsvp_link_ok = _rsvp_link_ok(merged.members, source_records)

    has_top_authority = any(m.source_id is _top_authority(config) for m in comparable)
    confidence = _confidence(
        agreed=agreed,
        total_fields=len(CROSS_CHECKED_FIELDS),
        has_top_authority=has_top_authority,
        food_confirmed=event.food_confirmed,
        rsvp_link_ok=event.rsvp_link_ok,
    )
    event.confidence = confidence

    cancelled = _is_cancelled(comparable, config)
    history: list[EventHistory] = []
    if cancelled:
        event.verification_state = VerificationState.CANCELLED
        history.append(_cancellation_history(event))
    else:
        event.verification_state = _verification_state(
            key_conflict=key_conflict,
            any_conflict=bool(conflicts),
            has_missing_or_single=_has_gap(provenance),
            food_confirmed=event.food_confirmed,
            food_conflicting=food_conflicting,
        )

    return VerifiedEvent(
        event=event,
        provenance=provenance,
        conflicts=conflicts,
        history=history,
    )


# ---------------------------------------------------------------------------
# food / rsvp / cancellation signals
# ---------------------------------------------------------------------------


def _sync_food_provenance(
    provenance: list[FieldProvenance],
    *,
    confirmed: FoodConfirmed,
    conflicting: bool,
    members: list[NormalizedRecord],
) -> None:
    """Align the ``food_confirmed`` provenance row with the food resolver.

    The generic field resolver marks ``food_confirmed`` from the per-source
    values, but the authoritative event-level decision is made by
    :func:`_resolve_food`. This overwrites that provenance row's chosen value
    and agreement so provenance reflects the decision actually applied to the
    event: a conflict when sources disagree, agreement when they all align on a
    single food state, otherwise a single-source/missing gap.
    """

    row = next((p for p in provenance if p.field_name == "food_confirmed"), None)
    if row is None:
        return
    row.chosen_value = confirmed.value
    states = {m.food_confirmed for m in members}
    if conflicting:
        row.agreement = FieldAgreement.RESOLVED_CONFLICT
    elif len(members) >= 2 and len(states) == 1:
        row.agreement = FieldAgreement.AGREED
    elif len(members) == 1:
        row.agreement = FieldAgreement.SINGLE_SOURCE
    else:
        row.agreement = FieldAgreement.MISSING


@dataclass
class _FoodState:
    confirmed: FoodConfirmed
    conflicting: bool


def _resolve_food(
    members: list[NormalizedRecord],
    source_records: Mapping[str, SourceRecord],
) -> _FoodState:
    """Derive event-level food confirmation, flagging disagreement (E-5).

    A ``confirmed`` claim on one source with ``contradicted`` on another is an
    active conflict; ``confirmed`` alongside ``unconfirmed`` (a source that
    simply does not mention food) is not fully verified and downgrades to
    ``unconfirmed``. All-confirmed stays ``confirmed`` (FR-21, AC-6).
    """

    states = {m.food_confirmed for m in members}
    if not states or states == {FoodConfirmed.UNCONFIRMED}:
        return _FoodState(confirmed=FoodConfirmed.UNCONFIRMED, conflicting=False)
    has_confirmed = FoodConfirmed.CONFIRMED in states
    has_contradicted = FoodConfirmed.CONTRADICTED in states
    if has_confirmed and has_contradicted:
        return _FoodState(confirmed=FoodConfirmed.CONTRADICTED, conflicting=True)
    if has_contradicted:
        return _FoodState(confirmed=FoodConfirmed.CONTRADICTED, conflicting=False)
    if has_confirmed and FoodConfirmed.UNCONFIRMED in states:
        # Confirmed on one source, unmentioned on another: not fully verified.
        return _FoodState(confirmed=FoodConfirmed.UNCONFIRMED, conflicting=False)
    if has_confirmed:
        return _FoodState(confirmed=FoodConfirmed.CONFIRMED, conflicting=False)
    return _FoodState(confirmed=FoodConfirmed.UNCONFIRMED, conflicting=False)


def _rsvp_link_ok(
    members: list[NormalizedRecord],
    source_records: Mapping[str, SourceRecord],
) -> bool | None:
    """Tri-state RSVP link health from the source fetch results (E-8).

    ``None`` when no member advertises an RSVP URL; otherwise ``True`` unless a
    source that carried an RSVP URL failed to fetch/parse, which flags the link
    broken.
    """

    saw_link = False
    for member in members:
        if member.rsvp_url is None:
            continue
        saw_link = True
        source = source_records.get(member.source_record_id)
        if source is not None and source.parse_status is not ParseStatus.OK:
            return False
    return True if saw_link else None


def _is_cancelled(members: list[NormalizedRecord], config: Config) -> bool:
    """Detect a cancellation signal from any authoritative source (E-4).

    Any contributing source carrying a cancellation signal (``parsed_fields``
    cancelled / ``[CANCELLED]`` marker / ``status`` cancelled, already folded
    into ``NormalizedRecord.cancelled``) cancels the event; this overrides every
    other state (AC-12).
    """

    return any(member.cancelled for member in members)


# ---------------------------------------------------------------------------
# state + confidence derivation
# ---------------------------------------------------------------------------


def _verification_state(
    *,
    key_conflict: bool,
    any_conflict: bool,
    has_missing_or_single: bool,
    food_confirmed: FoodConfirmed,
    food_conflicting: bool,
) -> VerificationState:
    """Derive the non-cancelled verification state (§5, FR-20)."""

    if food_conflicting or key_conflict:
        return VerificationState.CONFLICTING
    if food_confirmed is not FoodConfirmed.CONFIRMED:
        return VerificationState.FOOD_UNCONFIRMED
    if any_conflict:
        return VerificationState.CONFLICTING
    if has_missing_or_single:
        return VerificationState.PARTIALLY_VERIFIED
    return VerificationState.VERIFIED


def _has_gap(provenance: list[FieldProvenance]) -> bool:
    """True when any field is single-source or missing (partial verification)."""

    return any(
        p.agreement in (FieldAgreement.SINGLE_SOURCE, FieldAgreement.MISSING)
        for p in provenance
    )


def _confidence(
    *,
    agreed: int,
    total_fields: int,
    has_top_authority: bool,
    food_confirmed: FoodConfirmed,
    rsvp_link_ok: bool | None,
) -> float:
    """Deterministic confidence in ``[0, 1]`` (§5).

    Weighted blend of: fraction of fields that agreed, presence of the top-
    authority source, food-confirmation status, and RSVP link health. Food that
    is contradicted scores lowest; an unknown RSVP link is treated as neutral so
    it neither rewards nor penalizes.
    """

    agreement_score = agreed / total_fields if total_fields else 0.0
    authority_score = 1.0 if has_top_authority else 0.0
    food_score = {
        FoodConfirmed.CONFIRMED: 1.0,
        FoodConfirmed.UNCONFIRMED: 0.4,
        FoodConfirmed.CONTRADICTED: 0.0,
    }[food_confirmed]
    if rsvp_link_ok is None:
        rsvp_score = 1.0
    else:
        rsvp_score = 1.0 if rsvp_link_ok else 0.0

    confidence = (
        _W_AGREEMENT * agreement_score
        + _W_TOP_AUTHORITY * authority_score
        + _W_FOOD * food_score
        + _W_RSVP * rsvp_score
    )
    return round(max(0.0, min(1.0, confidence)), 4)


# ---------------------------------------------------------------------------
# event mutation helpers
# ---------------------------------------------------------------------------


def _top_authority(config: Config) -> SourceId | None:
    """The most authoritative configured source, or ``None`` if unset."""

    return config.authority_precedence[0] if config.authority_precedence else None


def _apply_field(event: Event, field_name: str, value: object | None) -> None:
    """Apply a resolved field value onto the canonical event.

    Food enum fields are coerced back from their stored string values; a
    resolved value of ``None`` leaves the event's existing (shell) value in
    place so nothing is clobbered by an all-missing field.
    """

    if field_name == "food_category":
        if value is not None:
            event.food_category = FoodCategory(str(value))
        return
    if field_name == "food_confirmed":
        # Event-level food confirmation is derived separately (E-5); skip here.
        return
    if value is None:
        return
    setattr(event, field_name, value)


def _clone_event(source: Event) -> Event:
    """Shallow-copy the provisional event so the merged shell is not mutated."""

    return Event(
        id=source.id,
        dedup_key=source.dedup_key,
        identity_key=source.identity_key,
        title=source.title,
        event_date=source.event_date,
        start_time=source.start_time,
        end_time=source.end_time,
        location=source.location,
        location_geo=source.location_geo,
        organizer=source.organizer,
        rsvp_required=source.rsvp_required,
        rsvp_url=source.rsvp_url,
        rsvp_link_ok=source.rsvp_link_ok,
        event_url=source.event_url,
        food_confirmed=source.food_confirmed,
        food_category=source.food_category,
        food_description=source.food_description,
        verification_state=source.verification_state,
        confidence=source.confidence,
        score_total=source.score_total,
        created_at=source.created_at,
        updated_at=source.updated_at,
    )


def _cancellation_history(event: Event) -> EventHistory:
    """Build the history entry appended when an event becomes cancelled (E-4)."""

    return EventHistory(
        id=uuid.uuid4().hex,
        event_id=event.id,
        changed_at=_now_utc(),
        field_name="verification_state",
        old_value=None,
        new_value=VerificationState.CANCELLED.value,
        reason="cancellation signal detected from an authoritative source",
    )


__all__ = [
    "VerifiedEvent",
    "verify",
]
