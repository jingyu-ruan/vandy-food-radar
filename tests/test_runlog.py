"""Tests for the structured JSON run log (FEAT-002, M7, tasks.md T7.1-T7.3).

Asserts that :func:`run_report_to_json` serializes the RunReport counts plus a
change tally to valid JSON with the exact keys/values, and that the change
object mirrors the supplied changes dict. No I/O.
"""

from __future__ import annotations

import json
from datetime import date

from vandy_food_radar.pipeline import ChangeKind, run_report_to_json
from vandy_food_radar.pipeline.orchestrator import RunReport


def _report() -> RunReport:
    return RunReport(
        target_date=date(2025, 3, 11),
        fetched=5,
        merged=4,
        conflicts=1,
        cancelled=1,
        scored=4,
        history_entries=2,
    )


def test_run_report_to_json_contains_counts_and_change_tally() -> None:
    changes = {
        "a": ChangeKind.NEW,
        "b": ChangeKind.NEW,
        "c": ChangeKind.TIME_CHANGED,
        "d": ChangeKind.VENUE_CHANGED,
        "e": ChangeKind.CANCELLED,
        "f": ChangeKind.UNCHANGED,
    }
    payload = json.loads(run_report_to_json(_report(), changes))

    assert payload["target_date"] == "2025-03-11"
    assert payload["fetched"] == 5
    assert payload["merged"] == 4
    assert payload["conflicts"] == 1
    assert payload["cancelled"] == 1
    assert payload["scored"] == 4
    assert payload["history_entries"] == 2

    assert payload["changes"] == {
        "new": 2,
        "time_changed": 1,
        "venue_changed": 1,
        "cancelled": 1,
        "unchanged": 1,
    }


def test_run_report_to_json_all_zero_changes_when_none() -> None:
    payload = json.loads(run_report_to_json(_report()))
    assert payload["changes"] == {
        "new": 0,
        "time_changed": 0,
        "venue_changed": 0,
        "cancelled": 0,
        "unchanged": 0,
    }
