"""Tests for explicit date selection across the page, the API, and downloads.

The product rule is absolute: a selected date shows that date's events and
nothing else. These tests publish three different days with disjoint listings
and then check every read path — the rendered page, ``/api/day``, ``/api/week``,
the daily brief, and the ICS download — for leakage in either direction.
"""

from __future__ import annotations

from datetime import date, timedelta
from urllib.parse import quote

from flask import Flask
from vandy_food_radar.config import Config
from vandy_food_radar.pipeline import run_days
from vandy_food_radar.providers.location import NullLocationProvider
from vandy_food_radar.web import create_app
from vandy_food_radar.web.app import parse_days, parse_iso_date

from .support import FlushCountingRepository, Listing, StubSourceAdapter

TODAY = date(2025, 3, 11)
D0 = TODAY
D1 = TODAY + timedelta(days=1)
D2 = TODAY + timedelta(days=2)
EMPTY_DAY = TODAY + timedelta(days=3)

LISTINGS = {
    D0: [Listing("Monday Pizza", source_identity="3001")],
    D1: [Listing("Tuesday Tacos", source_identity="3002")],
    D2: [Listing("Wednesday Curry", source_identity="3003")],
}
TITLES = {
    D0: "Monday Pizza",
    D1: "Tuesday Tacos",
    D2: "Wednesday Curry",
}


def _published_app() -> tuple[Flask, FlushCountingRepository]:
    config = Config()
    repository = FlushCountingRepository()
    run_days(
        [D0, D1, D2],
        repository=repository,
        sources=[StubSourceAdapter(LISTINGS)],
        location_provider=NullLocationProvider(),
        config=config,
        today=TODAY,
    )
    app = create_app(
        config,
        repository=repository,
        location_provider=NullLocationProvider(),
        today_provider=lambda: TODAY,
    )
    return app, repository


# ---------------------------------------------------------------------------
# query parsing
# ---------------------------------------------------------------------------


def test_iso_dates_are_parsed_strictly_with_a_default_fallback() -> None:
    assert parse_iso_date("2025-03-12", default=TODAY) == date(2025, 3, 12)
    assert parse_iso_date(" 2025-03-12 ", default=TODAY) == date(2025, 3, 12)
    for bad in (None, "", "tomorrow", "2025-13-01", "03/12/2025", "2025-03-32"):
        assert parse_iso_date(bad, default=TODAY) == TODAY


def test_day_counts_outside_the_offered_choices_collapse_to_one() -> None:
    assert parse_days(None) == 1
    assert parse_days("1") == 1
    assert parse_days("2") == 2
    assert parse_days("7") == 7
    for bad in ("0", "3", "-2", "99", "seven", "2.5", ""):
        assert parse_days(bad) == 1


# ---------------------------------------------------------------------------
# page
# ---------------------------------------------------------------------------


def test_the_page_opens_on_today() -> None:
    app, repository = _published_app()
    try:
        body = app.test_client().get("/").get_data(as_text=True)
        assert TITLES[D0] in body
        assert TITLES[D1] not in body
        assert TITLES[D2] not in body
        assert f'value="{D0.isoformat()}"' in body
    finally:
        repository.close()


def test_each_selected_date_renders_only_its_own_events() -> None:
    app, repository = _published_app()
    try:
        client = app.test_client()
        for day, title in TITLES.items():
            body = client.get(f"/?date={day.isoformat()}").get_data(as_text=True)
            assert title in body
            for other_day, other_title in TITLES.items():
                if other_day != day:
                    assert other_title not in body
    finally:
        repository.close()


def test_a_malformed_date_falls_back_to_today_rather_than_a_nearby_day() -> None:
    app, repository = _published_app()
    try:
        body = app.test_client().get("/?date=not-a-date").get_data(as_text=True)
        assert TITLES[D0] in body
        assert TITLES[D1] not in body
    finally:
        repository.close()


# ---------------------------------------------------------------------------
# JSON API
# ---------------------------------------------------------------------------


def test_api_day_is_scoped_to_the_requested_date() -> None:
    app, repository = _published_app()
    try:
        client = app.test_client()
        for day, title in TITLES.items():
            payload = client.get(f"/api/day?date={day.isoformat()}").get_json()
            assert payload["date"] == day.isoformat()
            assert [event["title"] for event in payload["events"]] == [title]
            assert {event["date"] for event in payload["events"]} == {day.isoformat()}
    finally:
        repository.close()


def test_api_day_defaults_to_today_and_reports_an_empty_day_honestly() -> None:
    app, repository = _published_app()
    try:
        client = app.test_client()
        assert client.get("/api/day").get_json()["date"] == D0.isoformat()

        empty = client.get(f"/api/day?date={EMPTY_DAY.isoformat()}").get_json()
        assert empty["date"] == EMPTY_DAY.isoformat()
        assert empty["events"] == []
        assert empty["brief"]["headline"] == "No listings"
    finally:
        repository.close()


def test_the_brief_describes_the_selected_day_only() -> None:
    app, repository = _published_app()
    try:
        client = app.test_client()
        first = client.get(f"/api/day?date={D0.isoformat()}").get_json()["brief"]
        second = client.get(f"/api/day?date={D1.isoformat()}").get_json()["brief"]
        assert TITLES[D0] in first["headline"]
        assert TITLES[D1] in second["headline"]
        assert first["content_hash"] != second["content_hash"]
        assert TITLES[D1] not in first["text"] + first["headline"]
    finally:
        repository.close()


def test_api_week_buckets_each_event_under_its_own_date() -> None:
    app, repository = _published_app()
    try:
        payload = app.test_client().get(f"/api/week?start={D0.isoformat()}").get_json()
        assert payload["start"] == D0.isoformat()
        assert len(payload["days"]) == 7

        by_date = {day["date"]: day["events"] for day in payload["days"]}
        assert [e["title"] for e in by_date[D0.isoformat()]] == [TITLES[D0]]
        assert [e["title"] for e in by_date[D1.isoformat()]] == [TITLES[D1]]
        assert [e["title"] for e in by_date[D2.isoformat()]] == [TITLES[D2]]
        assert by_date[EMPTY_DAY.isoformat()] == []
        # Every event carries the date of the bucket it appears in.
        for iso, events in by_date.items():
            assert all(event["date"] == iso for event in events)
    finally:
        repository.close()


def test_api_week_starts_where_it_is_asked_to() -> None:
    app, repository = _published_app()
    try:
        client = app.test_client()
        shifted = client.get(f"/api/week?start={D2.isoformat()}").get_json()
        assert shifted["days"][0]["date"] == D2.isoformat()
        titles = [event["title"] for day in shifted["days"] for event in day["events"]]
        assert titles == [TITLES[D2]]

        assert client.get("/api/week").get_json()["start"] == D0.isoformat()
        assert (
            client.get("/api/week?start=garbage").get_json()["start"] == D0.isoformat()
        )
    finally:
        repository.close()


# ---------------------------------------------------------------------------
# downloads never cross days
# ---------------------------------------------------------------------------


def test_the_ics_download_resolves_only_within_the_requested_day() -> None:
    app, repository = _published_app()
    try:
        client = app.test_client()
        key = quote("source|3002", safe="")

        right = client.get(f"/calendar/ics/{key}?date={D1.isoformat()}")
        assert right.status_code == 200
        assert "SUMMARY:Tuesday Tacos" in right.get_data(as_text=True)
        assert "DTSTART:20250312T230000Z" in right.get_data(as_text=True)

        # The same key on another date is a miss, not a silent cross-day match.
        assert client.get(f"/calendar/ics/{key}?date={D0.isoformat()}").status_code == (
            404
        )
        # With no date parameter the lookup is scoped to today.
        assert client.get(f"/calendar/ics/{key}").status_code == 404
    finally:
        repository.close()


def test_the_calendar_links_on_a_card_point_at_that_cards_date() -> None:
    app, repository = _published_app()
    try:
        payload = app.test_client().get(f"/api/day?date={D1.isoformat()}").get_json()
        calendar = payload["events"][0]["calendar"]
        assert f"date={D1.isoformat()}" in calendar["ics"]
        assert quote("source|3002", safe="") in calendar["ics"]
        assert "20250312T230000Z" in calendar["google"]
    finally:
        repository.close()


def test_the_server_calendar_write_route_also_stays_on_one_day() -> None:
    app, repository = _published_app()
    try:
        client = app.test_client()
        key = quote("source|3002", safe="")
        response = client.post(f"/calendar/add/{key}?date={D0.isoformat()}")
        assert response.status_code == 302
        assert f"date={D0.isoformat()}" in response.headers["Location"]
        body = client.get(f"/?date={D0.isoformat()}").get_data(as_text=True)
        assert "Event not found" in body
    finally:
        repository.close()
