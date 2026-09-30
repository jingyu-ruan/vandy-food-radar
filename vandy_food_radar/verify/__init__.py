"""Verification & conflict-resolution stage (design.md §5, T5.1-T5.6).

Cross-checks each canonical field across the sources that contributed to a
merged event, resolves disagreements by authority precedence with a recency
tie-break (preserving every losing value as a :class:`~vandy_food_radar.models.\
Conflict`), incorporates the official page with top authority while degrading
gracefully when it cannot be parsed, and derives an event-level
``verification_state`` plus a deterministic ``confidence``. Cancellation from an
authoritative source overrides the state and appends a history entry.

Pure given the records: no network, DB, or file I/O.
"""

from __future__ import annotations

from .conflict import (
    CROSS_CHECKED_FIELDS,
    FieldResolution,
    SourceValue,
    resolve_field,
)
from .verifier import VerifiedEvent, verify

__all__ = [
    "CROSS_CHECKED_FIELDS",
    "FieldResolution",
    "SourceValue",
    "VerifiedEvent",
    "resolve_field",
    "verify",
]
