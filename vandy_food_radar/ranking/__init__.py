"""Ranking stage (design.md §6, T6.2–T6.4, FR-22–FR-27, US-3/US-4).

A transparent weighted-sum scorer: every factor is normalized to ``[0, 1]``,
multiplied by its configurable weight from
:class:`~vandy_food_radar.config.RankingConfig`, and stored as a
:class:`~vandy_food_radar.models.ScoreComponent` with a human-readable note so
the UI can explain each total. Exposes the scoring engine, the deterministic
ordering, and the explanation generator.
"""

from __future__ import annotations

from .engine import ScoredEvent, order_events, recommendation_stars, score_event
from .explanation import build_explanation

__all__ = [
    "ScoredEvent",
    "build_explanation",
    "order_events",
    "recommendation_stars",
    "score_event",
]
