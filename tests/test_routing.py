"""Tests for walking-route validation, estimation, and routed fallbacks.

Three guarantees are under test:

* **Input is rejected, never coerced.** A non-finite, out-of-range, boolean, or
  far-away coordinate produces a :class:`RouteError`; nothing is clamped into a
  plausible-looking campus point.
* **The estimate is labelled, not disguised.** Whenever routing is unavailable,
  refused, or unusable, the answer says it is a straight-line estimate.
* **The key never escapes the server.** It travels only as an ``Authorization``
  header to one fixed endpoint and appears in no response, detail string, or
  request URL.

No network: the HTTP seam is injected.
"""

from __future__ import annotations

import json
import math
from typing import Any

from flask import Flask
from vandy_food_radar.config import Config
from vandy_food_radar.models import GeoPoint
from vandy_food_radar.routing import (
    ORS_DIRECTIONS_URL,
    WALKING_METRES_PER_MINUTE,
    RouteError,
    RouteMode,
    WalkingRouter,
    estimate_route,
    haversine_metres,
    minutes_for_metres,
    parse_coordinate,
    parse_point,
    parse_waypoints,
)
from vandy_food_radar.store import SqliteRepository
from vandy_food_radar.web import create_app

from .support import DEMO_DAY

# Two real campus-scale points roughly 400 m apart.
KIRKLAND = {"lat": 36.1487, "lng": -86.8027}
SARRATT = {"lat": 36.1464554, "lng": -86.8037437}


class _FakeRouteHttp:
    """Records every call and replays a scripted sequence of responses."""

    def __init__(self, responses: list[dict[str, Any] | None]) -> None:
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []
        self.keys: list[str] = []
        self.timeouts: list[float] = []

    def post_json(
        self, body: dict[str, Any], *, api_key: str, timeout: float
    ) -> dict[str, Any] | None:
        self.calls.append(body)
        self.keys.append(api_key)
        self.timeouts.append(timeout)
        if not self._responses:
            return None
        return self._responses.pop(0)


def _geojson(
    total_distance: float, total_duration: float, segments: list[tuple[float, float]]
) -> dict[str, Any]:
    return {
        "features": [
            {
                "properties": {
                    "summary": {
                        "distance": total_distance,
                        "duration": total_duration,
                    },
                    "segments": [
                        {"distance": distance, "duration": duration}
                        for distance, duration in segments
                    ],
                }
            }
        ]
    }


# ---------------------------------------------------------------------------
# coordinate validation
# ---------------------------------------------------------------------------


def test_numeric_strings_are_accepted_but_other_types_are_not() -> None:
    assert parse_coordinate("36.1487", field="lat") == 36.1487
    assert parse_coordinate(" -86.8027 ", field="lng") == -86.8027
    assert parse_coordinate(36, field="lat") == 36.0

    for bad in (None, True, False, "abc", "", [], {}, object()):
        try:
            parse_coordinate(bad, field="lat")
        except RouteError:
            continue
        raise AssertionError(f"{bad!r} should have been rejected")


def test_non_finite_coordinates_are_rejected() -> None:
    for bad in (float("nan"), float("inf"), float("-inf"), "nan", "inf"):
        try:
            parse_coordinate(bad, field="lat")
        except RouteError as exc:
            assert "lat" in str(exc)
            continue
        raise AssertionError(f"{bad!r} should have been rejected")


def test_out_of_range_coordinates_are_rejected() -> None:
    for payload in (
        {"lat": 90.1, "lng": 0.0},
        {"lat": -90.1, "lng": 0.0},
        {"lat": 0.0, "lng": 180.1},
        {"lat": 0.0, "lng": -180.1},
    ):
        try:
            parse_point(payload, index=0)
        except RouteError as exc:
            assert "out of range" in str(exc)
            continue
        raise AssertionError(f"{payload!r} should have been rejected")


def test_waypoint_must_be_an_object() -> None:
    try:
        parse_point([36.1, -86.8], index=2)
    except RouteError as exc:
        assert "waypoint 2" in str(exc)
    else:
        raise AssertionError("a list waypoint should have been rejected")


# ---------------------------------------------------------------------------
# payload validation
# ---------------------------------------------------------------------------


def test_payload_shape_is_validated() -> None:
    config = Config()
    for payload, fragment in (
        ("not-an-object", "JSON object"),
        (None, "JSON object"),
        ({}, "waypoints must be a list"),
        ({"waypoints": "a,b"}, "waypoints must be a list"),
        ({"waypoints": [KIRKLAND]}, "at least two waypoints"),
    ):
        try:
            parse_waypoints(payload, config=config)
        except RouteError as exc:
            assert fragment in str(exc)
            continue
        raise AssertionError(f"{payload!r} should have been rejected")


def test_waypoint_count_is_bounded() -> None:
    config = Config()
    too_many = [dict(KIRKLAND) for _ in range(config.routing.max_waypoints + 1)]
    try:
        parse_waypoints({"waypoints": too_many}, config=config)
    except RouteError as exc:
        assert str(config.routing.max_waypoints) in str(exc)
    else:
        raise AssertionError("an oversized waypoint list should have been rejected")

    allowed = [dict(KIRKLAND) for _ in range(config.routing.max_waypoints)]
    assert len(parse_waypoints({"waypoints": allowed}, config=config)) == (
        config.routing.max_waypoints
    )


def test_points_outside_the_service_radius_are_rejected() -> None:
    config = Config()
    try:
        parse_waypoints(
            {"waypoints": [KIRKLAND, {"lat": 0.0, "lng": 0.0}]}, config=config
        )
    except RouteError as exc:
        assert "service area" in str(exc)
        assert "waypoint 1" in str(exc)
    else:
        raise AssertionError("a point off the far side of the planet was accepted")


def test_campus_points_are_inside_the_service_radius() -> None:
    points = parse_waypoints({"waypoints": [KIRKLAND, SARRATT]}, config=Config())
    assert [round(point.lat, 4) for point in points] == [36.1487, 36.1465]


# ---------------------------------------------------------------------------
# straight-line estimate
# ---------------------------------------------------------------------------


def test_estimate_is_consistent_with_the_documented_pace() -> None:
    origin = GeoPoint(**KIRKLAND)
    dest = GeoPoint(**SARRATT)
    distance = haversine_metres(origin, dest)
    assert 200.0 < distance < 400.0

    result = estimate_route([origin, dest])
    assert result.mode is RouteMode.ESTIMATE
    assert math.isclose(result.distance_m, distance, rel_tol=1e-9)
    assert result.minutes == math.ceil(distance / WALKING_METRES_PER_MINUTE)
    assert "estimate" in result.detail
    assert "at least this long" in result.detail


def test_a_zero_length_leg_still_costs_one_minute() -> None:
    assert minutes_for_metres(0.0) == 1
    point = GeoPoint(**KIRKLAND)
    assert estimate_route([point, point]).minutes == 1


def test_estimate_totals_match_the_sum_of_its_legs() -> None:
    points = [
        GeoPoint(**KIRKLAND),
        GeoPoint(**SARRATT),
        GeoPoint(lat=36.1430, lng=-86.8050),
    ]
    result = estimate_route(points)
    assert len(result.legs) == 2
    assert math.isclose(result.distance_m, sum(leg.distance_m for leg in result.legs))
    assert result.minutes == sum(leg.minutes for leg in result.legs)
    assert all(leg.mode is RouteMode.ESTIMATE for leg in result.legs)


# ---------------------------------------------------------------------------
# router behaviour
# ---------------------------------------------------------------------------


def _points() -> list[GeoPoint]:
    return [
        GeoPoint(**KIRKLAND),
        GeoPoint(**SARRATT),
    ]


def test_no_key_configured_yields_a_labelled_estimate_without_calling_out() -> None:
    http = _FakeRouteHttp([])
    router = WalkingRouter(Config(), http=http)
    assert router.routing_available is False

    result = router.route(_points())
    assert result.mode is RouteMode.ESTIMATE
    assert "not configured" in result.detail
    assert http.calls == []


def test_routed_answer_is_used_when_the_service_responds() -> None:
    config = Config()
    config.routing.api_key = "ors-secret"
    http = _FakeRouteHttp([_geojson(512.0, 420.0, [(512.0, 420.0)])])
    router = WalkingRouter(config, http=http)
    assert router.routing_available is True

    result = router.route(_points())
    assert result.mode is RouteMode.ROUTED
    assert result.distance_m == 512.0
    assert result.minutes == 7  # ceil(420 / 60)
    assert result.legs[0].mode is RouteMode.ROUTED
    assert "OpenRouteService" in result.detail


def test_request_body_uses_lng_lat_order_and_header_only_auth() -> None:
    config = Config()
    config.routing.api_key = "ors-secret"
    config.routing.timeout_seconds = 4.5
    http = _FakeRouteHttp([_geojson(100.0, 90.0, [])])
    WalkingRouter(config, http=http).route(_points())

    assert http.calls[0]["coordinates"] == [
        [KIRKLAND["lng"], KIRKLAND["lat"]],
        [SARRATT["lng"], SARRATT["lat"]],
    ]
    assert http.keys == ["ors-secret"]
    assert http.timeouts == [4.5]
    # The key is passed out-of-band, not embedded in the request body.
    assert "ors-secret" not in json.dumps(http.calls[0])


def test_timeout_or_transport_failure_degrades_to_a_named_estimate() -> None:
    config = Config()
    config.routing.api_key = "ors-secret"
    http = _FakeRouteHttp([None])
    result = WalkingRouter(config, http=http).route(_points())
    assert result.mode is RouteMode.ESTIMATE
    assert "did not answer" in result.detail


def test_unusable_payloads_degrade_to_a_named_estimate() -> None:
    config = Config()
    config.routing.api_key = "ors-secret"
    payloads: list[dict[str, Any]] = [
        {},
        {"features": []},
        {"features": ["nope"]},
        {"features": [{"properties": {}}]},
        {"features": [{"properties": {"summary": {"distance": "x"}}}]},
        {
            "features": [
                {"properties": {"summary": {"distance": float("inf"), "duration": 1.0}}}
            ]
        },
        {
            "features": [
                {
                    "properties": {
                        "summary": {"distance": 10.0, "duration": 10.0},
                        "segments": [{"distance": 10.0}],
                    }
                }
            ]
        },
    ]
    for payload in payloads:
        router = WalkingRouter(config, http=_FakeRouteHttp([payload]))
        result = router.route(_points())
        assert result.mode is RouteMode.ESTIMATE, payload
        assert "unusable" in result.detail


def test_identical_legs_are_served_from_the_cache() -> None:
    config = Config()
    config.routing.api_key = "ors-secret"
    http = _FakeRouteHttp([_geojson(512.0, 420.0, [(512.0, 420.0)])])
    router = WalkingRouter(config, http=http)

    first = router.route(_points())
    second = router.route(_points())
    assert first is second
    assert len(http.calls) == 1


def test_the_cache_is_bounded_and_evicts_the_oldest_entry() -> None:
    config = Config()
    config.routing.api_key = "ors-secret"
    config.routing.cache_entries = 1
    http = _FakeRouteHttp([_geojson(10.0, 60.0, []) for _ in range(4)])
    router = WalkingRouter(config, http=http)

    other = [GeoPoint(**SARRATT), GeoPoint(**KIRKLAND)]
    router.route(_points())
    router.route(other)
    router.route(_points())
    # With room for one entry each call evicts the previous answer.
    assert len(http.calls) == 3


def test_the_only_permitted_endpoint_is_the_fixed_https_ors_url() -> None:
    assert ORS_DIRECTIONS_URL == (
        "https://api.openrouteservice.org/v2/directions/foot-walking/geojson"
    )
    assert ORS_DIRECTIONS_URL.startswith("https://")


def test_serialized_result_exposes_no_secret_or_upstream_url() -> None:
    config = Config()
    config.routing.api_key = "ors-secret"
    http = _FakeRouteHttp([_geojson(512.0, 420.0, [(512.0, 420.0)])])
    payload = json.dumps(WalkingRouter(config, http=http).route(_points()).to_json())
    assert "ors-secret" not in payload
    assert "openrouteservice.org" not in payload
    assert json.loads(payload)["mode"] == "routed"


# ---------------------------------------------------------------------------
# HTTP endpoint
# ---------------------------------------------------------------------------


def _app(config: Config, http: _FakeRouteHttp) -> tuple[Flask, SqliteRepository]:
    repository = SqliteRepository(":memory:")
    app = create_app(
        config,
        repository=repository,
        today_provider=lambda: DEMO_DAY,
        router=WalkingRouter(config, http=http),
    )
    return app, repository


def test_walking_endpoint_rejects_bad_input_with_400() -> None:
    app, repository = _app(Config(), _FakeRouteHttp([]))
    try:
        client = app.test_client()
        response = client.post("/api/walking", json={"waypoints": [KIRKLAND]})
        assert response.status_code == 400
        assert "at least two waypoints" in response.get_json()["error"]

        far = client.post(
            "/api/walking", json={"waypoints": [KIRKLAND, {"lat": 0, "lng": 0}]}
        )
        assert far.status_code == 400

        garbage = client.post(
            "/api/walking", data="not json", content_type="application/json"
        )
        assert garbage.status_code == 400
    finally:
        repository.close()


def test_walking_endpoint_answers_with_a_labelled_estimate_without_a_key() -> None:
    http = _FakeRouteHttp([])
    app, repository = _app(Config(), http)
    try:
        client = app.test_client()
        response = client.post("/api/walking", json={"waypoints": [KIRKLAND, SARRATT]})
        assert response.status_code == 200
        payload = response.get_json()
        assert payload["mode"] == "estimate"
        assert "not configured" in payload["detail"]
        assert payload["minutes"] >= 1
        assert len(payload["legs"]) == 1
        assert http.calls == []
    finally:
        repository.close()


def test_walking_endpoint_never_returns_the_configured_key() -> None:
    config = Config()
    config.routing.api_key = "ors-secret"
    http = _FakeRouteHttp([_geojson(512.0, 420.0, [(512.0, 420.0)])])
    app, repository = _app(config, http)
    try:
        client = app.test_client()
        response = client.post("/api/walking", json={"waypoints": [KIRKLAND, SARRATT]})
        body = response.get_data(as_text=True)
        assert response.status_code == 200
        assert "ors-secret" not in body
        assert response.get_json()["mode"] == "routed"
    finally:
        repository.close()
