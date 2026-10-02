"""Pipeline orchestration (design.md §1.1, T6.5, FR-41–FR-43, AC-10/AC-11).

Threads the MVP stages together — ingest -> normalize -> dedup -> verify ->
score -> save — behind a single :func:`run` entry point that reads sources
through injected adapters and persists through the :class:`Repository`. Writes
are idempotent (upsert on ``dedup_key``) and changed tracked fields append
:class:`~vandy_food_radar.models.EventHistory` rows. Also exposes the
:func:`seed_demo` helper that loads the offline corpus with its dates retargeted
onto the target day so the web view is never empty.
"""

from __future__ import annotations

from .change_detect import (
    ChangeCounts,
    ChangeFlag,
    ChangeKind,
    detect_changes,
    tally_changes,
)
from .orchestrator import (
    LAST_SUCCESS_DAYS_KEY,
    LAST_SUCCESS_KEY,
    REFRESH_DAY_CHOICES,
    RunReport,
    retention_window,
    run,
    run_days,
    seed_demo,
)
from .runlog import log_run_report, run_report_to_json
from .snapshot_run import run_days_with_snapshot, run_with_snapshot

__all__ = [
    "LAST_SUCCESS_DAYS_KEY",
    "LAST_SUCCESS_KEY",
    "REFRESH_DAY_CHOICES",
    "RunReport",
    "retention_window",
    "run",
    "run_days",
    "seed_demo",
    "ChangeKind",
    "ChangeFlag",
    "ChangeCounts",
    "detect_changes",
    "tally_changes",
    "run_days_with_snapshot",
    "run_with_snapshot",
    "run_report_to_json",
    "log_run_report",
]
