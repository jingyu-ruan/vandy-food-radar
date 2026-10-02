"""Tests for participation assessment and its capped ranking influence.

Three properties matter: the assessment rests on explicit listed evidence,
eligibility restrictions are reported as warnings rather than quiet score
penalties, and the convenience nudge cannot exceed the configured 5%.
"""

from __future__ import annotations

from datetime import date, time

from vandy_food_radar.config import Config
from vandy_food_radar.models import (
    Event,
    FoodCategory,
    FoodConfirmed,
    ParseStatus,
    ScoreFactor,
    SourceId,
    SourceRecord,
    VerificationState,
)
from vandy_food_radar.participation import (
    ParticipationAssessment,
    ParticipationInput,
    ParticipationLevel,
    assess_participation,
    participation_factor_value,
    participation_input_for,
)
from vandy_food_radar.providers.location import NullLocationProvider
from vandy_food_radar.ranking import score_event


def _assess(
    description: str,
    *,
    title: str | None = None,
    organizer: str | None = None,
) -> ParticipationAssessment:
    return assess_participation(
        ParticipationInput(description=description, title=title, organizer=organizer)
    )


def _event(**overrides: object) -> Event:
    base = {
        "id": "evt",
        "dedup_key": "key",
        "identity_key": "2025-03-11|dinner",
        "title": "Open House Dinner",
        "event_date": date(2025, 3, 11),
        "start_time": time(18, 0),
        "end_time": time(20, 0),
        "food_confirmed": FoodConfirmed.CONFIRMED,
        "food_category": FoodCategory.FULL_MEAL,
        "food_description": "Dinner with tacos and rice.",
        "verification_state": VerificationState.VERIFIED,
        "confidence": 0.9,
    }
    base.update(overrides)
    return Event(**base)  # type: ignore[arg-type]


def test_explicit_invitation_reads_as_open_with_evidence() -> None:
    result = _assess("Free pizza. Open to all students, no RSVP required.")
    assert result.level is ParticipationLevel.OPEN
    assert result.certain is True
    assert result.evidence
    assert "anyone can attend" in result.note


def test_silence_is_reported_as_unknown_and_uncertain() -> None:
    """A terse listing is reported as unassessed, with no invented evidence."""

    result = _assess("Refreshments provided.")
    assert result.level is ParticipationLevel.UNKNOWN
    assert result.certain is False
    assert result.evidence == ()
    assert result.restrictions == ()
    assert result.convenience is None
    # The note must not claim either openness or a restriction.
    assert "anyone can attend" not in result.note
    assert "limit on who can attend" not in result.note
    assert result.note.strip().endswith(".")


def test_empty_text_is_unknown_rather_than_an_error() -> None:
    result = assess_participation(ParticipationInput())
    assert result.level is ParticipationLevel.UNKNOWN
    assert result.certain is False


def test_restriction_becomes_a_warning() -> None:
    result = _assess("Chapter dinner. Members only.")
    assert result.level is ParticipationLevel.RESTRICTED
    assert result.certain is True
    assert result.restrictions
    assert "members only" in result.warnings[0]


def test_population_restriction_is_detected() -> None:
    result = _assess("Catered lunch for graduate students only.")
    assert result.level is ParticipationLevel.RESTRICTED
    assert result.warnings


def test_conflicting_evidence_resolves_to_restricted_and_uncertain() -> None:
    result = _assess("Open to everyone! Members only after 7pm.")
    assert result.level is ParticipationLevel.RESTRICTED
    assert result.certain is False
    assert "unclear" in result.note


def test_capacity_language_is_reported_without_changing_the_level() -> None:
    result = _assess("Free tacos while supplies last.")
    assert result.level is ParticipationLevel.UNKNOWN
    assert any("supplies last" in note for note in result.capacity_notes)


def test_restrictions_do_not_lower_the_factor_value() -> None:
    restricted = _assess("Members only.")
    unknown = _assess("Refreshments provided.")
    open_event = _assess("Open to the public.")

    assert participation_factor_value(restricted, unknown_value=0.5) == 0.5
    assert participation_factor_value(unknown, unknown_value=0.5) == 0.5
    assert participation_factor_value(open_event, unknown_value=0.5) == 1.0


def test_input_reads_the_full_source_description_not_just_the_summary() -> None:
    event = _event(food_description="Dinner with tacos and rice.")
    record = SourceRecord(
        id="src-1",
        event_id="evt",
        source_id=SourceId.ANCHOR_LINK,
        source_url="https://anchorlink.vanderbilt.edu/event/1",
        raw_payload='{"description": "Dinner. Members only, please."}',
        parsed_fields={"description": "Dinner. Members only, please."},
        parse_status=ParseStatus.OK,
    )
    assessment = assess_participation(participation_input_for(event, [record]))
    assert assessment.level is ParticipationLevel.RESTRICTED
    assert assessment.restrictions


def test_malformed_raw_payload_is_ignored_safely() -> None:
    event = _event()
    record = SourceRecord(
        id="src-1",
        event_id="evt",
        source_id=SourceId.ANCHOR_LINK,
        raw_payload="{not json",
        parsed_fields={},
        parse_status=ParseStatus.OK,
    )
    assessment = assess_participation(participation_input_for(event, [record]))
    assert assessment.level is ParticipationLevel.UNKNOWN


def test_participation_influence_is_capped_at_five_percent() -> None:
    config = Config()
    provider = NullLocationProvider()

    open_event = _event()
    unknown_event = _event()
    scored_open = score_event(
        open_event,
        config=config,
        location_provider=provider,
        participation=_assess("Open to the public."),
    )
    scored_unknown = score_event(
        unknown_event,
        config=config,
        location_provider=provider,
        participation=_assess("Refreshments provided."),
    )

    assert scored_open.event.score_total is not None
    assert scored_unknown.event.score_total is not None
    delta = scored_open.event.score_total - scored_unknown.event.score_total
    # Full open-vs-unknown swing is 0.05 * (1.0 - 0.5) = 0.025.
    assert 0 < delta <= config.ranking.participation_influence

    component = next(
        c for c in scored_open.components if c.factor is ScoreFactor.PARTICIPATION
    )
    assert component.weight == config.ranking.participation_influence


def test_total_score_stays_within_zero_to_one() -> None:
    config = Config()
    scored = score_event(
        _event(),
        config=config,
        location_provider=NullLocationProvider(),
        participation=_assess("Open to the public."),
    )
    assert scored.event.score_total is not None
    assert 0.0 <= scored.event.score_total <= 1.0
    assert sum(c.weight for c in scored.components) <= 1.0 + 1e-9


def test_restricted_and_unknown_events_score_identically() -> None:
    config = Config()
    provider = NullLocationProvider()
    restricted = score_event(
        _event(),
        config=config,
        location_provider=provider,
        participation=_assess("Members only."),
    )
    unknown = score_event(
        _event(),
        config=config,
        location_provider=provider,
        participation=_assess("Refreshments provided."),
    )
    assert restricted.event.score_total == unknown.event.score_total
