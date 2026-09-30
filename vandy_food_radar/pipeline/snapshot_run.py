"""Snapshot-backed run wrapper for the stateless-serverless path (M7-M9).

Runs the existing pipeline unchanged, then reconciles the fresh events against
the previous run's snapshot to produce a change map and repopulates the
snapshot for the next run. Adds no SQLite writes of its own; change detection
lives entirely in the injected :class:`~vandy_food_radar.store.SnapshotStore`.
"""

from __future__ import annotations

from collections.abc import Sequence

from ..config import Config
from ..providers.location import LocationProvider
from ..sources import SourceAdapter, Window
from ..store import Repository, SnapshotStore
from .change_detect import ChangeKind, detect_changes
from .orchestrator import RunReport, run


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


__all__ = ["run_with_snapshot"]
