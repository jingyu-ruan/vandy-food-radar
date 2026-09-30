"""Walking-distance providers (design.md §7, T6.1, FR-28–FR-30, AC-7/AC-8).

Defines the :class:`LocationProvider` seam that the ranker consults for the
walking convenience factor, plus two concrete implementations:

* :class:`HaversineLocationProvider` — a great-circle straight-line distance
  from the configured reference location, converted to a coarse walking-minute
  estimate. Offline and deterministic; no maps API required.
* :class:`NullLocationProvider` — always reports ``unknown`` so environments
  without any geocoding still run.

Walking is a *seam*: a ``GoogleMapsLocationProvider`` can be added later without
touching the ranking engine. When the walking status is ``unknown`` the ranker
must substitute ``config.ranking.walking_unknown_value`` so an unknown walk
never zeroes the score (FR-30, AC-8).

Nothing here performs network I/O.
"""

from __future__ import annotations

import math
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
    "HaversineLocationProvider",
    "LocationProvider",
    "NullLocationProvider",
    "WalkingResult",
    "WalkingStatus",
    "build_location_provider",
    "walking_factor_value",
]
