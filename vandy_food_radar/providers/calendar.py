"""Calendar-write provider seam (design.md §7, T6.1/T8.1-3, FR-39/FR-40).

Defines the :class:`CalendarProvider` interface used to add a *selected* event
to Google Calendar, a no-op :class:`NullCalendarProvider` default, and a real
:class:`GoogleCalendarWriter`. Nothing auto-adds discovered events to a
calendar (FR-40): a write happens only for an explicitly selected event.

Idempotency (FR-40) comes from a deterministic ``iCalUID`` derived from
``Event.identity_key`` so repeating an add updates the same calendar entry
instead of creating a duplicate. ``add_event`` never raises: failures are
reported through :class:`CalendarWriteResult`.

The Google client libraries are imported LAZILY inside the builder so importing
this module stays offline-clean (they are never required at import time).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol
from zoneinfo import ZoneInfo

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

    Implementations are constructor-injected. This is never called
    automatically for discovered events (FR-40); it is invoked only for an
    explicitly selected event.
    """

    def add_event(self, event: Event) -> CalendarWriteResult:
        """Add ``event`` to the calendar and report the result (never raises)."""
        ...


class NullCalendarProvider:
    """Default provider that writes nothing (calendar not configured, FR-40)."""

    def add_event(self, event: Event) -> CalendarWriteResult:
        """Report that no calendar write was performed."""

        return CalendarWriteResult(
            ok=False,
            detail="Calendar not configured",
        )


def _ical_uid(event: Event) -> str:
    """Return the deterministic iCalUID for ``event`` (idempotent, FR-40)."""

    return f"vfr-{event.identity_key}"


class GoogleCalendarWriter:
    """Adds a selected event to Google Calendar (FR-39/FR-40).

    The Google Calendar API ``service`` client is injected (built lazily by
    :func:`build_calendar_provider`) so this class carries no import-time
    dependency on the Google libraries and stays trivially testable with a
    fake service. Idempotency comes from a stable ``iCalUID`` derived from the
    event's ``identity_key``; a repeat add reuses the same UID so the calendar
    entry is updated rather than duplicated (FR-40).
    """

    def __init__(self, *, service: Any, calendar_id: str, timezone: str) -> None:
        self._service = service
        self._calendar_id = calendar_id
        self._timezone = timezone

    def add_event(self, event: Event) -> CalendarWriteResult:
        """Import ``event`` into the calendar; never raises (errors -> ok=False)."""

        body = self._build_body(event)
        try:
            created = (
                self._service.events()
                .import_(calendarId=self._calendar_id, body=body)
                .execute()
            )
        except Exception as err:  # noqa: BLE001 - never propagate write errors
            return CalendarWriteResult(ok=False, detail=str(err))
        event_ref = created.get("id") if isinstance(created, dict) else None
        return CalendarWriteResult(ok=True, event_ref=event_ref)

    def _build_body(self, event: Event) -> dict[str, Any]:
        """Assemble the Google Calendar event body for ``event``."""

        tz = ZoneInfo(self._timezone)
        body: dict[str, Any] = {
            "summary": event.title,
            "iCalUID": _ical_uid(event),
        }

        if event.start_time is not None:
            start_dt = datetime.combine(event.event_date, event.start_time, tzinfo=tz)
            end_time = event.end_time or event.start_time
            end_dt = datetime.combine(event.event_date, end_time, tzinfo=tz)
            body["start"] = {
                "dateTime": start_dt.isoformat(),
                "timeZone": self._timezone,
            }
            body["end"] = {
                "dateTime": end_dt.isoformat(),
                "timeZone": self._timezone,
            }
        else:
            # No start time: fall back to an all-day entry for the event date.
            body["start"] = {"date": event.event_date.isoformat()}
            body["end"] = {"date": event.event_date.isoformat()}

        if event.location:
            body["location"] = event.location

        description = _compose_description(event)
        if description:
            body["description"] = description

        return body


def _compose_description(event: Event) -> str:
    """Compose the calendar description from the food summary and a link."""

    parts: list[str] = []
    if event.food_description:
        parts.append(event.food_description)
    url = event.event_url or event.rsvp_url
    if url:
        parts.append(url)
    return "\n\n".join(parts)


def build_calendar_provider(config: Config) -> CalendarProvider:
    """Return the calendar provider selected by config (M8, FR-39/FR-40).

    A real :class:`GoogleCalendarWriter` is built only when the calendar
    provider is ``GOOGLE`` AND writes are enabled AND service-account
    credentials are present; otherwise the no-op :class:`NullCalendarProvider`
    is returned so startup stays robust and offline. The Google libraries are
    imported lazily here so module import never requires them.
    """

    write = config.calendar_write
    if (
        config.providers.calendar is CalendarProviderKind.GOOGLE
        and write.enabled
        and write.credentials_json
    ):
        service = _build_google_service(write.credentials_json)
        return GoogleCalendarWriter(
            service=service,
            calendar_id=write.calendar_id,
            timezone=config.timezone,
        )
    return NullCalendarProvider()


def _build_google_service(credentials_json: str) -> Any:
    """Build a Google Calendar API client from service-account JSON (lazy).

    The Google libraries are imported inside this function so importing the
    module stays offline-clean and no test needs them at collection time.
    """

    import json

    from google.oauth2 import service_account
    from googleapiclient.discovery import build  # type: ignore[import-untyped]

    info = json.loads(credentials_json)
    credentials = service_account.Credentials.from_service_account_info(
        info,
        scopes=["https://www.googleapis.com/auth/calendar"],
    )  # type: ignore[no-untyped-call]
    return build("calendar", "v3", credentials=credentials, cache_discovery=False)


__all__ = [
    "CalendarProvider",
    "CalendarWriteResult",
    "GoogleCalendarWriter",
    "NullCalendarProvider",
    "build_calendar_provider",
]
