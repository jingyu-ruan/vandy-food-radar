"""Verify the offline fixture corpus (T0.4, design.md §9).

These tests assert every fixture loads and parses as valid JSON/HTML with no
network access, and that the corpus covers the six required scenarios.
"""

from __future__ import annotations

import json

from vandy_food_radar.fixtures import (
    fixtures_dir,
    list_html_fixtures,
    list_json_fixtures,
    load_all_json_fixtures,
    load_json_fixture,
    load_text_fixture,
)
from vandy_food_radar.models import ParseStatus, SourceId

EXPECTED_SCENARIOS = {
    "multi_source_pizza_night",
    "dinner_with_menu",
    "refreshments_only",
    "conflicting_start_time",
    "cancelled_event",
    "calendar_only_event",
    "unparseable_source_page",
}


def test_fixtures_directory_exists() -> None:
    assert fixtures_dir().is_dir()


def test_all_json_fixtures_parse() -> None:
    fixtures = list_json_fixtures()
    assert fixtures, "expected at least one JSON fixture"
    for path in fixtures:
        with path.open(encoding="utf-8") as handle:
            data = json.load(handle)
        assert isinstance(data, dict)


def test_every_fixture_has_required_shape() -> None:
    for stem, data in load_all_json_fixtures().items():
        for key in (
            "scenario",
            "source_id",
            "source_url",
            "checked_at",
            "parse_status",
        ):
            assert key in data, f"{stem} missing key {key!r}"
        # source_id and parse_status are valid enum values.
        SourceId(data["source_id"])
        ParseStatus(data["parse_status"])
        # A record is either parsed (has parsed_fields) or an error record.
        assert "parsed_fields" in data


def test_corpus_covers_all_required_scenarios() -> None:
    scenarios = {data["scenario"] for data in load_all_json_fixtures().values()}
    assert EXPECTED_SCENARIOS.issubset(scenarios)


def test_multi_source_pizza_night_has_slightly_different_titles() -> None:
    anchor = load_json_fixture("pizza_night_anchor_link")
    gcal = load_json_fixture("pizza_night_google_calendar")
    assert anchor["scenario"] == gcal["scenario"] == "multi_source_pizza_night"
    assert anchor["source_id"] == "anchor_link"
    assert gcal["source_id"] == "google_calendar"
    # Titles differ but describe the same event.
    assert anchor["parsed_fields"]["title"] != gcal["parsed_fields"]["title"]
    assert anchor["parsed_fields"]["event_date"] == gcal["parsed_fields"]["event_date"]


def test_conflicting_start_times_across_sources() -> None:
    anchor = load_json_fixture("conflicting_time_anchor_link")
    gcal = load_json_fixture("conflicting_time_google_calendar")
    official = load_json_fixture("conflicting_time_official_page")
    starts = {
        anchor["parsed_fields"]["start_time"],
        gcal["parsed_fields"]["start_time"],
    }
    assert len(starts) == 2, "expected disagreeing start times"
    # The official page (top authority) agrees with anchor link on 18:00.
    assert official["parsed_fields"]["start_time"] == "18:00"
    assert official["source_id"] == "official_page"


def test_cancelled_event_flagged() -> None:
    data = load_json_fixture("cancelled_event_anchor_link")
    assert data["parsed_fields"]["cancelled"] is True


def test_calendar_only_event_has_no_anchor_link_counterpart() -> None:
    data = load_json_fixture("calendar_only_event_google_calendar")
    assert data["source_id"] == "google_calendar"
    # No other fixture shares this scenario as an anchor_link record.
    same_scenario = [
        d
        for d in load_all_json_fixtures().values()
        if d["scenario"] == "calendar_only_event"
    ]
    assert all(d["source_id"] == "google_calendar" for d in same_scenario)


def test_unparseable_page_records_parse_error_and_html_loads() -> None:
    data = load_json_fixture("unparseable_official_page")
    assert data["parse_status"] == "parse_error"
    assert data["parsed_fields"] == {}
    html_name = data["raw_payload_file"]
    html = load_text_fixture(html_name)
    # The HTML snippet loads verbatim and contains no parseable event fields.
    assert "<html" in html.lower()


def test_html_fixtures_present() -> None:
    html_files = list_html_fixtures()
    assert html_files, "expected at least one HTML fixture"
    for path in html_files:
        assert path.read_text(encoding="utf-8").strip()
