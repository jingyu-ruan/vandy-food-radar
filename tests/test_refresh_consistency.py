"""User-visible refresh warnings and rollback across a failed local batch."""

from dataclasses import replace
from datetime import date, timedelta

import pytest
from vandy_food_radar.config import Config
from vandy_food_radar.pipeline.orchestrator import (
    LAST_SUCCESS_KEY,
    material_change_key,
    run_days,
)
from vandy_food_radar.providers.location import NullLocationProvider
from vandy_food_radar.sources import AnchorLinkFetchError
from vandy_food_radar.store import SqliteRepository
from vandy_food_radar.web import create_app

from .support import Listing, StubSourceAdapter


@pytest.mark.parametrize(
    ("field", "value", "label"),
    [
        ("start_time", "19:00", "Time changed"),
        ("location", "Buttrick Hall, Room 309", "Venue changed"),
    ],
)
def test_refresh_warning_survives_snapshot_advancement(
    field: str, value: str, label: str
) -> None:
    day = date(2026, 9, 30)
    listing = Listing("Campus dinner", source_identity="anchorlink:1234")
    table = {day: [listing]}
    repo = SqliteRepository()
    try:
        client = create_app(
            Config(),
            repository=repo,
            sources=[StubSourceAdapter(table)],
            location_provider=NullLocationProvider(),
            today_provider=lambda: day,
        ).test_client()
        assert client.post("/cron/refresh").status_code == 200
        changed = (
            replace(listing, start_time=value)
            if field == "start_time"
            else replace(listing, location=value)
        )
        table[day] = [changed]
        assert client.post("/cron/refresh").status_code == 200
        assert client.get("/api/day").get_json()["events"][0]["change"] == label
        assert label in client.get("/").get_data(as_text=True)
        # A stable next refresh advances the baseline but keeps the recent
        # warning visible to someone who missed the update.
        assert client.post("/cron/refresh").status_code == 200
        assert client.get("/api/day").get_json()["events"][0]["change"] == label
    finally:
        repo.close()


def test_failed_second_day_rolls_back_first_day_and_its_change_metadata() -> None:
    day = date(2026, 9, 30)
    next_day = day + timedelta(days=1)
    config = Config()
    repo = SqliteRepository()
    provider = NullLocationProvider()
    original = Listing("Campus dinner", source_identity="anchorlink:1234")
    try:
        run_days(
            [day],
            repository=repo,
            sources=[StubSourceAdapter({day: [original]})],
            location_provider=provider,
            config=config,
            today=day,
        )
        previous_success = repo.get_metadata(LAST_SUCCESS_KEY)
        previous = repo.get_events_for_day(day)[0]
        broken = StubSourceAdapter(
            {day: [replace(original, start_time="19:00")]}, fail_on={next_day}
        )
        with pytest.raises(AnchorLinkFetchError):
            run_days(
                [day, next_day],
                repository=repo,
                sources=[broken],
                location_provider=provider,
                config=config,
                today=day,
            )
        assert repo.get_events_for_day(day)[0].start_time == previous.start_time
        assert repo.get_metadata(LAST_SUCCESS_KEY) == previous_success
        assert repo.get_metadata(material_change_key(previous)) is None
        assert repo.get_history(previous.id) == []
    finally:
        repo.close()
