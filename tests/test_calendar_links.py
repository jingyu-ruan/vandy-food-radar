"""Tests for credential-free calendar handoff (Google prefill + ICS download).

The properties that matter are the ones a calendar client will punish us for
getting wrong: correct instants across a DST boundary, a real duration when the
listing gives none, an overnight end that rolls to the next day, an all-day
entry with the exclusive ``DTEND`` an all-day VEVENT requires, RFC 5545 text
escaping, folding measured in UTF-8 *octets*, CRLF line endings, and a stable
UID so a re-import updates rather than duplicates.

Pure functions only — no server credentials and no network.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from urllib.parse import parse_qs, urlsplit
from uuid import NAMESPACE_URL, UUID, uuid5

from vandy_food_radar.calendar_links import (
    DEFAULT_DURATION_MINUTES,
    GOOGLE_CALENDAR_TEMPLATE_URL,
    build_ics,
    escape_ics_text,
    fold_ics_line,
    google_calendar_url,
    ics_filename,
    resolve_window,
)
from vandy_food_radar.models import VerificationState

from .support import make_event

TZ = "America/Chicago"
STAMP = datetime(2025, 3, 11, 12, 0, tzinfo=UTC)


def _ics(**overrides: object) -> str:
    return build_ics(make_event(**overrides), timezone=TZ, now=STAMP)  # type: ignore[arg-type]


def _properties(document: str) -> dict[str, str]:
    """Unfold the document and index single-valued properties by name."""

    unfolded = document.replace("\r\n ", "")
    properties: dict[str, str] = {}
    for line in unfolded.split("\r\n"):
        if not line or ":" not in line:
            continue
        name, _, value = line.partition(":")
        properties[name] = value
    return properties


# ---------------------------------------------------------------------------
# time model
# ---------------------------------------------------------------------------


def test_timed_event_uses_the_standard_time_offset_before_dst() -> None:
    # 2025-03-08 is CST (UTC-6); 18:00 local is 00:00Z the next day.
    document = _ics(event_date=date(2025, 3, 8))
    properties = _properties(document)
    assert properties["DTSTART"] == "20250309T000000Z"
    assert properties["DTEND"] == "20250309T020000Z"


def test_timed_event_uses_the_daylight_offset_after_dst() -> None:
    # 2025-03-10 is CDT (UTC-5); the same 18:00 wall clock is 23:00Z.
    document = _ics(event_date=date(2025, 3, 10))
    properties = _properties(document)
    assert properties["DTSTART"] == "20250310T230000Z"
    assert properties["DTEND"] == "20250311T010000Z"


def test_dst_transition_day_keeps_distinct_instants() -> None:
    """The same wall clock on either side of the jump is not the same instant."""

    before = _properties(_ics(event_date=date(2025, 3, 8)))["DTSTART"]
    after = _properties(_ics(event_date=date(2025, 3, 10)))["DTSTART"]
    assert before != after


def test_missing_end_time_gets_a_real_default_duration() -> None:
    event = make_event(end_time=None)
    window = resolve_window(event, timezone=TZ)
    assert window.start is not None and window.end is not None
    assert window.end - window.start == timedelta(minutes=DEFAULT_DURATION_MINUTES)
    assert window.all_day is False
    assert window.crosses_midnight is False


def test_overnight_end_rolls_to_the_next_day_and_is_flagged() -> None:
    event = make_event(start_time=time(22, 0), end_time=time(1, 0))
    window = resolve_window(event, timezone=TZ)
    assert window.crosses_midnight is True
    assert window.end is not None and window.start is not None
    assert window.end.date() == event.event_date.fromordinal(
        event.event_date.toordinal() + 1
    )

    document = build_ics(event, timezone=TZ, now=STAMP)
    assert "X-VFR-OVERNIGHT:TRUE" in document
    properties = _properties(document)
    assert properties["DTSTART"] == "20250312T030000Z"  # 22:00 CDT
    assert properties["DTEND"] == "20250312T060000Z"  # 01:00 CDT next day


def test_unknown_start_time_becomes_an_all_day_entry() -> None:
    event = make_event(start_time=None, end_time=None)
    window = resolve_window(event, timezone=TZ)
    assert window.all_day is True
    assert window.start_date == event.event_date
    # All-day DTEND is exclusive, so it must be the following date.
    assert window.end_date == date(2025, 3, 12)

    document = build_ics(event, timezone=TZ, now=STAMP)
    properties = _properties(document)
    assert properties["DTSTART;VALUE=DATE"] == "20250311"
    assert properties["DTEND;VALUE=DATE"] == "20250312"
    assert "X-VFR-TIME-UNKNOWN:TRUE" in document
    assert "DTSTART:" not in document


def test_an_end_equal_to_the_start_is_treated_as_overnight() -> None:
    window = resolve_window(
        make_event(start_time=time(20, 0), end_time=time(20, 0)), timezone=TZ
    )
    assert window.crosses_midnight is True
    assert window.start is not None and window.end is not None
    assert (window.end - window.start).total_seconds() == 24 * 3600


# ---------------------------------------------------------------------------
# ICS document structure
# ---------------------------------------------------------------------------


def test_document_is_a_single_crlf_delimited_vevent() -> None:
    document = _ics()
    assert document.startswith("BEGIN:VCALENDAR\r\n")
    assert document.endswith("END:VCALENDAR\r\n")
    assert document.count("BEGIN:VEVENT") == 1
    assert document.count("END:VEVENT") == 1
    # No bare line feeds: every break is a CRLF.
    assert "\n" in document
    assert document.replace("\r\n", "").find("\n") == -1
    assert _properties(document)["DTSTAMP"] == "20250311T120000Z"


def test_uid_is_a_uuid5_of_the_identity_key_and_is_stable() -> None:
    event = make_event(identity_key="2025-03-11|night pizza")
    first = _properties(build_ics(event, timezone=TZ, now=STAMP))["UID"]
    second = _properties(build_ics(event, timezone=TZ, now=STAMP))["UID"]
    assert first == second

    local, _, domain = first.partition("@")
    assert domain == "vandy-food-radar"
    assert UUID(local).version == 5
    assert local == str(uuid5(NAMESPACE_URL, event.identity_key))


def test_uid_differs_between_events_with_colliding_titles() -> None:
    """Source-native identity keys must not collapse into one calendar entry."""

    first = _properties(_ics(identity_key="source|1001"))["UID"]
    second = _properties(_ics(identity_key="source|1002"))["UID"]
    assert first != second


def test_cancelled_event_is_published_as_cancelled_not_omitted() -> None:
    document = _ics(verification_state=VerificationState.CANCELLED)
    assert "STATUS:CANCELLED" in document
    assert "STATUS:CONFIRMED" not in document
    assert "BEGIN:VEVENT" in document


def test_active_event_is_confirmed() -> None:
    assert "STATUS:CONFIRMED" in _ics()


def test_description_carries_only_source_grounded_fields() -> None:
    document = _ics(
        food_description="Pizza and salad.",
        organizer="Student Life",
        rsvp_required=True,
        rsvp_url="https://anchorlink.vanderbilt.edu/rsvp/1",
    )
    description = _properties(document)["DESCRIPTION"]
    assert "Pizza and salad." in description
    assert "Organizer: Student Life" in description
    assert "RSVP required." in description
    assert "https://anchorlink.vanderbilt.edu/rsvp/1" in description


def test_absent_optional_fields_emit_no_empty_properties() -> None:
    document = _ics(
        location=None,
        organizer=None,
        food_description=None,
        event_url=None,
        rsvp_url=None,
    )
    properties = _properties(document)
    assert "LOCATION" not in properties
    assert "DESCRIPTION" not in properties
    assert "URL" not in properties


# ---------------------------------------------------------------------------
# escaping and folding
# ---------------------------------------------------------------------------


def test_escape_handles_backslash_first_then_separators_and_newlines() -> None:
    assert escape_ics_text("a\\b") == "a\\\\b"
    assert escape_ics_text("a,b;c") == "a\\,b\\;c"
    assert escape_ics_text("a\r\nb\rc\nd") == "a\\nb\\nc\\nd"
    # A literal backslash must not be re-escaped by the later passes.
    assert escape_ics_text("x\\,y") == "x\\\\\\,y"


def test_separator_characters_in_a_title_cannot_split_a_property() -> None:
    document = _ics(title="Tacos, Rice; and More\nSecond line")
    summary = _properties(document)["SUMMARY"]
    assert summary == "Tacos\\, Rice\\; and More\\nSecond line"
    # The raw newline never reached the document as a line break.
    assert "Second line" not in document.split("\r\n")


def test_folding_never_splits_a_multibyte_character() -> None:
    line = "SUMMARY:" + "\u00e9" * 120  # 2 octets each
    folded = fold_ics_line(line)
    parts = folded.split("\r\n")
    assert len(parts) > 1
    assert len(parts[0].encode("utf-8")) <= 75
    for continuation in parts[1:]:
        assert continuation.startswith(" ")
        assert len(continuation.encode("utf-8")) <= 75
    assert folded.replace("\r\n ", "") == line


def test_short_lines_are_not_folded() -> None:
    assert fold_ics_line("SUMMARY:Short") == "SUMMARY:Short"


def test_utf8_summary_round_trips_through_folding() -> None:
    title = "\u56fd\u9645\u5b66\u751f\u665a\u9910" * 8
    document = _ics(title=title)
    assert _properties(document)["SUMMARY"] == escape_ics_text(title)
    for line in document.split("\r\n"):
        assert len(line.encode("utf-8")) <= 75


def test_an_unsafe_event_url_is_dropped_rather_than_sanitized() -> None:
    document = _ics(event_url="https://example.org/a\r\nSUMMARY:injected")
    # The payload never becomes a content line, and no partial URL is emitted.
    assert "SUMMARY:injected" not in document.split("\r\n")
    assert "URL" not in _properties(document)
    assert document.count("SUMMARY") == 1


def test_non_http_schemes_never_reach_the_url_property() -> None:
    for unsafe in (
        "javascript:alert(1)",
        "data:text/calendar;base64,QUJD",
        "/relative/path",
        "mailto:someone@example.org",
        "https://",
    ):
        assert "URL" not in _properties(_ics(event_url=unsafe)), unsafe


def test_an_absolute_http_url_is_kept() -> None:
    for safe in (
        "https://anchorlink.vanderbilt.edu/event/1",
        "http://example.org/listing",
    ):
        assert _properties(_ics(event_url=safe))["URL"] == safe


# ---------------------------------------------------------------------------
# download filename
# ---------------------------------------------------------------------------


def test_filename_is_ascii_safe_and_dated() -> None:
    name = ics_filename(make_event(title="Caf\u00e9 Night! (free)"))
    assert name == "vandy-food-radar-2025-03-11-caf-night-free.ics"
    assert name.isascii()
    assert '"' not in name and "\n" not in name


def test_filename_falls_back_when_a_title_has_no_ascii_characters() -> None:
    name = ics_filename(make_event(title="\u5bff\u53f8"))
    assert name == "vandy-food-radar-2025-03-11-event.ics"


# ---------------------------------------------------------------------------
# Google prefill
# ---------------------------------------------------------------------------


def test_google_prefill_url_is_a_template_link_with_no_credentials() -> None:
    url = google_calendar_url(make_event(), timezone=TZ)
    parts = urlsplit(url)
    assert f"{parts.scheme}://{parts.netloc}{parts.path}" == (
        GOOGLE_CALENDAR_TEMPLATE_URL
    )
    query = parse_qs(parts.query)
    assert query["action"] == ["TEMPLATE"]
    assert query["dates"] == ["20250311T230000Z/20250312T010000Z"]
    assert query["ctz"] == [TZ]
    assert query["text"] == ["Free Pizza Night"]
    assert query["location"] == ["Sarratt Student Center, Room 216"]
    # Nothing that looks like a token or key is present.
    assert "key" not in query
    assert "access_token" not in query


def test_google_prefill_url_uses_date_range_for_an_unknown_time() -> None:
    url = google_calendar_url(make_event(start_time=None, end_time=None), timezone=TZ)
    query = parse_qs(urlsplit(url).query)
    assert query["dates"] == ["20250311/20250312"]


def test_google_prefill_url_omits_location_when_none_is_listed() -> None:
    url = google_calendar_url(make_event(location=None), timezone=TZ)
    assert "location=" not in urlsplit(url).query
