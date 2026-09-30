"""Tests for the Google Calendar write provider (FEAT-003, M8, FR-39/FR-40).

Uses a FAKE Google Calendar service (never the real client) so nothing touches
the network and the google libraries are not required at collection time (they
are imported lazily inside the builder). Verifies the event-body mapping, the
deterministic iCalUID, idempotency-by-UID, error handling, and the
``build_calendar_provider`` selection logic.
"""

from __future__ import annotations

from datetime import date, time
from typing import Any

from vandy_food_radar.config import CalendarProviderKind, Config
from vandy_food_radar.models import Event, FoodConfirmed, VerificationState
from vandy_food_radar.providers import calendar as calendar_module
from vandy_food_radar.providers.calendar import (
    GoogleCalendarWriter,
    NullCalendarProvider,
    build_calendar_provider,
)


class _FakeImport:
    """Records the import_ call arguments and returns a fixed created event."""

    def __init__(self, sink: dict[str, Any], returned_id: str) -> None:
        self._sink = sink
        self._returned_id = returned_id

    def __call__(self, *, calendarId: str, body: dict[str, Any]) -> _FakeImport:
        self._sink["calendarId"] = calendarId
        self._sink["body"] = body
        return self

    def execute(self) -> dict[str, str]:
        return {"id": self._returned_id}


class _FakeEvents:
    def __init__(self, sink: dict[str, Any], returned_id: str) -> None:
        self._import = _FakeImport(sink, returned_id)

    def import_(self, *, calendarId: str, body: dict[str, Any]) -> _FakeImport:
        return self._import(calendarId=calendarId, body=body)


class _FakeService:
    """Stub Google Calendar service capturing the imported event body."""

    def __init__(self, returned_id: str = "evt-1") -> None:
        self.sink: dict[str, Any] = {}
        self._events = _FakeEvents(self.sink, returned_id)

    def events(self) -> _FakeEvents:
        return self._events


class _RaisingService:
    """Stub service whose import_ raises to exercise the error path."""

    def events(self) -> _RaisingService:
        return self

    def import_(self, *, calendarId: str, body: dict[str, Any]) -> _RaisingService:
        return self

    def execute(self) -> dict[str, str]:
        raise RuntimeError("boom")


def _event() -> Event:
    return Event(
        id="e1",
        dedup_key="d1",
        identity_key="2025-03-11-free-pizza-night",
        title="Free Pizza Night",
        event_date=date(2025, 3, 11),
        start_time=time(18, 0),
        end_time=time(20, 0),
        location="Sarratt Student Center",
        food_description="Pizza and drinks",
        event_url="https://example.edu/pizza",
        food_confirmed=FoodConfirmed.CONFIRMED,
    )


def test_add_event_maps_body_and_ical_uid() -> None:
    service = _FakeService(returned_id="evt-42")
    writer = GoogleCalendarWriter(
        service=service, calendar_id="cal-1", timezone="America/Chicago"
    )
    event = _event()

    result = writer.add_event(event)

    assert result.ok is True
    assert result.event_ref == "evt-42"
    assert service.sink["calendarId"] == "cal-1"
    body = service.sink["body"]
    assert body["summary"] == "Free Pizza Night"
    assert body["iCalUID"] == "vfr-2025-03-11-free-pizza-night"
    assert body["location"] == "Sarratt Student Center"
    assert "Pizza and drinks" in body["description"]
    assert "https://example.edu/pizza" in body["description"]
    assert body["start"]["timeZone"] == "America/Chicago"
    assert body["end"]["timeZone"] == "America/Chicago"
    assert body["start"]["dateTime"].startswith("2025-03-11T18:00:00")
    assert body["end"]["dateTime"].startswith("2025-03-11T20:00:00")


def test_add_event_all_day_when_no_start_time() -> None:
    service = _FakeService()
    writer = GoogleCalendarWriter(
        service=service, calendar_id="cal-1", timezone="America/Chicago"
    )
    event = _event()
    event.start_time = None
    event.end_time = None

    writer.add_event(event)

    body = service.sink["body"]
    assert body["start"] == {"date": "2025-03-11"}
    assert body["end"] == {"date": "2025-03-11"}


def test_repeat_add_uses_same_ical_uid_for_idempotency() -> None:
    service = _FakeService()
    writer = GoogleCalendarWriter(
        service=service, calendar_id="cal-1", timezone="America/Chicago"
    )
    event = _event()

    writer.add_event(event)
    first_uid = service.sink["body"]["iCalUID"]
    writer.add_event(event)
    second_uid = service.sink["body"]["iCalUID"]

    assert first_uid == second_uid == "vfr-2025-03-11-free-pizza-night"


def test_add_event_never_raises_on_error() -> None:
    writer = GoogleCalendarWriter(
        service=_RaisingService(), calendar_id="cal-1", timezone="America/Chicago"
    )

    result = writer.add_event(_event())

    assert result.ok is False
    assert result.detail == "boom"


def test_build_returns_null_when_disabled_or_no_creds() -> None:
    # Default config: provider NONE, writes disabled.
    assert isinstance(build_calendar_provider(Config()), NullCalendarProvider)

    # GOOGLE + enabled but no credentials -> still Null.
    config = Config()
    config.providers.calendar = CalendarProviderKind.GOOGLE
    config.calendar_write.enabled = True
    assert isinstance(build_calendar_provider(config), NullCalendarProvider)

    # Credentials present but writes disabled -> still Null.
    config2 = Config()
    config2.providers.calendar = CalendarProviderKind.GOOGLE
    config2.calendar_write.credentials_json = "{}"
    assert isinstance(build_calendar_provider(config2), NullCalendarProvider)


def test_build_returns_google_writer_when_enabled_with_creds(
    monkeypatch: Any,
) -> None:
    fake = _FakeService()
    monkeypatch.setattr(
        calendar_module,
        "_build_google_service",
        lambda credentials_json: fake,
    )
    config = Config()
    config.providers.calendar = CalendarProviderKind.GOOGLE
    config.calendar_write.enabled = True
    config.calendar_write.calendar_id = "cal-9"
    config.calendar_write.credentials_json = '{"type": "service_account"}'

    provider = build_calendar_provider(config)

    assert isinstance(provider, GoogleCalendarWriter)
    # The lazily built (mocked) service is wired through and used on add.
    provider.add_event(_event())
    assert fake.sink["calendarId"] == "cal-9"


def test_verification_state_marker_type() -> None:
    # Guard: cancelled state is a distinct value the web layer skips.
    assert VerificationState.CANCELLED.value == "cancelled"
