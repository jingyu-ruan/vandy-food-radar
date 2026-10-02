"""Snapshot-backed run wrappers for the stateless-serverless path (M7-M9).

Runs the existing pipeline unchanged, then reconciles the fresh events against
the previous run's snapshot to produce a change map and repopulates the
snapshot for the next run. Adds no SQLite writes of its own; change detection
lives entirely in the injected :class:`~vandy_food_radar.store.SnapshotStore`.

Two entry points share that behavior: :func:`run_with_snapshot` for the
established single-day contract, and :func:`run_days_with_snapshot` for a
batched multi-day refresh whose durable publication happens once, after every
requested day has succeeded.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date

from ..config import Config
from ..providers.location import LocationProvider
from ..sources import SourceAdapter, Window
from ..store import Repository, SnapshotStore
from .change_detect import ChangeKind, detect_changes
from .orchestrator import RunReport, run, run_days


def run_with_snapshot(
    window: Window,
    *,
    repository: Repository,
    sources: Sequence[SourceAdapter],
    location_provider: LocationProvider,
    config: Config,
    snapshot_store: SnapshotStore,
) -> tuple[RunReport, dict[str, ChangeKind]]:
    """Run the pipeline and classify changes against the previous snapshot.

    Returns the pipeline's :class:`RunReport` and a map of ``identity_key`` to
    :class:`ChangeKind`. The snapshot is loaded before, and repopulated after,
    the fresh events are read (a missing snapshot => all events NEW).
    """

    report = run(
        window,
        repository=repository,
        sources=sources,
        location_provider=location_provider,
        config=config,
    )
    fresh = repository.get_events_for_day(window.target_date)
    previous = snapshot_store.load_snapshot(window.target_date)
    changes = detect_changes(fresh, previous)
    snapshot_store.save_snapshot(window.target_date, fresh)
    return report, changes


def run_days_with_snapshot(
    days: Sequence[date],
    *,
    repository: Repository,
    sources: Sequence[SourceAdapter],
    location_provider: LocationProvider,
    config: Config,
    snapshot_store: SnapshotStore,
    today: date,
) -> tuple[RunReport, dict[str, ChangeKind]]:
    """Refresh several days atomically, then classify changes per day.

    Change snapshots are only touched after :func:`run_days` has published, so
    a failed batch leaves both the feed and the change baselines as they were.
    """

    report = run_days(
        days,
        repository=repository,
        sources=sources,
        location_provider=location_provider,
        config=config,
        today=today,
    )

    changes: dict[str, ChangeKind] = {}
    for day in report.days:
        fresh = repository.get_events_for_day(day)
        previous = snapshot_store.load_snapshot(day)
        changes.update(detect_changes(fresh, previous))
        snapshot_store.save_snapshot(day, fresh)
    return report, changes


__all__ = ["run_days_with_snapshot", "run_with_snapshot"]
