"""External-service providers for Vandy Food Radar (design.md §7, T6.1).

Exposes the walking-distance seam (:class:`LocationProvider` with the
:class:`HaversineLocationProvider` and :class:`NullLocationProvider`
implementations plus the :class:`WalkingResult` value) and the calendar-write
seam (:class:`CalendarProvider` with the no-op :class:`NullCalendarProvider`).
Both are constructor-injected so a real maps/calendar API can be added later
without touching the ranking or pipeline logic (FR-28–FR-30, FR-39/FR-40).
"""

from __future__ import annotations

from .calendar import (
    CalendarProvider,
    CalendarWriteResult,
    NullCalendarProvider,
    build_calendar_provider,
)
from .location import (
    HaversineLocationProvider,
    LocationProvider,
    NullLocationProvider,
    WalkingResult,
    WalkingStatus,
    build_location_provider,
)

__all__ = [
    "CalendarProvider",
    "CalendarWriteResult",
    "HaversineLocationProvider",
    "LocationProvider",
    "NullCalendarProvider",
    "NullLocationProvider",
    "WalkingResult",
    "WalkingStatus",
    "build_calendar_provider",
    "build_location_provider",
]
