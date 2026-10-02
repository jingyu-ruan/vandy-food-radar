"""Shared offline test helpers.

Everything here is synthetic and deterministic: no network, no wall clock, no
fixture-file dependence. The builders mirror exactly the shapes the real
adapters emit (``parsed_fields`` keys, provider-native ``source_identity``,
AnchorLink-style event URLs) so tests exercise the production code paths rather
than a parallel universe.

Not a test module itself; pytest only collects ``test_*.py``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, time
from typing import Any

from vandy_food_radar.models import (
    Event,
    FoodCategory,
    FoodConfirmed,
    ParseStatus,
    SourceId,
    SourceRecord,
    VerificationState,
)
from vandy_food_radar.sources import AnchorLinkFetchError, Window
from vandy_food_radar.store import SqliteRepository

# A fixed local day used wherever a test needs "some day" with no clock.
DEMO_DAY = date(2025, 3, 11)
DEMO_START = time(18, 0)
DEMO_END = time(20, 0)


@dataclass
class Listing:
    """One synthetic source listing, rendered onto whichever day is requested."""

    title: str
    start_time: str | None = "18:00"
    end_time: str | None = "20:00"
    location: str | None = "Sarratt Student Center, Room 216"
    organizer: str | None = "Student Life"
    food_description: str = "Free pizza for everyone."
    # Provider-native id. Present for live-style rows, absent for legacy ones.
    source_identity: str | None = None
    cancelled: bool = False


def source_record(
    listing: Listing,
    day: date,
    *,
    source_id: SourceId = SourceId.ANCHOR_LINK,
    record_id: str | None = None,
) -> SourceRecord:
    """Build one :class:`SourceRecord` for ``listing`` on ``day``."""

    identity = listing.source_identity
    url = (
        f"https://anchorlink.vanderbilt.edu/event/{identity}"
        if identity is not None
        else None
    )
    fields: dict[str, Any] = {
        "title": listing.title,
        "event_date": day.isoformat(),
        "start_time": listing.start_time,
        "end_time": listing.end_time,
        "location": listing.location,
        "organizer": listing.organizer,
        "food_description": listing.food_description,
        "event_url": url,
    }
    if identity is not None:
        fields["source_identity"] = identity
    if listing.cancelled:
        fields["cancelled"] = True
    return SourceRecord(
        # Mirrors the live adapters: AnchorLink keys the record on the native
        # id, so two same-titled rows never share a source-record id.
        id=record_id
        or f"{source_id.value}|{day.isoformat()}|{identity or listing.title}",
        event_id="",
        source_id=source_id,
        source_url=url,
        raw_payload=json.dumps({"description": listing.food_description}),
        parsed_fields=fields,
        parse_status=ParseStatus.OK,
    )


class StubSourceAdapter:
    """A :class:`SourceAdapter` serving a fixed per-day listing table.

    ``fail_on`` makes the adapter raise the same error class the live
    AnchorLink adapter raises, which is how a mid-batch source failure is
    simulated without any network.
    """

    source_id = "stub"

    def __init__(
        self,
        listings: dict[date, list[Listing]],
        *,
        fail_on: set[date] | None = None,
        source_id: SourceId = SourceId.ANCHOR_LINK,
    ) -> None:
        self._listings = listings
        self._fail_on = set() if fail_on is None else set(fail_on)
        self._source_id = source_id
        self.calls: list[date] = []

    def fetch(self, window: Window) -> list[SourceRecord]:
        """Return the configured records for ``window``, or raise."""

        self.calls.append(window.target_date)
        if window.target_date in self._fail_on:
            raise AnchorLinkFetchError(
                f"stub source refused {window.target_date.isoformat()}"
            )
        return [
            source_record(listing, window.target_date, source_id=self._source_id)
            for listing in self._listings.get(window.target_date, [])
        ]


class FlushCountingRepository(SqliteRepository):
    """SQLite repository that counts durable publications.

    ``flush`` is the publication boundary for the durable live repository, so
    counting it is how a test asserts "published exactly once, and only after
    every requested day succeeded".
    """

    def __init__(self) -> None:
        super().__init__(":memory:")
        self.flush_calls = 0

    def flush(self) -> None:
        """Record the publication, then commit."""

        self.flush_calls += 1
        super().flush()


def make_event(
    *,
    identity_key: str = "2025-03-11|night pizza",
    event_id: str = "evt-1",
    title: str = "Free Pizza Night",
    event_date: date = DEMO_DAY,
    start_time: time | None = DEMO_START,
    end_time: time | None = DEMO_END,
    location: str | None = "Sarratt Student Center, Room 216",
    organizer: str | None = "Student Life",
    food_description: str | None = "Pizza and salad.",
    event_url: str | None = "https://anchorlink.vanderbilt.edu/event/1",
    rsvp_required: bool | None = None,
    rsvp_url: str | None = None,
    verification_state: VerificationState = VerificationState.VERIFIED,
    food_confirmed: FoodConfirmed = FoodConfirmed.CONFIRMED,
    food_category: FoodCategory = FoodCategory.FULL_MEAL,
    score_total: float | None = 0.8,
) -> Event:
    """Build a canonical :class:`Event` without going through the pipeline."""

    return Event(
        id=event_id,
        dedup_key=f"{event_date.isoformat()}|{title.lower()}",
        identity_key=identity_key,
        title=title,
        event_date=event_date,
        start_time=start_time,
        end_time=end_time,
        location=location,
        organizer=organizer,
        rsvp_required=rsvp_required,
        rsvp_url=rsvp_url,
        event_url=event_url,
        food_confirmed=food_confirmed,
        food_category=food_category,
        food_description=food_description,
        verification_state=verification_state,
        confidence=0.9,
        score_total=score_total,
    )


__all__ = [
    "DEMO_DAY",
    "DEMO_END",
    "DEMO_START",
    "FlushCountingRepository",
    "Listing",
    "StubSourceAdapter",
    "make_event",
    "source_record",
]
