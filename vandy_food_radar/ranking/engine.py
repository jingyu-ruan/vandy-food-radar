"""Transparent weighted-sum ranking engine (design.md §6.1/§6.2, T6.2).

Scores a verified :class:`~vandy_food_radar.models.Event` by normalizing each
factor to ``[0, 1]``, multiplying by its configured weight, and summing the
contributions (``score_total = Σ weight_f × value_f``). Every factor's raw
value, weight, contribution, and an explanatory note are captured as a
:class:`~vandy_food_radar.models.ScoreComponent`, so the total is fully
explainable (FR-22–FR-24).

Ordering (FR-26) is deterministic: ``score_total`` descending, then the earlier
``start_time``, then ``title`` ascending. Cancelled events are forced to the
bottom of the ranked list and flagged (§6.1).

Walking convenience is read through an injected
:class:`~vandy_food_radar.providers.LocationProvider`; an unknown walk uses
``config.ranking.walking_unknown_value`` and never zeroes the score
(FR-30, AC-8). Pure given its inputs apart from the provider call.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import time

from ..config import Config
from ..models import (
    Event,
    FoodCategory,
    FoodConfirmed,
    GeoPoint,
    ScoreComponent,
    ScoreFactor,
    VerificationState,
)
from ..participation import (
    ParticipationAssessment,
    ParticipationLevel,
    assess_participation,
    participation_factor_value,
    participation_input_for,
)
from ..providers.location import (
    LocationProvider,
    WalkingResult,
    WalkingStatus,
    walking_factor_value,
)

# Factor values for the discrete food-confirmation states (§6.1).
_FOOD_CONFIRMED_VALUE: dict[FoodConfirmed, float] = {
    FoodConfirmed.CONFIRMED: 1.0,
    FoodConfirmed.UNCONFIRMED: 0.3,
    FoodConfirmed.CONTRADICTED: 0.0,
}

# Factor values for the food-category ladder (§6.1).
_FULL_MEAL_VALUE: dict[FoodCategory, float] = {
    FoodCategory.FULL_MEAL: 1.0,
    FoodCategory.SNACKS_OR_REFRESHMENTS: 0.4,
    FoodCategory.UNSPECIFIED: 0.2,
    FoodCategory.NONE: 0.0,
}

# Words that add no menu specificity when counting named food items.
_GENERIC_FOOD_WORDS: frozenset[str] = frozenset(
    {
        "food",
        "free",
        "and",
        "the",
        "a",
        "an",
        "of",
        "with",
        "for",
        "provided",
        "served",
        "included",
        "refreshments",
        "snacks",
        "snack",
        "light",
        "bites",
        "drinks",
        "all",
        "students",
        "some",
        "will",
        "be",
    }
)

_WORD_RE = re.compile(r"[a-zA-Z]+")


@dataclass
class ScoredEvent:
    """A scored event and its per-factor breakdown.

    ``event`` has ``score_total`` set; ``components`` holds one
    :class:`ScoreComponent` per :class:`ScoreFactor`, in the fixed
    :class:`ScoreFactor` order for deterministic persistence.
    """

    event: Event
    components: list[ScoreComponent]


def score_event(
    event: Event,
    *,
    config: Config,
    location_provider: LocationProvider,
    participation: ParticipationAssessment | None = None,
) -> ScoredEvent:
    """Score one event into a :class:`ScoredEvent` (design.md §6.1).

    Computes each factor's normalized value, weights it, records a
    :class:`ScoreComponent` with an explanatory note, and sets
    ``event.score_total`` to the weighted sum. The event is not mutated apart
    from ``score_total``.

    The design weights in ``config.ranking.weights`` keep their documented
    values and are scaled by ``1 - participation_influence``; the remaining
    share goes to the participation-convenience factor. The total therefore
    still lands in ``[0, 1]`` and the participation inference is capped at the
    configured influence (5% by default). ``participation`` is derived from the
    event's own listed text when not supplied.
    """

    weights = config.ranking.weights
    walking = _walking_result(event, config=config, location_provider=location_provider)
    assessment = (
        participation
        if participation is not None
        else assess_participation(participation_input_for(event))
    )
    influence = min(max(config.ranking.participation_influence, 0.0), 1.0)
    design_scale = 1.0 - influence

    raw_values: dict[ScoreFactor, float] = {
        ScoreFactor.FOOD_CONFIRMED: _food_confirmed_value(event),
        ScoreFactor.FULL_MEAL: _full_meal_value(event),
        ScoreFactor.FOOD_SPECIFICITY: _food_specificity_value(event),
        ScoreFactor.RSVP_LIKELIHOOD: _rsvp_likelihood_value(event),
        ScoreFactor.TIMING: _timing_value(event, config=config),
        ScoreFactor.WALKING: walking_factor_value(
            walking, unknown_value=config.ranking.walking_unknown_value
        ),
        ScoreFactor.CONFIDENCE: _confidence_value(event),
        ScoreFactor.PARTICIPATION: participation_factor_value(
            assessment, unknown_value=config.ranking.participation_unknown_value
        ),
    }
    notes: dict[ScoreFactor, str] = {
        ScoreFactor.FOOD_CONFIRMED: _food_confirmed_note(event),
        ScoreFactor.FULL_MEAL: _full_meal_note(event),
        ScoreFactor.FOOD_SPECIFICITY: _food_specificity_note(event),
        ScoreFactor.RSVP_LIKELIHOOD: _rsvp_likelihood_note(event),
        ScoreFactor.TIMING: _timing_note(event),
        ScoreFactor.WALKING: _walking_note(walking),
        ScoreFactor.CONFIDENCE: _confidence_note(event),
        ScoreFactor.PARTICIPATION: _participation_note(assessment),
    }

    components: list[ScoreComponent] = []
    total = 0.0
    for factor in ScoreFactor:
        if factor is ScoreFactor.PARTICIPATION:
            weight = influence
        else:
            weight = round(weights.get(factor, 0.0) * design_scale, 6)
        raw = raw_values[factor]
        contribution = round(weight * raw, 6)
        total += contribution
        components.append(
            ScoreComponent(
                id=uuid.uuid4().hex,
                event_id=event.id,
                factor=factor,
                raw_value=round(raw, 4),
                weight=weight,
                contribution=contribution,
                note=notes[factor],
            )
        )

    event.score_total = round(total, 6)
    return ScoredEvent(event=event, components=components)


def recommendation_stars(score_total: float | None) -> int:
    """Map a total score to the 0-5 recommendation stars shown on a card.

    The scale is fixed and linear over ``[0, 1]`` so two events with the same
    score always display the same number of stars, and the stars can be read
    back to a score. ``None`` (not yet scored) shows zero stars.
    """

    if score_total is None:
        return 0
    clamped = min(max(score_total, 0.0), 1.0)
    return int(round(clamped * 5))


def order_events(scored: list[ScoredEvent]) -> list[ScoredEvent]:
    """Order scored events deterministically (design.md §6.2, FR-26).

    Cancelled events are forced below every non-cancelled event; within each
    group the order is ``score_total`` descending, then the earlier
    ``start_time`` (missing times sort last), then ``title`` ascending.
    """

    return sorted(scored, key=_order_key)


# ---------------------------------------------------------------------------
# factor value derivations (§6.1)
# ---------------------------------------------------------------------------


def _food_confirmed_value(event: Event) -> float:
    return _FOOD_CONFIRMED_VALUE.get(event.food_confirmed, 0.3)


def _full_meal_value(event: Event) -> float:
    return _FULL_MEAL_VALUE.get(event.food_category, 0.2)


def _food_specificity_value(event: Event) -> float:
    """Scale by menu/description detail: named items score higher than generic.

    Zero named items (e.g. "refreshments") scores 0.0; each distinct named food
    word adds 0.25 up to a cap of 1.0, so a described menu (tacos, rice, beans)
    outscores a vague blurb (§6.1, US-4).
    """

    named = _named_food_terms(event.food_description)
    return round(min(1.0, 0.25 * len(named)), 4)


def _rsvp_likelihood_value(event: Event) -> float:
    """Likelihood of successfully receiving food given RSVP status (§6.1)."""

    if event.rsvp_required is False:
        return 1.0
    if event.rsvp_required is True:
        if event.rsvp_link_ok is False:
            return 0.3
        return 0.7
    return 0.5


def _timing_value(event: Event, *, config: Config) -> float:
    """Preference curve over the start time (§6.1).

    Full value inside the configured good window; linearly decaying outside it
    down to 0.0 four hours past either edge. Unknown start time is neutral 0.5.
    """

    start = event.start_time
    if start is None:
        return 0.5
    good_start = config.ranking.timing_good_start_hour
    good_end = config.ranking.timing_good_end_hour
    hour = start.hour + start.minute / 60.0
    if good_start <= hour <= good_end:
        return 1.0
    falloff_hours = 4.0
    if hour < good_start:
        gap = good_start - hour
    else:
        gap = hour - good_end
    return round(max(0.0, 1.0 - gap / falloff_hours), 4)


def _confidence_value(event: Event) -> float:
    """Verifier confidence passed through directly (§6.1)."""

    return event.confidence if event.confidence is not None else 0.5


def _walking_result(
    event: Event,
    *,
    config: Config,
    location_provider: LocationProvider,
) -> WalkingResult:
    """Consult the location provider for the event's walking convenience."""

    ref = config.reference_location
    origin = GeoPoint(lat=ref.lat, lng=ref.lng)
    return location_provider.walking(origin, event.location_geo)


# ---------------------------------------------------------------------------
# explanatory notes (feed the explanation generator, §6.3)
# ---------------------------------------------------------------------------


def _food_confirmed_note(event: Event) -> str:
    if event.food_confirmed is FoodConfirmed.CONFIRMED:
        return "free food is confirmed"
    if event.food_confirmed is FoodConfirmed.CONTRADICTED:
        return "sources disagree on whether food is provided"
    return "free food is not confirmed"


def _full_meal_note(event: Event) -> str:
    if event.food_category is FoodCategory.FULL_MEAL:
        return "appears to be a full meal"
    if event.food_category is FoodCategory.SNACKS_OR_REFRESHMENTS:
        return "snacks or refreshments only"
    if event.food_category is FoodCategory.NONE:
        return "no food described"
    return "food type unspecified"


def _food_specificity_note(event: Event) -> str:
    named = _named_food_terms(event.food_description)
    if named:
        preview = ", ".join(named[:3])
        return f"specific menu ({preview})"
    return "vague food description"


def _rsvp_likelihood_note(event: Event) -> str:
    if event.rsvp_required is False:
        return "no RSVP needed"
    if event.rsvp_required is True:
        if event.rsvp_link_ok is False:
            return "RSVP required but the link looks broken"
        return "RSVP required"
    return "RSVP requirement unknown"


def _timing_note(event: Event) -> str:
    if event.start_time is None:
        return "start time unknown"
    return f"starts at {event.start_time.strftime('%H:%M')}"


def _walking_note(result: WalkingResult) -> str:
    if result.status is WalkingStatus.OK and result.minutes is not None:
        return f"about a {result.minutes} min walk"
    return "walking distance unavailable"


def _confidence_note(event: Event) -> str:
    if event.confidence is None:
        return "confidence unknown"
    return f"verified with {round(event.confidence * 100)}% confidence"


def _participation_note(assessment: ParticipationAssessment) -> str:
    """Short factor note; the card shows the fuller assessment and warnings."""

    if assessment.level is ParticipationLevel.OPEN:
        return "listed as open to attend"
    if assessment.level is ParticipationLevel.RESTRICTED:
        return "the listing states an eligibility limit"
    return "the listing does not say who may attend"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _named_food_terms(description: str | None) -> list[str]:
    """Return distinct, non-generic food words from a description (order-stable)."""

    if not description:
        return []
    seen: list[str] = []
    for match in _WORD_RE.findall(description.lower()):
        if len(match) <= 2 or match in _GENERIC_FOOD_WORDS:
            continue
        if match not in seen:
            seen.append(match)
    return seen


def _order_key(scored: ScoredEvent) -> tuple[int, float, float, str]:
    """Deterministic sort key (§6.2): cancelled last, score desc, time, title."""

    event = scored.event
    cancelled = 1 if event.verification_state is VerificationState.CANCELLED else 0
    score = event.score_total if event.score_total is not None else 0.0
    return (cancelled, -score, _time_ordinal(event.start_time), event.title.lower())


def _time_ordinal(value: time | None) -> float:
    """Minutes since midnight, or ``+inf`` so an unknown time sorts last."""

    if value is None:
        return float("inf")
    return value.hour * 60 + value.minute


__all__ = [
    "ScoredEvent",
    "order_events",
    "recommendation_stars",
    "score_event",
]
