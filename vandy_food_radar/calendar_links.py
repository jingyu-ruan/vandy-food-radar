"""Credential-free calendar handoff: Google prefill links and ICS downloads.

Adding an event to a personal calendar should not require the server to hold
anyone's calendar credentials. Two paths cover every case:

* a Google Calendar *prefill* URL, which opens Google's own event composer with
  the fields filled in — the user confirms, so no OAuth scope is needed;
* an RFC 5545 ``.ics`` file, which every calendar application can import.

Both paths share one time model so they never disagree:

* A known start with a known end uses both.
* A known start with no end gets a default duration rather than a zero-length
  entry that some clients silently drop.
* An end at or before the start is read as crossing midnight and rolls to the
  next day, which is how late-night campus events are actually listed.
* No start time at all becomes an all-day entry for the event date (with the
  exclusive ``DTEND`` an all-day VEVENT requires).

Local wall-clock times are converted through :mod:`zoneinfo`, so the correct
offset is used on either side of a DST transition. ICS text is escaped per
RFC 5545 and folded to 75 *octets* using UTF-8 byte lengths, so a multi-byte
character is never split across a folded line.

Pure and deterministic apart from the ``DTSTAMP`` clock, which is injectable.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from urllib.parse import urlencode, urlsplit
from uuid import NAMESPACE_URL, uuid5
from zoneinfo import ZoneInfo

from .models import Event

GOOGLE_CALENDAR_TEMPLATE_URL = "https://calendar.google.com/calendar/render"

# Used when a listing gives a start but no end, so the calendar entry has a
# real duration instead of collapsing to a single instant.
DEFAULT_DURATION_MINUTES = 60

# RFC 5545 §3.1: content lines are folded at 75 octets excluding CRLF.
_FOLD_OCTETS = 75
_CRLF = "\r\n"


def _safe_link(value: str | None) -> str | None:
    if not value or "\r" in value or "\n" in value:
        return None
    try:
        parts = urlsplit(value.strip())
    except ValueError:
        return None
    return value.strip() if parts.scheme in {"https", "http"} and parts.netloc else None


@dataclass(frozen=True)
class CalendarWindow:
    """The resolved calendar time window for one event.

    ``all_day`` entries carry dates; timed entries carry aware datetimes.
    ``crosses_midnight`` records that the listed end was rolled to the next day.
    """

    all_day: bool
    start: datetime | None = None
    end: datetime | None = None
    start_date: date | None = None
    end_date: date | None = None
    crosses_midnight: bool = False


def resolve_window(
    event: Event,
    *,
    timezone: str,
    default_duration_minutes: int = DEFAULT_DURATION_MINUTES,
) -> CalendarWindow:
    """Resolve ``event`` into a calendar window (see module docstring)."""

    tz = ZoneInfo(timezone)
    if event.start_time is None:
        return CalendarWindow(
            all_day=True,
            start_date=event.event_date,
            # All-day DTEND is exclusive.
            end_date=event.event_date + timedelta(days=1),
        )

    start = datetime.combine(event.event_date, event.start_time, tzinfo=tz)
    if event.end_time is None:
        return CalendarWindow(
            all_day=False,
            start=start,
            end=start + timedelta(minutes=default_duration_minutes),
        )

    end = datetime.combine(event.event_date, event.end_time, tzinfo=tz)
    crosses = False
    if end <= start:
        end = datetime.combine(
            event.event_date + timedelta(days=1), event.end_time, tzinfo=tz
        )
        crosses = True
    return CalendarWindow(all_day=False, start=start, end=end, crosses_midnight=crosses)


def _utc_stamp(value: datetime) -> str:
    """Format an aware datetime as a UTC ICS timestamp."""

    return value.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def _google_timed(value: datetime) -> str:
    """Format an aware datetime for a Google prefill URL (UTC basic format)."""

    return value.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")


def event_description(event: Event) -> str:
    """Compose a short, source-grounded description for calendar handoff."""

    parts: list[str] = []
    if event.food_description:
        parts.append(event.food_description)
    if event.organizer:
        parts.append(f"Organizer: {event.organizer}")
    if event.rsvp_required:
        parts.append("RSVP required.")
    if link := _safe_link(event.rsvp_url):
        parts.append(f"RSVP: {link}")
    if link := _safe_link(event.event_url):
        parts.append(f"Source: {link}")
    return "\n".join(parts)


def google_calendar_url(
    event: Event,
    *,
    timezone: str,
    default_duration_minutes: int = DEFAULT_DURATION_MINUTES,
) -> str:
    """Build a Google Calendar prefill URL for ``event`` (no credentials).

    The returned URL only opens Google's composer with fields filled in; the
    user still confirms the save, so the server never needs calendar scopes.
    """

    window = resolve_window(
        event, timezone=timezone, default_duration_minutes=default_duration_minutes
    )
    if window.all_day:
        assert window.start_date is not None and window.end_date is not None
        dates = (
            f"{window.start_date.strftime('%Y%m%d')}/"
            f"{window.end_date.strftime('%Y%m%d')}"
        )
    else:
        assert window.start is not None and window.end is not None
        dates = f"{_google_timed(window.start)}/{_google_timed(window.end)}"

    params = {
        "action": "TEMPLATE",
        "text": event.title,
        "dates": dates,
        "details": event_description(event),
        "ctz": timezone,
    }
    if event.location:
        params["location"] = event.location
    return f"{GOOGLE_CALENDAR_TEMPLATE_URL}?{urlencode(params)}"


def escape_ics_text(value: str) -> str:
    """Escape a value for an ICS TEXT property (RFC 5545 §3.3.11).

    Backslash first (so later escapes are not double-escaped), then semicolons
    and commas, then newlines. Carriage returns are normalized away.
    """

    escaped = value.replace("\\", "\\\\")
    escaped = escaped.replace(";", "\\;").replace(",", "\\,")
    escaped = escaped.replace("\r\n", "\n").replace("\r", "\n")
    return escaped.replace("\n", "\\n")


def fold_ics_line(line: str) -> str:
    """Fold one content line at 75 octets without splitting a character.

    Folding is specified in octets, not characters, so the length is measured
    on the UTF-8 encoding and a multi-byte character is pushed to the next line
    rather than cut in half. Continuation lines begin with a single space.
    """

    encoded = line.encode("utf-8")
    if len(encoded) <= _FOLD_OCTETS:
        return line

    pieces: list[str] = []
    current = ""
    current_octets = 0
    # The first line may use 75 octets; continuations lose one to the leading
    # space that marks them.
    limit = _FOLD_OCTETS
    for character in line:
        size = len(character.encode("utf-8"))
        if current_octets + size > limit:
            pieces.append(current)
            current = ""
            current_octets = 0
            limit = _FOLD_OCTETS - 1
        current += character
        current_octets += size
    if current:
        pieces.append(current)
    return _CRLF.join([pieces[0], *(f" {piece}" for piece in pieces[1:])])


def _property(name: str, value: str) -> str:
    return fold_ics_line(f"{name}:{value}")


def build_ics(
    event: Event,
    *,
    timezone: str,
    now: datetime | None = None,
    default_duration_minutes: int = DEFAULT_DURATION_MINUTES,
) -> str:
    """Render ``event`` as a single-VEVENT ICS document.

    The ``UID`` is derived from the event's stable ``identity_key`` so
    re-importing updates the same calendar entry instead of duplicating it. A
    cancelled event is emitted with ``STATUS:CANCELLED`` rather than omitted, so
    importing it updates a previously saved copy to cancelled.
    """

    window = resolve_window(
        event, timezone=timezone, default_duration_minutes=default_duration_minutes
    )
    stamp = _utc_stamp(now if now is not None else datetime.now(tz=UTC))

    lines: list[str] = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Vandy Food Radar//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        _property(
            "UID",
            f"{uuid5(NAMESPACE_URL, event.identity_key or event.id)}@vandy-food-radar",
        ),
        _property("DTSTAMP", stamp),
    ]

    if window.all_day:
        assert window.start_date is not None and window.end_date is not None
        lines.append(
            _property("DTSTART;VALUE=DATE", window.start_date.strftime("%Y%m%d"))
        )
        lines.append(_property("DTEND;VALUE=DATE", window.end_date.strftime("%Y%m%d")))
    else:
        assert window.start is not None and window.end is not None
        # UTC stamps carry the zone-correct instant across DST transitions
        # without shipping a VTIMEZONE component.
        lines.append(_property("DTSTART", _utc_stamp(window.start)))
        lines.append(_property("DTEND", _utc_stamp(window.end)))

    lines.append(_property("SUMMARY", escape_ics_text(event.title)))
    if event.location:
        lines.append(_property("LOCATION", escape_ics_text(event.location)))
    description = event_description(event)
    if description:
        lines.append(_property("DESCRIPTION", escape_ics_text(description)))
    if link := _safe_link(event.event_url):
        lines.append(_property("URL", link))
    if event.verification_state.value == "cancelled":
        lines.append("STATUS:CANCELLED")
    else:
        lines.append("STATUS:CONFIRMED")
    if window.all_day:
        lines.append("X-VFR-TIME-UNKNOWN:TRUE")
    if window.crosses_midnight:
        lines.append("X-VFR-OVERNIGHT:TRUE")

    lines.extend(["END:VEVENT", "END:VCALENDAR"])
    return _CRLF.join(lines) + _CRLF


def ics_filename(event: Event) -> str:
    """Return a safe ASCII download filename for ``event``."""

    slug = "".join(
        character if character.isascii() and character.isalnum() else "-"
        for character in event.title.lower()
    ).strip("-")
    slug = "-".join(part for part in slug.split("-") if part)[:60] or "event"
    return f"vandy-food-radar-{event.event_date.isoformat()}-{slug}.ics"


__all__ = [
    "DEFAULT_DURATION_MINUTES",
    "GOOGLE_CALENDAR_TEMPLATE_URL",
    "CalendarWindow",
    "build_ics",
    "escape_ics_text",
    "event_description",
    "fold_ics_line",
    "google_calendar_url",
    "ics_filename",
    "resolve_window",
]
