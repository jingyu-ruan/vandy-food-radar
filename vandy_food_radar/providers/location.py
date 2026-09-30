"""Walking-distance providers (design.md §7, T6.1, FR-28–FR-30, AC-7/AC-8).

Defines the :class:`LocationProvider` seam that the ranker consults for the
walking convenience factor, plus two concrete implementations:

* :class:`HaversineLocationProvider` — a great-circle straight-line distance
  from the configured reference location, converted to a coarse walking-minute
  estimate. Offline and deterministic; no maps API required.
* :class:`NullLocationProvider` — always reports ``unknown`` so environments
  without any geocoding still run.

* :class:`GoogleMapsLocationProvider` — a live estimator backed by the Google
  Distance Matrix API (walking mode). It talks HTTP through the injected
  :class:`MapsHttp` seam (stdlib ``urllib.request`` by default), memoizes
  results in-process by ``(origin, dest)``, and falls back gracefully to
  Haversine (then ``unknown``) on any failure so it never raises.

Walking is a *seam*: the provider is chosen by ``build_location_provider`` and
the default stays Haversine. When the walking status is ``unknown`` the ranker
must substitute ``config.ranking.walking_unknown_value`` so an unknown walk
never zeroes the score (FR-30, AC-8).

Only :class:`GoogleMapsLocationProvider` (via its injected HTTP client) performs
network I/O; the Haversine and Null providers stay offline.
"""

from __future__ import annotations

import json
import math
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

from ..config import Config, LocationProviderKind
from ..models import GeoPoint

# Average campus walking speed used to turn metres into a coarse minute estimate.
_WALKING_METRES_PER_MINUTE = 80.0

# Earth mean radius in metres, for the Haversine formula.
_EARTH_RADIUS_M = 6_371_000.0

# Straight-line distance (metres) treated as maximally convenient (score 1.0);
# distances at/above ``_FAR_METRES`` score 0.0, with a linear ramp between.
_NEAR_METRES = 100.0
_FAR_METRES = 1600.0

# Google Distance Matrix endpoint and request timeout for the live provider.
_MAPS_DISTANCE_MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json"
_MAPS_HTTP_TIMEOUT_SECONDS = 5.0
# Decimals used when rounding coordinates for the in-process memo key.
_MAPS_CACHE_PRECISION = 5


class WalkingStatus(StrEnum):
    """Whether a walking estimate could be produced (FR-30)."""

    OK = "ok"
    UNKNOWN = "unknown"


@dataclass
class WalkingResult:
    """A walking estimate from a reference location to an event.

    ``distance_m`` / ``minutes`` are populated only when ``status`` is ``ok``;
    an ``unknown`` result carries neither so the ranker falls back to the
    configured neutral value rather than a fabricated zero (FR-30, AC-8).
    """

    status: WalkingStatus
    distance_m: float | None = None
    minutes: int | None = None


class LocationProvider(Protocol):
    """Estimates walking distance/time from an origin to an event (FR-28/29).

    Implementations are constructor-injected so the Haversine estimator can be
    swapped for a live maps provider without changing the ranker.
    """

    def walking(self, origin: GeoPoint, dest: GeoPoint | None) -> WalkingResult:
        """Return a :class:`WalkingResult` from ``origin`` to ``dest``.

        A missing ``dest`` (event location not geocoded) yields an ``unknown``
        result rather than raising.
        """
        ...


class HaversineLocationProvider:
    """Great-circle distance estimator from the configured reference point.

    Computes the straight-line distance between two coordinates and converts it
    to a coarse walking-minute estimate at :data:`_WALKING_METRES_PER_MINUTE`.
    Deterministic and offline; a good default until a real routing API is wired.
    """

    def walking(self, origin: GeoPoint, dest: GeoPoint | None) -> WalkingResult:
        """Estimate walking distance/time, or ``unknown`` when ``dest`` is absent."""

        if dest is None:
            return WalkingResult(status=WalkingStatus.UNKNOWN)
        distance_m = _haversine_metres(origin, dest)
        minutes = max(1, math.ceil(distance_m / _WALKING_METRES_PER_MINUTE))
        return WalkingResult(
            status=WalkingStatus.OK,
            distance_m=round(distance_m, 1),
            minutes=minutes,
        )


class NullLocationProvider:
    """Provider that never knows a walking distance (always ``unknown``).

    Useful when no geocoding is available; the ranker then applies the neutral
    walking default so the score is unaffected (FR-30, AC-8).
    """

    def walking(self, origin: GeoPoint, dest: GeoPoint | None) -> WalkingResult:
        """Always return an ``unknown`` walking result."""

        return WalkingResult(status=WalkingStatus.UNKNOWN)


class MapsHttp(Protocol):
    """Minimal HTTP seam for the live maps provider (injectable/testable).

    Implementations fetch ``url`` and return the parsed JSON object, or ``None``
    on any transport/parse failure. They never raise, so the provider can fall
    back gracefully.
    """

    def get_json(self, url: str) -> dict[str, object] | None:
        """GET ``url`` and return the parsed JSON dict, or ``None`` on failure."""
        ...


class _UrllibMapsHttp:
    """Default :class:`MapsHttp` backed by stdlib ``urllib.request``.

    Uses a short timeout and returns ``None`` (never raises) on any
    URL/HTTP/timeout/JSON error so the provider degrades gracefully.
    """

    def get_json(self, url: str) -> dict[str, object] | None:
        """Fetch ``url`` and parse the JSON body, or return ``None`` on error."""

        try:
            with urllib.request.urlopen(
                url, timeout=_MAPS_HTTP_TIMEOUT_SECONDS
            ) as response:
                payload = response.read()
            parsed = json.loads(payload)
        except (urllib.error.URLError, TimeoutError, ValueError, OSError):
            return None
        if isinstance(parsed, dict):
            return parsed
        return None


class GoogleMapsLocationProvider:
    """Live walking estimator backed by the Google Distance Matrix API.

    Talks HTTP through the injected :class:`MapsHttp` seam (stdlib
    ``urllib.request`` by default), memoizes results in-process keyed on the
    rounded ``(origin, dest)`` coordinates so a repeated identical query does
    not re-invoke the HTTP client, and falls back to ``fallback`` (Haversine by
    default) on any missing key / HTTP ``None`` / non-``OK`` status / parse
    failure. A missing ``dest`` yields ``unknown`` (FR-30, AC-8). Never raises.
    """

    def __init__(
        self,
        api_key: str,
        *,
        http: MapsHttp | None = None,
        fallback: LocationProvider | None = None,
    ) -> None:
        self._api_key = api_key
        self._http = http if http is not None else _UrllibMapsHttp()
        self._fallback = (
            fallback if fallback is not None else HaversineLocationProvider()
        )
        self._cache: dict[tuple[float, float, float, float], WalkingResult] = {}

    def walking(self, origin: GeoPoint, dest: GeoPoint | None) -> WalkingResult:
        """Return a live walking estimate, or a graceful fallback/unknown."""

        if dest is None:
            return WalkingResult(status=WalkingStatus.UNKNOWN)

        key = (
            round(origin.lat, _MAPS_CACHE_PRECISION),
            round(origin.lng, _MAPS_CACHE_PRECISION),
            round(dest.lat, _MAPS_CACHE_PRECISION),
            round(dest.lng, _MAPS_CACHE_PRECISION),
        )
        cached = self._cache.get(key)
        if cached is not None:
            return cached

        result = self._resolve(origin, dest)
        self._cache[key] = result
        return result

    def _resolve(self, origin: GeoPoint, dest: GeoPoint) -> WalkingResult:
        """Query the API for ``origin``->``dest``, falling back on any failure."""

        if not self._api_key:
            return self._fallback.walking(origin, dest)
        url = self._build_url(origin, dest)
        payload = self._http.get_json(url)
        parsed = _parse_distance_matrix(payload)
        if parsed is None:
            return self._fallback.walking(origin, dest)
        distance_m, duration_seconds = parsed
        minutes = max(1, math.ceil(duration_seconds / 60))
        return WalkingResult(
            status=WalkingStatus.OK,
            distance_m=round(distance_m, 1),
            minutes=minutes,
        )

    def _build_url(self, origin: GeoPoint, dest: GeoPoint) -> str:
        """Build the Distance Matrix walking-mode request URL."""

        params = urllib.parse.urlencode(
            {
                "origins": f"{origin.lat},{origin.lng}",
                "destinations": f"{dest.lat},{dest.lng}",
                "mode": "walking",
                "key": self._api_key,
            }
        )
        return f"{_MAPS_DISTANCE_MATRIX_URL}?{params}"


def _parse_distance_matrix(
    payload: dict[str, object] | None,
) -> tuple[float, float] | None:
    """Return ``(distance_m, duration_seconds)`` from an OK response, else None.

    Any missing key / non-``OK`` status / malformed element yields ``None`` so
    the caller falls back gracefully.
    """

    if not isinstance(payload, dict) or payload.get("status") != "OK":
        return None
    try:
        rows = payload["rows"]
        element = rows[0]["elements"][0]  # type: ignore[index]
        if element.get("status") != "OK":
            return None
        distance_m = float(element["distance"]["value"])
        duration_seconds = float(element["duration"]["value"])
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    return distance_m, duration_seconds


def walking_factor_value(result: WalkingResult, *, unknown_value: float) -> float:
    """Map a :class:`WalkingResult` to the ranking factor value in ``[0, 1]``.

    Closer walks score higher; an ``unknown`` result uses ``unknown_value``
    (``config.ranking.walking_unknown_value``) so it never zeroes the score
    (FR-30, AC-8). Between :data:`_NEAR_METRES` and :data:`_FAR_METRES` the
    value ramps down linearly.
    """

    if result.status is not WalkingStatus.OK or result.distance_m is None:
        return unknown_value
    distance = result.distance_m
    if distance <= _NEAR_METRES:
        return 1.0
    if distance >= _FAR_METRES:
        return 0.0
    span = _FAR_METRES - _NEAR_METRES
    return round(1.0 - (distance - _NEAR_METRES) / span, 4)


def build_location_provider(config: Config) -> LocationProvider:
    """Return the location provider selected by ``config.providers.location``."""

    if config.providers.location is LocationProviderKind.NULL:
        return NullLocationProvider()
    if (
        config.providers.location is LocationProviderKind.GOOGLE_MAPS
        and config.maps.enabled
        and config.maps.api_key
    ):
        return GoogleMapsLocationProvider(
            api_key=config.maps.api_key,
            fallback=HaversineLocationProvider(),
        )
    return HaversineLocationProvider()


def _haversine_metres(origin: GeoPoint, dest: GeoPoint) -> float:
    """Great-circle distance between two lat/lng points, in metres."""

    lat1 = math.radians(origin.lat)
    lat2 = math.radians(dest.lat)
    d_lat = math.radians(dest.lat - origin.lat)
    d_lng = math.radians(dest.lng - origin.lng)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(d_lng / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return _EARTH_RADIUS_M * c


__all__ = [
    "GoogleMapsLocationProvider",
    "HaversineLocationProvider",
    "LocationProvider",
    "MapsHttp",
    "NullLocationProvider",
    "WalkingResult",
    "WalkingStatus",
    "build_location_provider",
    "walking_factor_value",
]
