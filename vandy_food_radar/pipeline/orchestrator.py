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

import json
import uuid
from collections.abc import Sequence
from contextlib import nullcontext
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

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
from ..participation import assess_participation, participation_input_for
from ..places import PlaceDataset, load_places_for
from ..providers.location import LocationProvider
from ..ranking import score_event
from ..sources import FixtureFetcher, FixtureSourceAdapter, SourceAdapter, Window
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
    # Every local day this report covers, in ascending order. Single-day runs
    # list exactly ``target_date``.
    days: list[date] = field(default_factory=list)
    # Dates retained after the run applied the rolling retention window.
    retained_days: list[date] = field(default_factory=list)


# Metadata keys written to the repository after a complete successful refresh.
LAST_SUCCESS_KEY = "refresh:last_success_at"
LAST_SUCCESS_DAYS_KEY = "refresh:last_success_days"

# Day counts a protected refresh may request.
REFRESH_DAY_CHOICES: tuple[int, ...] = (1, 2, 7)


def material_change_key(event: Event) -> str:
    return f"change:{event.event_date.isoformat()}:{event.identity_key}"


def run(
    window: Window,
    *,
    repository: Repository,
    sources: Sequence[SourceAdapter],
    location_provider: LocationProvider,
    config: Config,
    publish: bool = True,
    places: PlaceDataset | None = None,
) -> RunReport:
    """Run the full pipeline for ``window`` and persist the results.

    Returns a :class:`RunReport` with per-stage counts. Idempotent: a repeated
    run upserts by ``identity_key`` and records history only for fields that
    actually changed (FR-42/FR-43, AC-10/AC-11).

    ``publish`` controls durable publication. The default ``True`` preserves the
    established single-day contract (the run ends with a flush). A batched
    multi-day refresh passes ``False`` for each day and flushes exactly once
    after every day has succeeded, so a failure partway through leaves the
    previously published feed untouched.
    """

    report = RunReport(target_date=window.target_date, days=[window.target_date])
    dataset = places if places is not None else load_places_for(config)

    ingested: list[SourceRecord] = []
    for adapter in sources:
        ingested.extend(adapter.fetch(window))
    report.fetched = len(ingested)

    source_map = {record.id: record for record in ingested}
    normalized = [normalize(record, timezone=config.timezone) for record in ingested]
    merged_events = deduplicate(normalized, config=config.dedup)
    report.merged = len(merged_events)
    published_identity_keys: set[str] = set()

    for merged in merged_events:
        verified = verify(merged, source_map, config=config)
        member_records = [
            source_map[m.source_record_id]
            for m in merged.members
            if m.source_record_id in source_map
        ]
        # Coordinates come only from the curated campus dataset; an unmatched
        # location stays unresolved rather than being approximated.
        resolved = dataset.resolve(verified.event.location)
        verified.event.location_geo = resolved.place.point if resolved else None
        assessment = assess_participation(
            participation_input_for(verified.event, member_records)
        )
        scored = score_event(
            verified.event,
            config=config,
            location_provider=location_provider,
            participation=assessment,
        )
        event = scored.event
        report.conflicts += len(verified.conflicts)
        if event.verification_state is VerificationState.CANCELLED:
            report.cancelled += 1
        report.scored += 1

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
        if previous is not None:
            changed_kind = None
            if (previous.event_date, previous.start_time, previous.end_time) != (
                event.event_date,
                event.start_time,
                event.end_time,
            ):
                changed_kind = "time_changed"
            elif previous.location != event.location:
                changed_kind = "venue_changed"
            if changed_kind:
                repository.set_metadata(
                    material_change_key(event),
                    json.dumps({"kind": changed_kind, "at": now.isoformat()}),
                )
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
        published_identity_keys.add(event.identity_key)

    # Scoped to the refreshed day only, so a partial multi-day batch can never
    # erase another day. Durable repositories publish in ``flush``, so an API or
    # pipeline failure cannot overwrite the last known-good feed.
    repository.replace_day(window.target_date, published_identity_keys)
    if publish:
        repository.flush()
    return report


def retention_window(today: date, config: Config) -> set[date]:
    """Dates a refresh is allowed to keep, anchored on ``today``.

    Bounds the durable snapshot regardless of how often the schedulers run:
    anything older than ``retention.past_days`` or further out than
    ``retention.future_days`` is dropped.
    """

    start = today - timedelta(days=max(0, config.retention.past_days))
    end = today + timedelta(days=max(0, config.retention.future_days))
    span = (end - start).days
    return {start + timedelta(days=offset) for offset in range(span + 1)}


def run_days(
    days: Sequence[date],
    *,
    repository: Repository,
    sources: Sequence[SourceAdapter],
    location_provider: LocationProvider,
    config: Config,
    today: date,
) -> RunReport:
    """Refresh several local days and publish them in one durable write.

    Each day is ingested, scored, and written locally with ``publish=False``.
    Only once every requested day has completed does the run apply the rolling
    retention window, record the last-success metadata, and flush. Any failure
    propagates before the flush, so the previously published feed survives
    intact and no day is partially replaced.
    """

    ordered = sorted(set(days))
    if not ordered:
        raise ValueError("run_days requires at least one day")

    combined = RunReport(target_date=ordered[0], days=list(ordered))
    batch_factory = getattr(repository, "atomic_batch", None)
    batch = batch_factory() if callable(batch_factory) else nullcontext()
    with batch:
        for day in ordered:
            day_report = run(
                Window(target_date=day),
                repository=repository,
                sources=sources,
                location_provider=location_provider,
                config=config,
                publish=False,
            )
            combined.fetched += day_report.fetched
            combined.merged += day_report.merged
            combined.conflicts += day_report.conflicts
            combined.cancelled += day_report.cancelled
            combined.scored += day_report.scored
            combined.history_entries += day_report.history_entries
            combined.saved_event_ids.extend(day_report.saved_event_ids)

        keep = retention_window(today, config) | set(ordered)
        repository.prune_days(keep)
        repository.set_metadata(LAST_SUCCESS_KEY, _now_utc().isoformat())
        repository.set_metadata(LAST_SUCCESS_DAYS_KEY, str(len(ordered)))
        repository.flush()
        combined.retained_days = repository.stored_days()
    return combined


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

    base_today = (
        today
        if today is not None
        else datetime.now(tz=ZoneInfo(config.timezone)).date()
    )
    window = Window.from_config(config, today=base_today)

    fetcher = FixtureFetcher()
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


__all__ = [
    "LAST_SUCCESS_DAYS_KEY",
    "LAST_SUCCESS_KEY",
    "REFRESH_DAY_CHOICES",
    "RunReport",
    "retention_window",
    "run",
    "run_days",
    "seed_demo",
]
