"""Ranking explanation generator (design.md §6.3, T6.3, FR-25, AC-3).

Builds a short, human-readable "why this rank" sentence for an event by joining
the notes of its top-contributing :class:`~vandy_food_radar.models.ScoreComponent`
objects. A confirmed dinner with a named menu cites the full meal and specific
items; a "refreshments" event cites the vagueness / lack of confirmation — the
user can see exactly why one event ranks above another (US-4).

Pure: no I/O.
"""

from __future__ import annotations

from ..models import ScoreComponent, VerificationState

# How many of the highest-contributing factors to mention.
_MAX_REASONS = 4


def build_explanation(
    components: list[ScoreComponent],
    *,
    verification_state: VerificationState,
) -> str:
    """Return a one-line explanation of an event's ranking (§6.3).

    Cancelled events are called out first. Otherwise the top contributing
    factors (by contribution, ties broken by the fixed factor order) are joined
    into a readable sentence prefixed by whether the event ranked high or low.
    """

    if verification_state is VerificationState.CANCELLED:
        return "Ranked at the bottom: this event is cancelled."

    if not components:
        return "No ranking factors were available for this event."

    ordered = sorted(
        enumerate(components),
        key=lambda pair: (-_contribution(pair[1]), pair[0]),
    )
    reasons = [
        component.note for _, component in ordered[:_MAX_REASONS] if component.note
    ]

    total = sum(_contribution(c) for c in components)
    lead = "Ranked high" if total >= 0.6 else "Ranked lower"
    if reasons:
        return f"{lead}: {', '.join(reasons)}."
    return f"{lead}."


def _contribution(component: ScoreComponent) -> float:
    return component.contribution


__all__ = ["build_explanation"]
