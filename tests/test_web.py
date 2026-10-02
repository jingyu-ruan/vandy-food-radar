"""Tests for the rebuilt Flask workspace.

Drives the Flask test client over a seeded in-memory repository and asserts the
behavior the interface promises: the page opens on today, renders cards in
ranked order with cancelled listings last, shows every required card field,
keeps routine partial-verification status out of the way while retaining
material warnings, exposes credential-free calendar handoff, and still honours
the pre-existing server-side calendar-write route. The web layer reads only
through the Repository. No network I/O beyond loading the offline corpus.
"""

from __future__ import annotations

from datetime import date, timedelta
from urllib.parse import quote

from vandy_food_radar.config import Config
from vandy_food_radar.models import Event
from vandy_food_radar.pipeline import ChangeKind, seed_demo
from vandy_food_radar.places import load_places_for
from vandy_food_radar.providers.calendar import CalendarWriteResult
from vandy_food_radar.providers.location import NullLocationProvider
from vandy_food_radar.store import InMemorySnapshotStore, SqliteRepository
from vandy_food_radar.web import create_app
from vandy_food_radar.web.viewmodel import build_day_feed

from .support import Listing, StubSourceAdapter

# The fixture corpus is dated 2025-03-11 and the default window is TODAY, so a
# fixed "today" of that date is what the seeded demo publishes.
FIXED_TODAY = date(2025, 3, 11)
TARGET_DAY = FIXED_TODAY

PIZZA_KEY = "2025-03-11|night pizza"
MOVIE_KEY = "2025-03-11|movie night outdoor"


def _seeded_app(**kwargs: object) -> tuple[object, SqliteRepository]:
    config = Config()
    repository = SqliteRepository(":memory:")
    seed_demo(repository=repository, config=config, today=FIXED_TODAY)
    app = create_app(
        config,
        repository=repository,
        today_provider=lambda: FIXED_TODAY,
        **kwargs,  # type: ignore[arg-type]
    )
    return app, repository


def test_index_opens_on_today_with_ranked_cards() -> None:
    app, repository = _seeded_app()
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        response = client.get("/")
        assert response.status_code == 200
        body = response.get_data(as_text=True)

        # Dense card fields are present.
        assert "Free Pizza Night" in body
        assert "International Student Dinner" in body
        assert "Recommendation" in body  # 0-5 star control
        assert "Walking time unavailable" in body or "min walk from" in body
        assert "RSVP" in body
        assert "Host" in body
        assert "Participation" in body

        # The selected date is today and is stated in the working heading.
        assert f'value="{TARGET_DAY.isoformat()}"' in body
        assert "today" in body
    finally:
        repository.close()


def test_cards_render_in_ranked_order_with_cancelled_last() -> None:
    app, repository = _seeded_app()
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        body = client.get("/").get_data(as_text=True)

        # Dinner-with-menu (full meal) must appear before the refreshments talk.
        assert body.index("International Student Dinner") < body.index(
            "Undergraduate Research Talk"
        )
        # The cancelled movie night is forced below a normal event.
        assert body.index("Free Pizza Night") < body.index("Outdoor Movie Night")
    finally:
        repository.close()


def test_material_warnings_shown_and_routine_status_hidden() -> None:
    app, repository = _seeded_app()
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        body = client.get("/").get_data(as_text=True)

        # Cancellation and genuine cross-source conflict are surfaced.
        assert "is-cancelled" in body
        assert "This listing is cancelled." in body
        assert "Conflicting details" in body
        assert "Sources disagree on" in body

        # The routine "partially verified" state is not shown as a status badge.
        assert "Partially verified" not in body
    finally:
        repository.close()


def test_conflicts_are_listed_in_the_details_pane() -> None:
    app, repository = _seeded_app()
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        body = client.get("/").get_data(as_text=True)
        assert "detail-conflicts" in body
        assert "card-details" in body
    finally:
        repository.close()


def test_credential_free_calendar_handoff_is_offered() -> None:
    app, repository = _seeded_app()
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        body = client.get("/").get_data(as_text=True)
        assert "calendar.google.com/calendar/render" in body
        assert "/calendar/ics/" in body

        response = client.get(
            f"/calendar/ics/{quote(PIZZA_KEY, safe='')}?date={TARGET_DAY.isoformat()}"
        )
        assert response.status_code == 200
        assert response.mimetype == "text/calendar"
        document = response.get_data(as_text=True)
        assert document.startswith("BEGIN:VCALENDAR")
        assert "SUMMARY:Free Pizza Night" in document
        assert ".ics" in response.headers["Content-Disposition"]
    finally:
        repository.close()


def test_ics_download_for_unknown_event_is_404() -> None:
    app, repository = _seeded_app()
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        response = client.get("/calendar/ics/not-a-real-key")
        assert response.status_code == 404
    finally:
        repository.close()


def test_refresh_triggers_pipeline_and_redirects() -> None:
    config = Config()
    repository = SqliteRepository(":memory:")
    try:
        app = create_app(
            config,
            repository=repository,
            today_provider=lambda: FIXED_TODAY,
        )
        assert repository.get_events_for_day(TARGET_DAY) == []

        client = app.test_client()
        response = client.post("/refresh")
        assert response.status_code == 302
        assert len(repository.get_events_for_day(TARGET_DAY)) > 0
    finally:
        repository.close()


def test_a_first_load_does_not_badge_every_listing_as_new() -> None:
    """With no previous snapshot everything is NEW, which is not a warning.

    Badging an entire first page "New" is noise, so only material changes
    (time, venue, cancellation) reach the card.
    """

    config = Config()
    repository = SqliteRepository(":memory:")
    seed_demo(repository=repository, config=config, today=FIXED_TODAY)
    store = InMemorySnapshotStore()
    try:
        app = create_app(
            config,
            repository=repository,
            today_provider=lambda: FIXED_TODAY,
            snapshot_store=store,
        )
        client = app.test_client()
        assert store.load_snapshot(TARGET_DAY) is None

        body = client.get("/").get_data(as_text=True)
        assert "Free Pizza Night" in body
        assert "tag-change" not in body
        assert ">New<" not in body

        # The classification itself still reports them as new.
        payload = client.get("/api/day").get_json()
        assert all(event["change"] is None for event in payload["events"])
    finally:
        repository.close()


def test_a_time_change_against_the_previous_snapshot_is_badged_and_warned() -> None:
    """A moved start time is surfaced as a badge, a warning, and in the API."""

    config = Config()
    repository = SqliteRepository(":memory:")
    store = InMemorySnapshotStore()
    listings = {
        TARGET_DAY: [
            Listing("Chapter Dinner", start_time="18:00", source_identity="7001")
        ]
    }
    adapter = StubSourceAdapter(listings)
    try:
        app = create_app(
            config,
            repository=repository,
            sources=[adapter],
            location_provider=NullLocationProvider(),
            today_provider=lambda: FIXED_TODAY,
            snapshot_store=store,
        )
        client = app.test_client()
        client.post("/cron/refresh")

        # The source moves the start time; the refresh classifies it.
        listings[TARGET_DAY] = [
            Listing("Chapter Dinner", start_time="19:00", source_identity="7001")
        ]
        report = client.post("/cron/refresh").get_json()
        assert report["changes"]["time_changed"] == 1
        assert report["changes"]["new"] == 0

        # Rendering against the previous baseline shows the material change.
        feed = build_day_feed(
            repository,
            TARGET_DAY,
            config=config,
            provider=NullLocationProvider(),
            places=load_places_for(config),
            changes={"source|7001": ChangeKind.TIME_CHANGED},
        )
        card = feed.cards[0]
        assert card.change_label == "Time changed"
        assert "The listed time changed since the last refresh." in card.warnings
        assert card.to_json()["change"] == "Time changed"
    finally:
        repository.close()


def test_a_venue_change_and_a_cancellation_are_also_badged() -> None:
    config = Config()
    repository = SqliteRepository(":memory:")
    seed_demo(repository=repository, config=config, today=FIXED_TODAY)
    try:
        for kind, label, warning in (
            (ChangeKind.VENUE_CHANGED, "Venue changed", "listed venue changed"),
            (ChangeKind.CANCELLED, "Cancelled", None),
        ):
            feed = build_day_feed(
                repository,
                TARGET_DAY,
                config=config,
                provider=NullLocationProvider(),
                places=load_places_for(config),
                changes={PIZZA_KEY: kind},
            )
            card = next(c for c in feed.cards if c.event.identity_key == PIZZA_KEY)
            assert card.change_label == label
            if warning is not None:
                assert any(warning in text for text in card.warnings)
    finally:
        repository.close()


def test_an_unchanged_listing_carries_no_change_label() -> None:
    config = Config()
    repository = SqliteRepository(":memory:")
    seed_demo(repository=repository, config=config, today=FIXED_TODAY)
    try:
        feed = build_day_feed(
            repository,
            TARGET_DAY,
            config=config,
            provider=NullLocationProvider(),
            places=load_places_for(config),
            changes={PIZZA_KEY: ChangeKind.UNCHANGED},
        )
        card = next(c for c in feed.cards if c.event.identity_key == PIZZA_KEY)
        assert card.change_label is None
        assert not any("changed since" in text for text in card.warnings)
    finally:
        repository.close()


class _RecordingCalendarProvider:
    """Fake calendar provider recording each add_event call."""

    def __init__(self) -> None:
        self.added: list[Event] = []

    def add_event(self, event: Event) -> CalendarWriteResult:
        self.added.append(event)
        return CalendarWriteResult(ok=True, event_ref="evt-1")


def test_calendar_add_with_null_provider_shows_not_configured() -> None:
    app, repository = _seeded_app()
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        response = client.post(f"/calendar/add/{quote(PIZZA_KEY, safe='')}")
        assert response.status_code == 302

        body = client.get("/").get_data(as_text=True)
        assert "Calendar not configured" in body
    finally:
        repository.close()


def test_calendar_add_calls_provider_once_for_matching_event() -> None:
    fake = _RecordingCalendarProvider()
    app, repository = _seeded_app(calendar_provider=fake)
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        response = client.post(f"/calendar/add/{quote(PIZZA_KEY, safe='')}")
        assert response.status_code == 302
        assert len(fake.added) == 1
        assert fake.added[0].identity_key == PIZZA_KEY
    finally:
        repository.close()


def test_calendar_add_skips_cancelled_event() -> None:
    fake = _RecordingCalendarProvider()
    app, repository = _seeded_app(calendar_provider=fake)
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        response = client.post(f"/calendar/add/{quote(MOVIE_KEY, safe='')}")
        assert response.status_code == 302
        assert fake.added == []
    finally:
        repository.close()


def test_client_config_never_leaks_the_routing_key() -> None:
    config = Config()
    config.routing.api_key = "super-secret-routing-key"
    repository = SqliteRepository(":memory:")
    seed_demo(repository=repository, config=config, today=FIXED_TODAY)
    try:
        app = create_app(
            config,
            repository=repository,
            today_provider=lambda: FIXED_TODAY,
        )
        client = app.test_client()
        body = client.get("/").get_data(as_text=True)
        assert "super-secret-routing-key" not in body
        # Availability is reported, the value is not.
        assert '"routing_available": true' in body

        meta = client.get("/api/meta").get_data(as_text=True)
        assert "super-secret-routing-key" not in meta
    finally:
        repository.close()


def test_other_dates_render_empty_without_borrowing_events() -> None:
    app, repository = _seeded_app()
    try:
        client = app.test_client()  # type: ignore[attr-defined]
        other = (TARGET_DAY + timedelta(days=3)).isoformat()
        body = client.get(f"/?date={other}").get_data(as_text=True)
        assert "Free Pizza Night" not in body
        assert "No free-food listings are published for this date." in body
    finally:
        repository.close()
