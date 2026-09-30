"""Tests for the live Google Maps walking provider (M9, FR-29/FR-30, AC-8).

Fully offline: every HTTP call goes through a FAKE :class:`MapsHttp` client, so
no live network is touched. Covers a successful Distance Matrix parse, the
in-process memoization by ``(origin, dest)``, the graceful maps->haversine
fallback, the ``unknown`` result for a missing destination (neutral ranking
value, never zero), and the ``build_location_provider`` selection rules.
"""

from __future__ import annotations

from vandy_food_radar.config import Config, LocationProviderKind
from vandy_food_radar.models import GeoPoint
from vandy_food_radar.providers.location import (
    GoogleMapsLocationProvider,
    HaversineLocationProvider,
    WalkingStatus,
    build_location_provider,
    walking_factor_value,
)

_ORIGIN = GeoPoint(lat=36.1487, lng=-86.8027)
_DEST = GeoPoint(lat=36.1400, lng=-86.8050)


class _FakeMapsHttp:
    """Fake :class:`MapsHttp` that returns a canned payload and counts calls."""

    def __init__(self, payload: dict[str, object] | None) -> None:
        self._payload = payload
        self.calls = 0

    def get_json(self, url: str) -> dict[str, object] | None:
        self.calls += 1
        return self._payload


def _ok_payload(distance_m: int, duration_seconds: int) -> dict[str, object]:
    return {
        "status": "OK",
        "rows": [
            {
                "elements": [
                    {
                        "status": "OK",
                        "distance": {"value": distance_m, "text": "1.0 km"},
                        "duration": {"value": duration_seconds, "text": "12 mins"},
                    }
                ]
            }
        ],
    }


def test_successful_response_yields_ok_with_expected_minutes() -> None:
    http = _FakeMapsHttp(_ok_payload(distance_m=900, duration_seconds=725))
    provider = GoogleMapsLocationProvider(api_key="test-key", http=http)

    result = provider.walking(_ORIGIN, _DEST)

    assert result.status is WalkingStatus.OK
    assert result.distance_m == 900.0
    # ceil(725 / 60) == 13.
    assert result.minutes == 13


def test_repeated_call_is_served_from_cache() -> None:
    http = _FakeMapsHttp(_ok_payload(distance_m=900, duration_seconds=725))
    provider = GoogleMapsLocationProvider(api_key="test-key", http=http)

    first = provider.walking(_ORIGIN, _DEST)
    second = provider.walking(_ORIGIN, _DEST)

    assert first == second
    assert http.calls == 1


def test_http_error_falls_back_to_haversine() -> None:
    http = _FakeMapsHttp(None)
    provider = GoogleMapsLocationProvider(
        api_key="test-key",
        http=http,
        fallback=HaversineLocationProvider(),
    )

    result = provider.walking(_ORIGIN, _DEST)

    # Fallback produces a concrete Haversine estimate.
    assert result.status is WalkingStatus.OK
    assert result.distance_m is not None
    assert result.minutes is not None
    assert http.calls == 1


def test_missing_dest_is_unknown_and_uses_neutral_value() -> None:
    http = _FakeMapsHttp(None)
    provider = GoogleMapsLocationProvider(api_key="test-key", http=http)
    config = Config()

    result = provider.walking(_ORIGIN, None)

    assert result.status is WalkingStatus.UNKNOWN
    # No HTTP call is made when the destination is missing.
    assert http.calls == 0
    value = walking_factor_value(
        result, unknown_value=config.ranking.walking_unknown_value
    )
    assert value == 0.5
    assert value != 0


def test_build_location_provider_default_and_google_maps_selection() -> None:
    default_provider = build_location_provider(Config())
    assert isinstance(default_provider, HaversineLocationProvider)

    config = Config()
    config.providers.location = LocationProviderKind.GOOGLE_MAPS
    config.maps.enabled = True
    config.maps.api_key = "test-key"
    maps_provider = build_location_provider(config)
    assert isinstance(maps_provider, GoogleMapsLocationProvider)
