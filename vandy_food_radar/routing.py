"""Walking route estimation with an optional OpenRouteService backend.

The itinerary planner needs walking times between campus points. Two answers
are acceptable and the caller is always told which one it got:

* ``routed`` — real pedestrian distance and duration from OpenRouteService.
* ``estimate`` — a straight-line (great-circle) distance converted to minutes
  at a fixed walking pace, clearly labelled as an estimate.

The estimate path is not a silent fallback: it is the documented behavior when
no ``VFR_ORS_API_KEY`` is configured, when the request is refused, or when the
service times out. Because it is a lower bound on real walking distance, the
response says so rather than implying a routed figure.

Hard constraints this module enforces:

* The API key lives only in server configuration. It is sent as an
  ``Authorization`` header to one fixed, hard-coded endpoint — never placed in
  a URL, rendered into HTML, or written to a log line.
* Only that one endpoint is reachable. There is no caller-supplied URL and
  therefore no general-purpose proxy.
* Coordinates must be finite numbers inside valid lat/lng ranges *and* within a
  configured radius of the reference location, and the number of waypoints is
  bounded. A request that fails validation is rejected, not clamped.
* Results are memoized in a bounded in-process cache keyed on rounded
  coordinates, so a repeated leg costs nothing.
"""

from __future__ import annotations

import json
import math
import urllib.error
import urllib.request
from collections import OrderedDict
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol

from .config import Config
from .models import GeoPoint

# The single permitted upstream endpoint. Not configurable by design.
ORS_DIRECTIONS_URL = (
    "https://api.openrouteservice.org/v2/directions/foot-walking/geojson"
)

# Pace used by the straight-line estimate, matching the offline provider.
WALKING_METRES_PER_MINUTE = 80.0
_EARTH_RADIUS_M = 6_371_000.0

# Coordinate rounding for the memo key: ~1 m, enough to collapse repeats.
_CACHE_PRECISION = 5


class RouteMode(StrEnum):
    """How a walking answer was produced."""

    ROUTED = "routed"
    ESTIMATE = "estimate"


class RouteError(ValueError):
    """Raised for an invalid walking request (bad or out-of-range input)."""


@dataclass(frozen=True)
class RouteLeg:
    """One walking leg between two consecutive waypoints."""

    distance_m: float
    minutes: int
    mode: RouteMode


@dataclass(frozen=True)
class RouteResult:
    """A complete walking answer across every requested waypoint."""

    mode: RouteMode
    distance_m: float
    minutes: int
    legs: tuple[RouteLeg, ...]
    detail: str
    geometry: tuple[GeoPoint, ...] = ()

    def to_json(self) -> dict[str, Any]:
        """Serialize for the HTTP API (no secrets, no upstream URLs)."""

        return {
            "mode": self.mode.value,
            "distance_m": round(self.distance_m, 1),
            "minutes": self.minutes,
            "detail": self.detail,
            "geometry": [[point.lat, point.lng] for point in self.geometry],
            "legs": [
                {
                    "distance_m": round(leg.distance_m, 1),
                    "minutes": leg.minutes,
                    "mode": leg.mode.value,
                }
                for leg in self.legs
            ],
        }


class RouteHttp(Protocol):
    """HTTP seam for the one fixed directions call (injected in tests)."""

    def post_json(
        self, body: dict[str, Any], *, api_key: str, timeout: float
    ) -> dict[str, Any] | None:
        """POST ``body`` to the fixed endpoint; return parsed JSON or ``None``."""
        ...


class UrllibRouteHttp:
    """Default :class:`RouteHttp` over :mod:`urllib.request`.

    The key is transmitted as an ``Authorization`` header. Every transport,
    HTTP, timeout, and decode failure returns ``None`` so the caller can fall
    back to the labelled estimate; no exception text that could embed the key
    is propagated.
    """

    def post_json(
        self, body: dict[str, Any], *, api_key: str, timeout: float
    ) -> dict[str, Any] | None:
        """Call the fixed ORS endpoint and return the parsed response."""

        request = urllib.request.Request(
            ORS_DIRECTIONS_URL,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": api_key,
                "Content-Type": "application/json",
                "Accept": "application/geo+json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (
            urllib.error.URLError,
            TimeoutError,
            UnicodeDecodeError,
            ValueError,
            OSError,
        ):
            return None
        return payload if isinstance(payload, dict) else None


def haversine_metres(origin: GeoPoint, dest: GeoPoint) -> float:
    """Great-circle distance between two points, in metres."""

    lat1 = math.radians(origin.lat)
    lat2 = math.radians(dest.lat)
    d_lat = math.radians(dest.lat - origin.lat)
    d_lng = math.radians(dest.lng - origin.lng)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(d_lng / 2) ** 2
    )
    return _EARTH_RADIUS_M * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def minutes_for_metres(distance_m: float) -> int:
    """Convert metres to whole walking minutes (at least one)."""

    return max(1, math.ceil(distance_m / WALKING_METRES_PER_MINUTE))


def parse_coordinate(value: Any, *, field: str) -> float:
    """Parse one coordinate component strictly.

    Accepts a JSON number or a numeric string. Booleans, ``NaN``, and infinities
    are rejected, because a silently coerced coordinate is how fake geography
    gets into a map.
    """

    if isinstance(value, bool):
        raise RouteError(f"{field} must be a number")
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError as exc:
            raise RouteError(f"{field} must be a number") from exc
    else:
        raise RouteError(f"{field} must be a number")
    if not math.isfinite(number):
        raise RouteError(f"{field} must be a finite number")
    return number


def parse_point(value: Any, *, index: int) -> GeoPoint:
    """Parse one ``{"lat":..,"lng":..}`` waypoint with range validation."""

    if not isinstance(value, dict):
        raise RouteError(f"waypoint {index} must be an object with lat and lng")
    lat = parse_coordinate(value.get("lat"), field=f"waypoint {index} lat")
    lng = parse_coordinate(value.get("lng"), field=f"waypoint {index} lng")
    if not -90.0 <= lat <= 90.0:
        raise RouteError(f"waypoint {index} lat is out of range")
    if not -180.0 <= lng <= 180.0:
        raise RouteError(f"waypoint {index} lng is out of range")
    return GeoPoint(lat=lat, lng=lng)


def parse_waypoints(payload: Any, *, config: Config) -> list[GeoPoint]:
    """Validate the request payload into a bounded list of waypoints.

    Requires at least two waypoints, at most
    ``config.routing.max_waypoints``, each within
    ``config.routing.max_radius_km`` of the configured reference location. The
    radius check keeps the endpoint a campus walking tool rather than a free
    worldwide routing proxy.
    """

    if not isinstance(payload, dict):
        raise RouteError("request body must be a JSON object")
    raw = payload.get("waypoints")
    if not isinstance(raw, list):
        raise RouteError("waypoints must be a list")
    if len(raw) < 2:
        raise RouteError("at least two waypoints are required")
    if len(raw) > config.routing.max_waypoints:
        raise RouteError(
            f"at most {config.routing.max_waypoints} waypoints are supported"
        )

    reference = GeoPoint(
        lat=config.reference_location.lat, lng=config.reference_location.lng
    )
    limit_m = config.routing.max_radius_km * 1000.0
    points: list[GeoPoint] = []
    for index, item in enumerate(raw):
        point = parse_point(item, index=index)
        if haversine_metres(reference, point) > limit_m:
            raise RouteError(
                f"waypoint {index} is outside the supported "
                f"{config.routing.max_radius_km:g} km service area"
            )
        points.append(point)
    return points


def _cache_key(points: list[GeoPoint]) -> tuple[tuple[float, float], ...]:
    return tuple(
        (round(point.lat, _CACHE_PRECISION), round(point.lng, _CACHE_PRECISION))
        for point in points
    )


def estimate_route(points: list[GeoPoint]) -> RouteResult:
    """Return the straight-line walking estimate for ``points``.

    Explicitly labelled: a great-circle path ignores buildings and closed
    walkways, so the real walk is at least this long.
    """

    legs: list[RouteLeg] = []
    for first, second in zip(points, points[1:], strict=False):
        distance = haversine_metres(first, second)
        legs.append(
            RouteLeg(
                distance_m=distance,
                minutes=minutes_for_metres(distance),
                mode=RouteMode.ESTIMATE,
            )
        )
    total_distance = sum(leg.distance_m for leg in legs)
    return RouteResult(
        mode=RouteMode.ESTIMATE,
        distance_m=total_distance,
        minutes=sum(leg.minutes for leg in legs),
        legs=tuple(legs),
        detail=(
            "Straight-line estimate at a steady walking pace; the real route "
            "will be at least this long."
        ),
    )


def _parse_ors_geojson(payload: dict[str, Any]) -> RouteResult | None:
    """Extract total/leg distances from an ORS GeoJSON directions response."""

    features = payload.get("features")
    if not isinstance(features, list) or not features:
        return None
    first = features[0]
    if not isinstance(first, dict):
        return None
    properties = first.get("properties")
    if not isinstance(properties, dict):
        return None
    summary = properties.get("summary")
    if not isinstance(summary, dict):
        return None
    try:
        total_distance = float(summary["distance"])
        total_duration = float(summary["duration"])
    except (KeyError, TypeError, ValueError):
        return None
    if (
        not math.isfinite(total_distance)
        or not math.isfinite(total_duration)
        or total_distance < 0
        or total_duration < 0
    ):
        return None

    legs: list[RouteLeg] = []
    segments = properties.get("segments")
    if isinstance(segments, list):
        for segment in segments:
            if not isinstance(segment, dict):
                return None
            try:
                distance = float(segment["distance"])
                duration = float(segment["duration"])
            except (KeyError, TypeError, ValueError):
                return None
            if (
                not math.isfinite(distance)
                or not math.isfinite(duration)
                or distance < 0
                or duration < 0
            ):
                return None
            legs.append(
                RouteLeg(
                    distance_m=distance,
                    minutes=max(1, math.ceil(duration / 60)),
                    mode=RouteMode.ROUTED,
                )
            )
    geometry: list[GeoPoint] = []
    shape = first.get("geometry")
    if isinstance(shape, dict) and shape.get("type") == "LineString":
        coordinates = shape.get("coordinates")
        if isinstance(coordinates, list) and len(coordinates) <= 20000:
            for pair in coordinates:
                if not isinstance(pair, list) or len(pair) < 2:
                    geometry = []
                    break
                try:
                    geometry.append(
                        parse_point({"lng": pair[0], "lat": pair[1]}, index=0)
                    )
                except RouteError:
                    geometry = []
                    break
    return RouteResult(
        mode=RouteMode.ROUTED,
        distance_m=total_distance,
        minutes=max(1, math.ceil(total_duration / 60)),
        legs=tuple(legs),
        detail="Pedestrian route from OpenRouteService.",
        geometry=tuple(geometry),
    )


class WalkingRouter:
    """Resolves walking routes, caching results and degrading to estimates."""

    def __init__(self, config: Config, *, http: RouteHttp | None = None) -> None:
        self._config = config
        self._http = http if http is not None else UrllibRouteHttp()
        self._cache: OrderedDict[tuple[tuple[float, float], ...], RouteResult] = (
            OrderedDict()
        )

    @property
    def routing_available(self) -> bool:
        """Whether a routing key is configured (never exposes the key)."""

        return self._config.routing.enabled

    def route(self, points: list[GeoPoint]) -> RouteResult:
        """Return the best available walking answer for ``points``."""

        key = _cache_key(points)
        cached = self._cache.get(key)
        if cached is not None:
            self._cache.move_to_end(key)
            return cached

        result = self._resolve(points)
        self._cache[key] = result
        while len(self._cache) > max(1, self._config.routing.cache_entries):
            self._cache.popitem(last=False)
        return result

    def _resolve(self, points: list[GeoPoint]) -> RouteResult:
        routing = self._config.routing
        if not routing.enabled:
            fallback = estimate_route(points)
            return RouteResult(
                mode=fallback.mode,
                distance_m=fallback.distance_m,
                minutes=fallback.minutes,
                legs=fallback.legs,
                detail=(
                    "Walking routing is not configured, so this is a "
                    "straight-line estimate."
                ),
            )
        body = {
            # ORS takes [lng, lat] pairs.
            "coordinates": [[point.lng, point.lat] for point in points],
            "instructions": False,
            "units": "m",
        }
        payload = self._http.post_json(
            body, api_key=routing.api_key, timeout=routing.timeout_seconds
        )
        if payload is None:
            fallback = estimate_route(points)
            return RouteResult(
                mode=fallback.mode,
                distance_m=fallback.distance_m,
                minutes=fallback.minutes,
                legs=fallback.legs,
                detail=(
                    "The routing service did not answer, so this is a "
                    "straight-line estimate."
                ),
            )
        parsed = _parse_ors_geojson(payload)
        if parsed is None:
            fallback = estimate_route(points)
            return RouteResult(
                mode=fallback.mode,
                distance_m=fallback.distance_m,
                minutes=fallback.minutes,
                legs=fallback.legs,
                detail=(
                    "The routing service returned an unusable response, so "
                    "this is a straight-line estimate."
                ),
            )
        return parsed


__all__ = [
    "ORS_DIRECTIONS_URL",
    "WALKING_METRES_PER_MINUTE",
    "RouteError",
    "RouteHttp",
    "RouteLeg",
    "RouteMode",
    "RouteResult",
    "UrllibRouteHttp",
    "WalkingRouter",
    "estimate_route",
    "haversine_metres",
    "minutes_for_metres",
    "parse_coordinate",
    "parse_point",
    "parse_waypoints",
]
