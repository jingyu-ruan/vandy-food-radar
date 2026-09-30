"""Tests for the ranking engine + explanation generator (FEAT-006, M6).

Deterministic, transparent weighted-sum scoring: a confirmed dinner with a
specific menu outranks a "refreshments" event and its explanation cites the
full meal / specific menu (AC-3); scores, components, and ordering are identical
across runs (AC-2); changing a weight reorders predictably; and an unknown
walking distance uses the neutral default without zeroing the score or crashing
(AC-8). No network/DB/file I/O beyond loading the offline corpus.
"""

from __future__ import annotations

from datetime import datetime

from vandy_food_radar.config import Config
from vandy_food_radar.dedup import deduplicate
from vandy_food_radar.fixtures import load_json_fixture
from vandy_food_radar.models import (
    Event,
    ParseStatus,
    ScoreFactor,
    SourceId,
    SourceRecord,
    VerificationState,
)
from vandy_food_radar.normalize import normalize
from vandy_food_radar.providers.location import (
    HaversineLocationProvider,
    NullLocationProvider,
)
from vandy_food_radar.ranking import build_explanation, order_events, score_event
from vandy_food_radar.verify import verify

TZ = "America/Chicago"
CFG = Config()


def _source_from_fixture(name: str) -> SourceRecord:
    fixture = load_json_fixture(name)
    return SourceRecord(
        id=f"src-{name}",
        event_id="",
        source_id=SourceId(fixture["source_id"]),
        source_url=fixture.get("source_url"),
        raw_payload=None,
        parsed_fields=dict(fixture.get("parsed_fields") or {}),
        checked_at=_iso(fixture.get("checked_at")),
        parse_status=ParseStatus(fixture.get("parse_status", "ok")),
        source_updated_at=_iso(fixture.get("source_updated_at")),
    )


def _iso(value: object) -> datetime | None:
    if isinstance(value, str) and value:
        return datetime.fromisoformat(value)
    return None


def _verified_event(name: str) -> Event:
    source = _source_from_fixture(name)
    merged = deduplicate([normalize(source, timezone=TZ)], config=CFG.dedup)
    assert len(merged) == 1
    return verify(merged[0], {source.id: source}, config=CFG).event


def test_dinner_with_menu_outranks_refreshments_with_explanation() -> None:
    dinner = _verified_event("dinner_confirmed_menu_anchor_link")
    refreshments = _verified_event("refreshments_only_anchor_link")
    provider = HaversineLocationProvider()

    scored_dinner = score_event(dinner, config=CFG, location_provider=provider)
    scored_refreshments = score_event(
        refreshments, config=CFG, location_provider=provider
    )

    assert scored_dinner.event.score_total is not None
    assert scored_refreshments.event.score_total is not None
    assert scored_dinner.event.score_total > scored_refreshments.event.score_total

    ordered = order_events([scored_refreshments, scored_dinner])
    assert ordered[0].event is scored_dinner.event

    explanation = build_explanation(
        scored_dinner.components,
        verification_state=scored_dinner.event.verification_state,
    )
    assert "full meal" in explanation
    assert "menu" in explanation


def test_scoring_is_deterministic_across_runs() -> None:
    provider = HaversineLocationProvider()
    names = [
        "dinner_confirmed_menu_anchor_link",
        "refreshments_only_anchor_link",
        "calendar_only_event_google_calendar",
    ]

    def run() -> list[tuple[str, float, tuple[tuple[str, float], ...]]]:
        scored = [
            score_event(_verified_event(n), config=CFG, location_provider=provider)
            for n in names
        ]
        ordered = order_events(scored)
        result: list[tuple[str, float, tuple[tuple[str, float], ...]]] = []
        for item in ordered:
            assert item.event.score_total is not None
            comps = tuple((c.factor.value, c.contribution) for c in item.components)
            result.append((item.event.title, item.event.score_total, comps))
        return result

    assert run() == run()


def test_changing_a_weight_reorders_predictably() -> None:
    provider = HaversineLocationProvider()
    dinner = _verified_event("dinner_confirmed_menu_anchor_link")
    refreshments = _verified_event("refreshments_only_anchor_link")

    # Refreshments starts at 16:00 (earlier); dinner at 18:30. With timing
    # dominating everything else, the earlier event should rank first.
    heavy_timing = Config()
    heavy_timing.ranking.weights = {
        ScoreFactor.FOOD_CONFIRMED: 0.0,
        ScoreFactor.FULL_MEAL: 0.0,
        ScoreFactor.FOOD_SPECIFICITY: 0.0,
        ScoreFactor.RSVP_LIKELIHOOD: 0.0,
        ScoreFactor.TIMING: 1.0,
        ScoreFactor.WALKING: 0.0,
        ScoreFactor.CONFIDENCE: 0.0,
    }

    dinner_default = score_event(dinner, config=CFG, location_provider=provider)
    refresh_default = score_event(refreshments, config=CFG, location_provider=provider)
    assert (
        dinner_default.event.score_total is not None
        and refresh_default.event.score_total is not None
    )
    assert dinner_default.event.score_total > refresh_default.event.score_total

    dinner2 = _verified_event("dinner_confirmed_menu_anchor_link")
    refresh2 = _verified_event("refreshments_only_anchor_link")
    dinner_timing = score_event(
        dinner2, config=heavy_timing, location_provider=provider
    )
    refresh_timing = score_event(
        refresh2, config=heavy_timing, location_provider=provider
    )
    assert (
        dinner_timing.event.score_total is not None
        and refresh_timing.event.score_total is not None
    )
    # Both start inside the good window (11..20) -> timing value 1.0 for both,
    # so the deterministic tie-break (earlier start) puts refreshments first.
    ordered = order_events([dinner_timing, refresh_timing])
    assert ordered[0].event.title == refresh2.title


def test_unknown_walking_uses_neutral_default_and_does_not_zero_score() -> None:
    dinner = _verified_event("dinner_confirmed_menu_anchor_link")
    scored = score_event(dinner, config=CFG, location_provider=NullLocationProvider())

    walking = next(c for c in scored.components if c.factor is ScoreFactor.WALKING)
    assert walking.raw_value == CFG.ranking.walking_unknown_value
    assert walking.raw_value != 0.0
    assert walking.contribution > 0.0
    assert scored.event.score_total is not None and scored.event.score_total > 0.0
    assert walking.note is not None and "unavailable" in walking.note


def test_cancelled_event_sorts_last_and_explanation_flags_it() -> None:
    provider = HaversineLocationProvider()
    cancelled = _verified_event("cancelled_event_anchor_link")
    assert cancelled.verification_state is VerificationState.CANCELLED
    dinner = _verified_event("dinner_confirmed_menu_anchor_link")

    scored_cancelled = score_event(cancelled, config=CFG, location_provider=provider)
    scored_dinner = score_event(dinner, config=CFG, location_provider=provider)
    ordered = order_events([scored_cancelled, scored_dinner])
    assert ordered[-1].event.verification_state is VerificationState.CANCELLED

    explanation = build_explanation(
        scored_cancelled.components,
        verification_state=VerificationState.CANCELLED,
    )
    assert "cancelled" in explanation.lower()
