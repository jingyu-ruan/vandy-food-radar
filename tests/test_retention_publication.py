"""Tests for multi-day refresh, day isolation, retention, and atomic publish.

The dangerous failure mode for a multi-day feed is a partial refresh that
deletes a day it never successfully re-fetched. These tests pin the four rules
that prevent it:

1. ``replace_day`` deletes stale rows **on its own day only**.
2. ``run_days`` writes every requested day locally and publishes (``flush``)
   exactly once, after the last day succeeds.
3. A failure partway through the batch publishes nothing and leaves the
   last-success metadata untouched.
4. Retention is a bounded rolling window applied once, after publication.

Entirely offline: a stub adapter supplies the per-day listings.
"""

from __future__ import annotations

from datetime import date, timedelta

from vandy_food_radar.config import Config
from vandy_food_radar.pipeline import (
    LAST_SUCCESS_DAYS_KEY,
    LAST_SUCCESS_KEY,
    REFRESH_DAY_CHOICES,
    retention_window,
    run,
    run_days,
)
from vandy_food_radar.providers.location import NullLocationProvider
from vandy_food_radar.sources import AnchorLinkFetchError, Window, window_dates
from vandy_food_radar.store import SqliteRepository

from .support import FlushCountingRepository, Listing, StubSourceAdapter

TODAY = date(2025, 3, 11)
D0 = TODAY
D1 = TODAY + timedelta(days=1)
D2 = TODAY + timedelta(days=2)


def _listings() -> dict[date, list[Listing]]:
    return {
        D0: [Listing("Monday Pizza", source_identity="1001")],
        D1: [
            Listing("Tuesday Tacos", source_identity="1002"),
            Listing("Tuesday Bagels", start_time="09:00", source_identity="1003"),
        ],
        D2: [Listing("Wednesday Curry", source_identity="1004")],
    }


def _run_days(
    repository: SqliteRepository,
    days: list[date],
    *,
    config: Config | None = None,
    adapter: StubSourceAdapter | None = None,
) -> object:
    return run_days(
        days,
        repository=repository,
        sources=[adapter or StubSourceAdapter(_listings())],
        location_provider=NullLocationProvider(),
        config=config or Config(),
        today=TODAY,
    )


def _titles(repository: SqliteRepository, day: date) -> list[str]:
    return sorted(event.title for event in repository.get_events_for_day(day))


# ---------------------------------------------------------------------------
# day isolation
# ---------------------------------------------------------------------------


def test_each_day_holds_only_its_own_events() -> None:
    repository = FlushCountingRepository()
    try:
        _run_days(repository, [D0, D1, D2])
        assert _titles(repository, D0) == ["Monday Pizza"]
        assert _titles(repository, D1) == ["Tuesday Bagels", "Tuesday Tacos"]
        assert _titles(repository, D2) == ["Wednesday Curry"]
        assert repository.stored_days() == [D0, D1, D2]
    finally:
        repository.close()


def test_replace_day_deletes_only_stale_rows_on_that_day() -> None:
    repository = FlushCountingRepository()
    try:
        _run_days(repository, [D0, D1])
        before_other_day = _titles(repository, D1)

        # Publishing D0 with nothing retained clears D0 and nothing else.
        repository.replace_day(D0, set())
        assert repository.get_events_for_day(D0) == []
        assert _titles(repository, D1) == before_other_day
    finally:
        repository.close()


def test_replace_day_keeps_exactly_the_published_identity_keys() -> None:
    repository = FlushCountingRepository()
    try:
        _run_days(repository, [D1])
        events = repository.get_events_for_day(D1)
        assert len(events) == 2
        keeper = events[0]

        repository.replace_day(D1, {keeper.identity_key})
        remaining = repository.get_events_for_day(D1)
        assert [event.identity_key for event in remaining] == [keeper.identity_key]
    finally:
        repository.close()


def test_a_day_that_loses_every_listing_is_emptied_without_touching_others() -> None:
    repository = FlushCountingRepository()
    try:
        _run_days(repository, [D0, D1])
        # The source now reports nothing for D0 but still lists D1.
        shrunk = dict(_listings())
        shrunk[D0] = []
        _run_days(repository, [D0, D1], adapter=StubSourceAdapter(shrunk))

        assert repository.get_events_for_day(D0) == []
        assert _titles(repository, D1) == ["Tuesday Bagels", "Tuesday Tacos"]
    finally:
        repository.close()


# ---------------------------------------------------------------------------
# atomic publication
# ---------------------------------------------------------------------------


def test_a_multi_day_batch_publishes_exactly_once() -> None:
    repository = FlushCountingRepository()
    try:
        _run_days(repository, [D0, D1, D2])
        assert repository.flush_calls == 1
    finally:
        repository.close()


def test_single_day_run_publishes_and_an_unpublished_run_does_not() -> None:
    repository = FlushCountingRepository()
    try:
        run(
            Window(target_date=D0),
            repository=repository,
            sources=[StubSourceAdapter(_listings())],
            location_provider=NullLocationProvider(),
            config=Config(),
        )
        assert repository.flush_calls == 1

        run(
            Window(target_date=D1),
            repository=repository,
            sources=[StubSourceAdapter(_listings())],
            location_provider=NullLocationProvider(),
            config=Config(),
            publish=False,
        )
        assert repository.flush_calls == 1
    finally:
        repository.close()


def test_a_failure_partway_through_publishes_nothing() -> None:
    repository = FlushCountingRepository()
    try:
        _run_days(repository, [D0, D1, D2])
        published_flushes = repository.flush_calls
        first_success = repository.get_metadata(LAST_SUCCESS_KEY)
        assert first_success is not None

        failing = StubSourceAdapter(_listings(), fail_on={D1})
        try:
            _run_days(repository, [D0, D1, D2], adapter=failing)
        except AnchorLinkFetchError:
            pass
        else:
            raise AssertionError("the batch should have propagated the failure")

        # No new durable publication and no new success stamp.
        assert repository.flush_calls == published_flushes
        assert repository.get_metadata(LAST_SUCCESS_KEY) == first_success
        # The adapter stopped at the failing day instead of pressing on.
        assert failing.calls == [D0, D1]
        # The day beyond the failure was never replaced.
        assert _titles(repository, D2) == ["Wednesday Curry"]
    finally:
        repository.close()


def test_last_success_metadata_records_the_day_count() -> None:
    repository = FlushCountingRepository()
    try:
        _run_days(repository, [D0, D1])
        assert repository.get_metadata(LAST_SUCCESS_DAYS_KEY) == "2"

        _run_days(repository, window_dates(Config(), today=TODAY, days=7))
        assert repository.get_metadata(LAST_SUCCESS_DAYS_KEY) == "7"
        stamp = repository.get_metadata(LAST_SUCCESS_KEY)
        assert stamp is not None and stamp.endswith("+00:00")
    finally:
        repository.close()


def test_duplicate_and_unordered_days_are_normalized() -> None:
    repository = FlushCountingRepository()
    try:
        report = _run_days(repository, [D2, D0, D2, D1])
        assert report.days == [D0, D1, D2]  # type: ignore[attr-defined]
        assert report.target_date == D0  # type: ignore[attr-defined]
        assert repository.flush_calls == 1
    finally:
        repository.close()


def test_an_empty_day_list_is_refused() -> None:
    repository = FlushCountingRepository()
    try:
        run_days(
            [],
            repository=repository,
            sources=[StubSourceAdapter({})],
            location_provider=NullLocationProvider(),
            config=Config(),
            today=TODAY,
        )
    except ValueError as exc:
        assert "at least one day" in str(exc)
    else:
        raise AssertionError("an empty batch should have been refused")
    finally:
        repository.close()


def test_repeating_a_batch_is_idempotent() -> None:
    repository = FlushCountingRepository()
    try:
        first = _run_days(repository, [D0, D1, D2])
        counts = {day: len(repository.get_events_for_day(day)) for day in (D0, D1, D2)}

        second = _run_days(repository, [D0, D1, D2])
        assert {
            day: len(repository.get_events_for_day(day)) for day in (D0, D1, D2)
        } == counts
        assert second.scored == first.scored  # type: ignore[attr-defined]
        assert repository.flush_calls == 2
    finally:
        repository.close()


# ---------------------------------------------------------------------------
# bounded rolling retention
# ---------------------------------------------------------------------------


def test_retention_window_is_anchored_on_today() -> None:
    config = Config()
    config.retention.past_days = 1
    config.retention.future_days = 2
    assert retention_window(TODAY, config) == {
        TODAY - timedelta(days=1),
        TODAY,
        TODAY + timedelta(days=1),
        TODAY + timedelta(days=2),
    }


def test_retention_window_default_keeps_today_through_two_weeks_out() -> None:
    config = Config()
    window = retention_window(TODAY, config)
    assert min(window) == TODAY
    assert max(window) == TODAY + timedelta(days=13)
    assert len(window) == 14


def test_retention_window_handles_negative_configuration_safely() -> None:
    config = Config()
    config.retention.past_days = -5
    config.retention.future_days = -5
    assert retention_window(TODAY, config) == {TODAY}


def test_stale_and_far_future_days_are_pruned_after_publication() -> None:
    repository = FlushCountingRepository()
    config = Config()
    try:
        stale = TODAY - timedelta(days=5)
        far = TODAY + timedelta(days=40)
        listings = {
            stale: [Listing("Old Leftovers", source_identity="900")],
            far: [Listing("Distant Banquet", source_identity="901")],
            **_listings(),
        }
        adapter = StubSourceAdapter(listings)

        # Seed days outside the retention window directly.
        for day in (stale, far):
            run(
                Window(target_date=day),
                repository=repository,
                sources=[adapter],
                location_provider=NullLocationProvider(),
                config=config,
            )
        assert repository.stored_days() == [stale, far]

        report = _run_days(repository, [D0, D1], config=config, adapter=adapter)
        assert repository.stored_days() == [D0, D1]
        assert report.retained_days == [D0, D1]  # type: ignore[attr-defined]
    finally:
        repository.close()


def test_requested_days_survive_retention_even_outside_the_window() -> None:
    repository = FlushCountingRepository()
    config = Config()
    config.retention.future_days = 0
    try:
        _run_days(repository, [D0, D1, D2], config=config)
        # The window alone would keep only D0, but every requested day is kept.
        assert repository.stored_days() == [D0, D1, D2]
    finally:
        repository.close()


def test_prune_days_with_an_empty_keep_set_clears_everything() -> None:
    repository = FlushCountingRepository()
    try:
        _run_days(repository, [D0, D1])
        repository.prune_days(set())
        assert repository.stored_days() == []
    finally:
        repository.close()


# ---------------------------------------------------------------------------
# scheduler-facing day spans
# ---------------------------------------------------------------------------


def test_window_dates_matches_the_offered_refresh_choices() -> None:
    config = Config()
    assert REFRESH_DAY_CHOICES == (1, 2, 7)
    for days in REFRESH_DAY_CHOICES:
        span = window_dates(config, today=TODAY, days=days)
        assert len(span) == days
        assert span[0] == TODAY
        assert span == sorted(span)
        assert span[-1] == TODAY + timedelta(days=days - 1)


def test_window_dates_never_returns_an_empty_span() -> None:
    assert window_dates(Config(), today=TODAY, days=0) == [TODAY]
    assert window_dates(Config(), today=TODAY, days=-3) == [TODAY]
