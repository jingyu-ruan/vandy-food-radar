"""Deduplication stage (design.md §4, T4.1-T4.4, FR-12-FR-15, E-1, E-10, E-13).

Pure, deterministic, no-I/O helpers that group normalized records describing the
same event into a single merged event. Comprises the similarity primitives
(title/time/location/organizer with date blocking) and the deduplicator that
clusters records against the configurable thresholds, flags borderline merges
as ``possible_duplicate``, and computes a stable ``dedup_key`` for idempotent
upsert.
"""

from __future__ import annotations

from .deduplicator import (
    FINGERPRINT_TIME_ROUNDING_MINUTES,
    MergedEvent,
    compute_dedup_key,
    deduplicate,
)
from .similarity import (
    block_by_date,
    combined_similarity,
    location_sim,
    organizer_sim,
    time_proximity,
    title_sim,
    title_tokens,
)

__all__ = [
    "FINGERPRINT_TIME_ROUNDING_MINUTES",
    "MergedEvent",
    "block_by_date",
    "combined_similarity",
    "compute_dedup_key",
    "deduplicate",
    "location_sim",
    "organizer_sim",
    "time_proximity",
    "title_sim",
    "title_tokens",
]
