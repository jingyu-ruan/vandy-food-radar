"""Calendar-write provider seam (design.md §7, T6.1, FR-39/FR-40).

Defines the :class:`CalendarProvider` interface a user could later use to add a
*selected* event to Google Calendar, plus a no-op :class:`NullCalendarProvider`
default. The MVP ships the interface only: nothing auto-adds discovered events
to a calendar (FR-40). A ``GoogleCalendarWriter`` can implement this later
without touching the pipeline or web layers.

Nothing here performs network I/O.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from ..config import CalendarProviderKind, Config
from ..models import Event


@dataclass
class CalendarWriteResult:
    """Outcome of attempting to add an event to a calendar.

    ``ok`` is ``True`` only when the event was written; ``event_ref`` carries an
    opaque provider-side identifier when available, and ``detail`` explains a
    no-op or failure.
    """

    ok: bool
    event_ref: str | None = None
    detail: str | None = None


class CalendarProvider(Protocol):
    """Adds a single selected event to an external calendar (FR-39).

    Implementations are constructor-injected. The MVP never calls this
    automatically for discovered events (FR-40); it exists so a later
    integration task can wire a real Google Calendar writer behind the same
    boundary.
    """

    def add_event(self, event: Event) -> CalendarWriteResult:
        """Add ``event`` to the calendar and report the result (never raises)."""
        ...


class NullCalendarProvider:
    """Default provider that writes nothing (interface-only MVP, FR-40)."""

    def add_event(self, event: Event) -> CalendarWriteResult:
        """Report that no calendar write was performed."""

        return CalendarWriteResult(
            ok=False,
            detail="calendar integration not configured (interface-only MVP)",
        )


def build_calendar_provider(config: Config) -> CalendarProvider:
    """Return the calendar provider selected by ``config.providers.calendar``.

    Only the no-op provider is available in the MVP; any other selection falls
    back to it so startup stays robust (a real writer is a later task).
    """

    if config.providers.calendar is CalendarProviderKind.NONE:
        return NullCalendarProvider()
    return NullCalendarProvider()


__all__ = [
    "CalendarProvider",
    "CalendarWriteResult",
    "NullCalendarProvider",
    "build_calendar_provider",
]
