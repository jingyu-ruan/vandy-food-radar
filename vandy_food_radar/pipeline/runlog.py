"""Structured JSON run log (M7, tasks.md T7.1-T7.3).

Emits one machine-readable JSON line summarizing a pipeline run: the
:class:`~vandy_food_radar.pipeline.orchestrator.RunReport` counts plus the
cross-run change tally (from
:func:`~vandy_food_radar.pipeline.change_detect.tally_changes`). The CLI ``run``
prints this line in addition to its human-readable summary, and the serverless
``/cron/refresh`` route returns the same JSON as its response body, so the
scheduled-automation observability is identical online and offline.
"""

from __future__ import annotations

import json
import sys
import typing

from .change_detect import ChangeKind, tally_changes
from .orchestrator import RunReport


def run_report_to_json(
    report: RunReport,
    changes: dict[str, ChangeKind] | None = None,
) -> str:
    """Serialize ``report`` (and optional ``changes``) to a JSON string.

    The ``changes`` object carries per-kind tallies from
    :func:`tally_changes`; all zeros when ``changes`` is ``None``. Uses
    ``sort_keys=True`` for deterministic output.
    """

    counts = tally_changes(changes if changes is not None else {})
    payload = {
        "target_date": report.target_date.isoformat(),
        "fetched": report.fetched,
        "merged": report.merged,
        "conflicts": report.conflicts,
        "cancelled": report.cancelled,
        "scored": report.scored,
        "history_entries": report.history_entries,
        "changes": {
            "new": counts.new,
            "time_changed": counts.time_changed,
            "venue_changed": counts.venue_changed,
            "cancelled": counts.cancelled,
            "unchanged": counts.unchanged,
        },
    }
    return json.dumps(payload, sort_keys=True)


def log_run_report(
    report: RunReport,
    changes: dict[str, ChangeKind] | None = None,
    *,
    stream: typing.TextIO = sys.stdout,
) -> None:
    """Print the JSON run log for ``report`` to ``stream``."""

    print(run_report_to_json(report, changes), file=stream)


__all__ = ["run_report_to_json", "log_run_report"]
