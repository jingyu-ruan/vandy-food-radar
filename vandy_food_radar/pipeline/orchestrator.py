"""Pipeline orchestrator: Discover -> Display in one pass (design.md §1.1, T6.5).

:func:`run` threads the stages together for a target :class:`Window`:

1. **ingest** — each :class:`~vandy_food_radar.sources.SourceAdapter` returns
   its :class:`~vandy_food_radar.models.SourceRecord` objects (soft-failing per
   record).
2. **normalize** — each record becomes a
   :class:`~vandy_food_radar.normalize.NormalizedRecord`.
3. **dedup** — normalized records are clustered into merged events.
4. **verify** — each merged event is cross-checked and resolved.
5. **score** — the ranking engine assigns ``score_total`` + components.
6. **save** — the event and its child rows are upserted through the
   :class:`~vandy_food_radar.store.Repository` by ``dedup_key`` (idempotent).

Before saving, the run diffs the resolved event against the stored one and
appends an :class:`~vandy_food_radar.models.EventHistory` row for each changed
tracked field (FR-43, AC-11). A repeated run over the same corpus updates in
place and adds no duplicate events (FR-42, AC-10).

:func:`seed_demo` loads the offline corpus with its fixture dates retargeted
onto the target day so the web view always has content.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any

from ..config import Config
from ..dedup import deduplicate
from ..models import (
    CompetingValue,
    Conflict,
    Event,
    EventHistory,
    FieldProvenance,
    SourceRecord,
    VerificationState,
)
from ..normalize import normalize
from ..providers.location import LocationProvider
from ..ranking import score_event
from ..sources import (
    FixtureSourceAdapter,
    SourceAdapter,
    Window,
    default_fetcher,
)
from ..store import Repository
from ..verify import verify

# Canonical fields whose change between runs is recorded as history (FR-43).
_TRACKED_FIELDS: tuple[str, ...] = (
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
    "verification_state",
)


@dataclass
class RunReport:
    """Structured summary of one pipeline run (design.md §8 observability)."""

    target_date: date
    fetched: int = 0
    merged: int = 0
    conflicts: int = 0
    cancelled: int = 0
    scored: int = 0
    history_entries: int = 0
    saved_event_ids: list[str] = field(default_factory=list)


def run(
    window: Window,
    *,
    repository: Repository,
    sources: Sequence[SourceAdapter],
    location_provider: LocationProvider,
    config: Config,
) -> RunReport:
    """Run the full pipeline for ``window`` and persist the results.

    Returns a :class:`RunReport` with per-stage counts. Idempotent: a repeated
    run upserts by ``dedup_key`` and records history only for fields that
    actually changed (FR-42/FR-43, AC-10/AC-11).
    """

    report = RunReport(target_date=window.target_date)

    ingested: list[SourceRecord] = []
    for adapter in sources:
        ingested.extend(adapter.fetch(window))
    report.fetched = len(ingested)

    source_map = {record.id: record for record in ingested}
    normalized = [normalize(record, timezone=config.timezone) for record in ingested]
    merged_events = deduplicate(normalized, config=config.dedup)
    report.merged = len(merged_events)

    for merged in merged_events:
        verified = verify(merged, source_map, config=config)
        scored = score_event(
            verified.event,
            config=config,
            location_provider=location_provider,
        )
        event = scored.event
        report.conflicts += len(verified.conflicts)
        if event.verification_state is VerificationState.CANCELLED:
            report.cancelled += 1
        report.scored += 1

        member_records = [
            source_map[m.source_record_id]
            for m in merged.members
            if m.source_record_id in source_map
        ]

        previous = repository.find_by_identity_key(event.identity_key)
        # Adopt the persisted event id when the event already exists so the row
        # (and its history) update in place under a stable id, even when a time
        # or venue change would otherwise give the fresh shell a different id
        # (FR-42/FR-43, AC-11, E-2, E-3).
        if previous is not None:
            event.id = previous.id
        history = _diff_history(previous, event)

        now = _now_utc()
        event.updated_at = now
        if previous is None:
            event.created_at = now

        repository.save_event(
            event,
            member_records,
            [_serialize_provenance(p) for p in verified.provenance],
            [_serialize_conflict(c) for c in verified.conflicts],
            scored.components,
        )
        # Cancellation history is a transition marker: only append it the first
        # time an event is seen as cancelled, not on every re-run of an already-
        # cancelled event (FR-42, AC-10). The verifier always produces it (its
        # unit contract); the orchestrator decides whether it is new.
        already_cancelled = (
            previous is not None
            and previous.verification_state is VerificationState.CANCELLED
        )
        transition_history = [] if already_cancelled else verified.history
        for entry in [*transition_history, *history]:
            entry.event_id = event.id
            repository.append_history(entry)
            report.history_entries += 1
        report.saved_event_ids.append(event.id)

    return report


def seed_demo(
    *,
    repository: Repository,
    config: Config,
    today: date | None = None,
) -> RunReport:
    """Seed the repository from the offline corpus, retargeted to the window.

    Fixture events are dated 2025-03-11; this loads the whole corpus through the
    offline :class:`FixtureSourceAdapter` and rewrites each record's
    ``event_date`` onto the target day (tomorrow by default) so
    :meth:`Repository.get_events_for_day` returns content for the web view.
    ``today`` is injectable so tests do not depend on the wall clock.
    """

    base_today = today if today is not None else datetime.now(tz=UTC).date()
    window = Window.from_config(config, today=base_today)

    fetcher = default_fetcher(config)
    adapter = _RetargetingSourceAdapter(
        FixtureSourceAdapter(fetcher), target_date=window.target_date
    )
    return run(
        window,
        repository=repository,
        sources=[adapter],
        location_provider=_seed_location_provider(config),
        config=config,
    )


def _seed_location_provider(config: Config) -> LocationProvider:
    """Late import to avoid a cycle; build the configured location provider."""

    from ..providers.location import build_location_provider

    return build_location_provider(config)


class _RetargetingSourceAdapter:
    """Wraps a source adapter and rewrites each record's date to the target day.

    Keeps the demo data always "current" without mutating the fixture files:
    every record's ``parsed_fields['event_date']`` is set to ``target_date`` so
    the seeded events fall on the day the web view queries.
    """

    source_id = "retargeted-fixture"

    def __init__(self, inner: SourceAdapter, *, target_date: date) -> None:
        self._inner = inner
        self._target_date = target_date

    def fetch(self, window: Window) -> list[SourceRecord]:
        """Fetch from the inner adapter, retargeting each record's date."""

        records = self._inner.fetch(window)
        for record in records:
            if record.parsed_fields.get("event_date") is not None:
                record.parsed_fields = {
                    **record.parsed_fields,
                    "event_date": self._target_date.isoformat(),
                }
        return records


def _diff_history(previous: Event | None, current: Event) -> list[EventHistory]:
    """Build history rows for tracked fields that changed (FR-43, AC-11).

    When ``current`` is cancelled, ``verification_state`` is skipped here because
    the verifier emits a dedicated cancellation-transition entry for it; letting
    the generic diff also fire would double-record the same transition.
    """

    if previous is None:
        return []
    entries: list[EventHistory] = []
    now = _now_utc()
    cancelled_now = current.verification_state is VerificationState.CANCELLED
    for field_name in _TRACKED_FIELDS:
        if field_name == "verification_state" and cancelled_now:
            continue
        old = _tracked_value(getattr(previous, field_name))
        new = _tracked_value(getattr(current, field_name))
        if old != new:
            entries.append(
                EventHistory(
                    id=uuid.uuid4().hex,
                    event_id=current.id,
                    changed_at=now,
                    field_name=field_name,
                    old_value=old,
                    new_value=new,
                    reason="value changed on re-run",
                )
            )
    return entries


def _serialize_provenance(prov: FieldProvenance) -> FieldProvenance:
    """Coerce a provenance ``chosen_value`` to a JSON-serializable form.

    The verifier chooses raw canonical values (``date``/``time`` for date/time
    fields); the repository serializes them as JSON, so date/time values are
    rendered to ISO strings here before persistence.
    """

    return FieldProvenance(
        id=prov.id,
        event_id=prov.event_id,
        field_name=prov.field_name,
        chosen_value=_tracked_value(prov.chosen_value),
        chosen_source_id=prov.chosen_source_id,
        agreement=prov.agreement,
    )


def _serialize_conflict(conflict: Conflict) -> Conflict:
    """Coerce a conflict's competing values to JSON-serializable forms."""

    return Conflict(
        id=conflict.id,
        event_id=conflict.event_id,
        field_name=conflict.field_name,
        competing_values=[
            CompetingValue(
                value=_tracked_value(cv.value),
                source_id=cv.source_id,
                source_updated_at=cv.source_updated_at,
            )
            for cv in conflict.competing_values
        ],
        resolution=conflict.resolution,
    )


def _tracked_value(value: Any) -> Any:
    """Coerce a field value to a JSON-serializable form for history diffing."""

    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if hasattr(value, "value"):
        return value.value
    return value


def _now_utc() -> datetime:
    """Current UTC timestamp (single injection point for stamps)."""

    return datetime.now(tz=UTC)


__all__ = ["RunReport", "run", "seed_demo"]
