"""Tests for the config module (CFG-1..CFG-8).

All assertions are offline; env overrides are passed explicitly so no real
environment or network access is required.
"""

from __future__ import annotations

import math

from vandy_food_radar.config import (
    CalendarProviderKind,
    Config,
    LocationProviderKind,
    TargetWindow,
    default_config,
)
from vandy_food_radar.models import ScoreFactor, SourceId


def test_defaults_run_offline_out_of_the_box() -> None:
    cfg = default_config()
    # CFG-1 timezone default.
    assert cfg.timezone == "America/Chicago"
    # CFG-2: the product opens on the current local day.
    assert cfg.target_window is TargetWindow.TODAY
    # Offline by default (no network in MVP / tests).
    assert cfg.offline is True


def test_reference_location_is_configurable_not_hardcoded() -> None:
    # CFG-3 / FR-28: reference location has a label and coordinates and can be
    # overridden.
    cfg = Config.from_env(
        {
            "VFR_REF_LABEL": "Commons Center",
            "VFR_REF_LAT": "36.1400",
            "VFR_REF_LNG": "-86.8050",
        }
    )
    assert cfg.reference_location.label == "Commons Center"
    assert math.isclose(cfg.reference_location.lat, 36.1400)
    assert math.isclose(cfg.reference_location.lng, -86.8050)


def test_source_flags_and_placeholders() -> None:
    # CFG-4: source enable flags + credential/URL placeholders.
    cfg = default_config()
    assert cfg.sources.anchor_link.enabled is True
    assert cfg.sources.anchor_link.free_food_query
    assert cfg.sources.google_calendar.calendar_id == ""
    assert cfg.sources.google_calendar.api_key == ""


def test_authority_precedence_default_order() -> None:
    # CFG-5 / FR-19: official page > anchor link > google calendar.
    cfg = default_config()
    assert cfg.authority_precedence == [
        SourceId.OFFICIAL_PAGE,
        SourceId.ANCHOR_LINK,
        SourceId.GOOGLE_CALENDAR,
    ]


def test_ranking_weights_match_design_and_sum_to_one() -> None:
    # CFG-6 / design.md §6.1: exact default weights, summing to 1.0.
    cfg = default_config()
    weights = cfg.ranking.weights
    assert weights[ScoreFactor.FOOD_CONFIRMED] == 0.25
    assert weights[ScoreFactor.FULL_MEAL] == 0.25
    assert weights[ScoreFactor.FOOD_SPECIFICITY] == 0.15
    assert weights[ScoreFactor.RSVP_LIKELIHOOD] == 0.10
    assert weights[ScoreFactor.TIMING] == 0.05
    assert weights[ScoreFactor.WALKING] == 0.10
    assert weights[ScoreFactor.CONFIDENCE] == 0.10
    assert math.isclose(sum(weights.values()), 1.0)


def test_dedup_thresholds_present_and_ordered() -> None:
    # CFG-7: MERGE_THRESHOLD and REVIEW_LOW.
    cfg = default_config()
    assert 0.0 <= cfg.dedup.review_low < cfg.dedup.merge_threshold <= 1.0


def test_provider_defaults() -> None:
    # CFG-8: haversine location provider, disabled calendar provider.
    cfg = default_config()
    assert cfg.providers.location is LocationProviderKind.HAVERSINE
    assert cfg.providers.calendar is CalendarProviderKind.NONE


def test_env_overrides_and_invalid_values_fall_back() -> None:
    cfg = Config.from_env(
        {
            "VFR_OFFLINE": "false",
            "VFR_TIMEZONE": "America/New_York",
            "VFR_TARGET_WINDOW": "next_day",
            "VFR_LOCATION_PROVIDER": "null",
            "VFR_CALENDAR_PROVIDER": "google",
        }
    )
    assert cfg.offline is False
    assert cfg.timezone == "America/New_York"
    assert cfg.target_window is TargetWindow.NEXT_DAY
    assert cfg.providers.location is LocationProviderKind.NULL
    assert cfg.providers.calendar is CalendarProviderKind.GOOGLE

    # Invalid enum/number values fall back to defaults rather than raising.
    bad = Config.from_env(
        {"VFR_TARGET_WINDOW": "nonsense", "VFR_REF_LAT": "not-a-number"}
    )
    assert bad.target_window is TargetWindow.TODAY
    assert math.isclose(
        bad.reference_location.lat, default_config().reference_location.lat
    )


def test_participation_influence_is_small_and_capped() -> None:
    cfg = default_config()
    # At most a 5% convenience nudge, so the food-centric factors still decide.
    assert cfg.ranking.participation_influence == 0.05
    assert cfg.ranking.participation_unknown_value == 0.5


def test_routing_is_disabled_without_a_key_and_bounded_when_enabled() -> None:
    cfg = default_config()
    assert cfg.routing.api_key == ""
    assert cfg.routing.enabled is False
    assert cfg.routing.max_waypoints >= 2
    assert cfg.routing.timeout_seconds > 0

    configured = Config.from_env(
        {"VFR_ORS_API_KEY": "  test-key  ", "VFR_ORS_TIMEOUT_SECONDS": "3"}
    )
    assert configured.routing.api_key == "test-key"
    assert configured.routing.enabled is True
    assert math.isclose(configured.routing.timeout_seconds, 3.0)

    # Out-of-range timeouts clamp instead of disabling routing.
    clamped = Config.from_env(
        {"VFR_ORS_API_KEY": "k", "VFR_ORS_TIMEOUT_SECONDS": "900"}
    )
    assert clamped.routing.timeout_seconds == 30.0


def test_retention_and_itinerary_defaults_are_overridable() -> None:
    cfg = default_config()
    assert cfg.retention.past_days >= 0
    assert cfg.retention.future_days >= 6  # at least a full browsable week
    assert cfg.itinerary.default_dwell_minutes > 0

    overridden = Config.from_env(
        {
            "VFR_RETENTION_PAST_DAYS": "2",
            "VFR_RETENTION_FUTURE_DAYS": "9",
            "VFR_ITINERARY_DWELL_MINUTES": "45",
            "VFR_CAMPUS_PLACES_PATH": "/tmp/places.json",
        }
    )
    assert overridden.retention.past_days == 2
    assert overridden.retention.future_days == 9
    assert overridden.itinerary.default_dwell_minutes == 45
    assert overridden.places.path == "/tmp/places.json"
