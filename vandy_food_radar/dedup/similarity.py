"""Deterministic similarity primitives for deduplication (design.md §4, T4.1).

Pure functions over :class:`~vandy_food_radar.normalize.NormalizedRecord`
values that score how alike two source records are, plus a blocking helper that
groups records by ``event_date`` so recurring occurrences on different days are
never compared (FR-13, E-10).

No machine learning: every score is a transparent, deterministic string/number
computation so a user can understand why two records were (or were not) treated
as the same event.

Pure and deterministic: no network, DB, or file I/O.
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, time

from ..config import DedupConfig
from ..normalize import NormalizedRecord

# Common English/event stop words removed before title tokenization so that
# "Free Pizza Night" and "Pizza Night (Free!)" share the same salient tokens.
TITLE_STOPWORDS: frozenset[str] = frozenset(
    {
        "a",
        "an",
        "and",
        "at",
        "for",
        "free",
        "in",
        "of",
        "on",
        "the",
        "to",
        "with",
    }
)

# Combined-similarity weights (sum to 1.0). Title dominates because it is the
# strongest signal that two records describe the same event.
TITLE_WEIGHT = 0.45
TIME_WEIGHT = 0.25
LOCATION_WEIGHT = 0.20
ORGANIZER_WEIGHT = 0.10

_PUNCT_RE = re.compile(r"[^a-z0-9\s]+")
_WS_RE = re.compile(r"\s+")


def _normalize_text(value: str | None) -> str:
    """Lowercase, strip punctuation, and collapse whitespace (deterministic)."""

    if not value:
        return ""
    lowered = value.lower()
    lowered = _PUNCT_RE.sub(" ", lowered)
    return _WS_RE.sub(" ", lowered).strip()


def title_tokens(value: str | None) -> frozenset[str]:
    """Return the salient, stop-word-filtered token set for a title.

    Lowercased, punctuation-stripped tokens with stop words removed, so that
    slight wording differences (parenthetical/exclamatory) collapse to the same
    set (design.md §4).
    """

    normalized = _normalize_text(value)
    if not normalized:
        return frozenset()
    tokens = {
        tok for tok in normalized.split(" ") if tok and tok not in TITLE_STOPWORDS
    }
    return frozenset(tokens)


def _jaccard(left: frozenset[str], right: frozenset[str]) -> float:
    """Jaccard index of two token sets; empty/empty is treated as no signal."""

    if not left and not right:
        return 0.0
    union = left | right
    if not union:
        return 0.0
    return len(left & right) / len(union)


def title_sim(left: str | None, right: str | None) -> float:
    """Token Jaccard similarity of two titles in ``[0, 1]``.

    ``"Free Pizza Night"`` and ``"Pizza Night (Free!)"`` both reduce to the
    tokens ``{"pizza", "night"}`` and therefore score ``1.0``.
    """

    return _jaccard(title_tokens(left), title_tokens(right))


def _minutes(value: time | None) -> int | None:
    """Wall-clock minutes-since-midnight for a time, ignoring tzinfo."""

    if value is None:
        return None
    return value.hour * 60 + value.minute


def time_proximity(
    left: time | None,
    right: time | None,
    *,
    window_minutes: int,
) -> float:
    """Start-time closeness in ``[0, 1]``.

    ``1.0`` when the two start times are identical, decaying linearly to ``0.0``
    at ``window_minutes`` apart and beyond. When either time is unknown the
    result is ``0.0`` (no positive signal, but never negative).
    """

    left_min = _minutes(left)
    right_min = _minutes(right)
    if left_min is None or right_min is None:
        return 0.0
    if window_minutes <= 0:
        return 1.0 if left_min == right_min else 0.0
    delta = abs(left_min - right_min)
    if delta >= window_minutes:
        return 0.0
    return 1.0 - (delta / window_minutes)


def location_sim(left: str | None, right: str | None) -> float:
    """Token Jaccard similarity of two venue strings in ``[0, 1]``.

    Handles ``"Sarratt Student Center, Room 216"`` vs
    ``"Sarratt Student Center 216"`` (punctuation-insensitive token overlap).
    """

    left_tokens = frozenset(_normalize_text(left).split(" ")) - {""}
    right_tokens = frozenset(_normalize_text(right).split(" ")) - {""}
    return _jaccard(left_tokens, right_tokens)


def organizer_sim(left: str | None, right: str | None) -> float:
    """Token Jaccard similarity of two organizer strings in ``[0, 1]``."""

    left_tokens = frozenset(_normalize_text(left).split(" ")) - {""}
    right_tokens = frozenset(_normalize_text(right).split(" ")) - {""}
    return _jaccard(left_tokens, right_tokens)


def combined_similarity(
    left: NormalizedRecord,
    right: NormalizedRecord,
    *,
    config: DedupConfig,
) -> float:
    """Weighted overall similarity of two normalized records in ``[0, 1]``.

    Combines title, start-time proximity, location, and organizer similarity
    (design.md §4). Components whose inputs are absent contribute ``0`` rather
    than penalizing, keeping the score deterministic and monotonic.
    """

    return (
        TITLE_WEIGHT * title_sim(left.title, right.title)
        + TIME_WEIGHT
        * time_proximity(
            left.start_time,
            right.start_time,
            window_minutes=config.time_proximity_minutes,
        )
        + LOCATION_WEIGHT * location_sim(left.location, right.location)
        + ORGANIZER_WEIGHT * organizer_sim(left.organizer, right.organizer)
    )


def block_by_date(
    records: list[NormalizedRecord],
) -> dict[date | None, list[NormalizedRecord]]:
    """Group records by ``event_date`` so different days are never compared.

    Records whose ``event_date`` could not be parsed share the ``None`` block
    and are only ever compared with each other (never with dated records), so
    recurring occurrences on different days stay separate (E-10). Input order is
    preserved within each block for deterministic clustering.
    """

    blocks: dict[date | None, list[NormalizedRecord]] = defaultdict(list)
    for record in records:
        blocks[record.event_date].append(record)
    return dict(blocks)


__all__ = [
    "LOCATION_WEIGHT",
    "ORGANIZER_WEIGHT",
    "TIME_WEIGHT",
    "TITLE_STOPWORDS",
    "TITLE_WEIGHT",
    "block_by_date",
    "combined_similarity",
    "location_sim",
    "organizer_sim",
    "time_proximity",
    "title_sim",
    "title_tokens",
]
