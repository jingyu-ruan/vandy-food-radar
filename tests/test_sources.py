"""Tests for the offline source-ingestion layer (design.md §3, T2.1-T2.6).

Each adapter is driven by the fixture corpus through the offline
:class:`FixtureFetcher` (no network). Covers the Free Food perk filter, correct
``source_id``/``parse_status`` per record, graceful handling of the unparseable
official page, and the calendar-only event (E-14).
"""

from __future__ import annotations

from datetime import date

from vandy_food_radar.config import Config, TargetWindow
from vandy_food_radar.models import ParseStatus, SourceId
from vandy_food_radar.sources import (
    AnchorLinkAdapter,
    FetchResult,
    FixtureFetcher,
    FixtureSourceAdapter,
    GoogleCalendarAdapter,
    OfficialPageAdapter,
    Window,
    build_sources,
    default_fetcher,
)

TARGET_DATE = date(2025, 3, 11)


def _window() -> Window:
    return Window(target_date=TARGET_DATE)


def _fetcher() -> FixtureFetcher:
    return FixtureFetcher()


def test_window_from_config_next_day_and_today() -> None:
    today = date(2025, 3, 10)
    next_day = Window.from_config(Config(), today=today)
    assert next_day.target_date == date(2025, 3, 11)

    cfg = Config()
    cfg.target_window = TargetWindow.TODAY
    assert Window.from_config(cfg, today=today).target_date == today


def test_fixture_fetcher_unknown_url_is_fetch_error() -> None:
    result = _fetcher().get("https://nope.example.com/missing")
    assert isinstance(result, FetchResult)
    assert result.ok is False
    assert result.status == 404
    assert result.error is not None


def test_anchor_link_adapter_returns_free_food_records() -> None:
    records = AnchorLinkAdapter(_fetcher()).fetch(_window())
    assert records, "expected anchor link records"
    assert all(r.source_id is SourceId.ANCHOR_LINK for r in records)
    # Every returned OK record advertised the Free Food perk and parsed cleanly.
    ok_records = [r for r in records if r.parse_status is ParseStatus.OK]
    assert ok_records
    for record in ok_records:
        assert record.parsed_fields
        assert record.parsed_fields["title"]
        assert record.checked_at is not None


def test_anchor_link_adapter_filters_non_free_food_perk() -> None:
    # A synthetic fetcher returns an anchor payload WITHOUT the Free Food perk.
    class NoPerkFetcher:
        def get(self, url: str, *, timeout: float = 10.0) -> FetchResult:
            return FetchResult(
                url=url,
                ok=True,
                status=200,
                text='{"perks": ["T-Shirts"], "name": "No Food Here"}',
            )

    records = AnchorLinkAdapter(NoPerkFetcher()).fetch(_window())
    # Nothing advertises Free Food, so no OK records survive the filter.
    assert [r for r in records if r.parse_status is ParseStatus.OK] == []


def test_google_calendar_adapter_produces_calendar_only_event() -> None:
    records = GoogleCalendarAdapter(_fetcher()).fetch(_window())
    assert all(r.source_id is SourceId.GOOGLE_CALENDAR for r in records)
    titles = {r.parsed_fields.get("title") for r in records}
    assert "Late Night Study Break: Free Bagels" in titles


def test_official_page_adapter_records_parse_error_without_raising() -> None:
    records = OfficialPageAdapter(_fetcher()).fetch(_window())
    assert records
    assert all(r.source_id is SourceId.OFFICIAL_PAGE for r in records)
    errored = [r for r in records if r.parse_status is ParseStatus.PARSE_ERROR]
    assert errored, "expected the unparseable official page to be surfaced"
    for record in errored:
        assert record.parsed_fields == {}
        # The raw HTML body is preserved even though parsing failed.
        assert record.raw_payload is not None


def test_build_sources_wires_all_enabled_adapters_offline() -> None:
    config = Config()
    fetcher = default_fetcher(config)
    assert isinstance(fetcher, FixtureFetcher)
    adapters = build_sources(config, fetcher)
    source_ids = {a.source_id for a in adapters}
    assert source_ids == {
        SourceId.ANCHOR_LINK.value,
        SourceId.GOOGLE_CALENDAR.value,
        SourceId.OFFICIAL_PAGE.value,
    }


def test_build_sources_respects_disabled_source() -> None:
    config = Config()
    config.sources.google_calendar.enabled = False
    adapters = build_sources(config, _fetcher())
    assert SourceId.GOOGLE_CALENDAR.value not in {a.source_id for a in adapters}


def test_fixture_source_adapter_yields_every_corpus_record() -> None:
    from vandy_food_radar.fixtures import list_json_fixtures

    records = FixtureSourceAdapter(_fetcher()).fetch(_window())
    # One record per JSON fixture in the corpus.
    assert len(records) == len(list_json_fixtures())
    source_ids = {r.source_id for r in records}
    assert source_ids == {
        SourceId.ANCHOR_LINK,
        SourceId.GOOGLE_CALENDAR,
        SourceId.OFFICIAL_PAGE,
    }
