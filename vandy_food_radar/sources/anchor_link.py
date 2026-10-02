"""Offline and live Vanderbilt AnchorLink Free Food source adapters."""

from __future__ import annotations

import json
import re
from datetime import UTC, date, datetime, time, timedelta
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlencode
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..config import AnchorLinkSource
from ..models import ParseStatus, SourceId, SourceRecord
from ._common import build_source_record, corpus_records_for
from .base import HttpFetcher, Window

FREE_FOOD_PERK = "Free Food"
_CANONICAL_EVENT_BASE_URL = "https://anchorlink.vanderbilt.edu"
_EVENT_ID = re.compile(r"[1-9][0-9]*\Z")


class AnchorLinkFetchError(RuntimeError):
    """Raised when a complete, trustworthy live result cannot be obtained."""


class AnchorLinkAdapter:
    """Emit fixture-backed AnchorLink records for offline demos and tests."""

    source_id = SourceId.ANCHOR_LINK.value

    def __init__(self, fetcher: HttpFetcher) -> None:
        self._fetcher = fetcher

    def fetch(self, window: Window) -> list[SourceRecord]:
        records: list[SourceRecord] = []
        for raw in corpus_records_for(SourceId.ANCHOR_LINK):
            record = build_source_record(SourceId.ANCHOR_LINK, raw, self._fetcher)
            if record.parse_status is not ParseStatus.OK:
                records.append(record)
                continue
            if _has_free_food_perk(record.raw_payload):
                records.append(record)
        return records


class LiveAnchorLinkAdapter:
    """Discover genuine Vanderbilt events through AnchorLink's public API."""

    source_id = SourceId.ANCHOR_LINK.value

    def __init__(
        self,
        fetcher: HttpFetcher,
        settings: AnchorLinkSource,
        *,
        timezone: str,
    ) -> None:
        self._fetcher = fetcher
        self._settings = settings
        try:
            self._timezone = ZoneInfo(timezone)
        except ZoneInfoNotFoundError as exc:
            raise AnchorLinkFetchError(f"unknown event timezone: {timezone}") from exc

    def fetch(self, window: Window) -> list[SourceRecord]:
        """Fetch every API page for the target local day and map valid rows.

        The API is filtered server-side with ``benefitNames=FreeFood`` and is
        checked again row-by-row for the exact ``Free Food`` benefit. Listing
        failures and invalid response envelopes abort the run; this prevents a
        transient API problem from being published as a successful empty feed.
        """

        day_start = datetime.combine(window.target_date, time.min, self._timezone)
        day_end = datetime.combine(
            date.fromordinal(window.target_date.toordinal() + 1),
            time.min,
            self._timezone,
        )
        # startsAfter is exclusive, so include an event beginning at midnight.
        starts_after = day_start.astimezone(UTC) - timedelta(seconds=1)
        starts_before = day_end.astimezone(UTC)
        now = datetime.now(tz=UTC)

        records: list[SourceRecord] = []
        seen_ids: set[str] = set()
        malformed_rows = 0
        skip = 0
        pages_fetched = 0
        total: int | None = None

        while total is None or skip < total:
            if pages_fetched >= self._settings.max_pages:
                raise AnchorLinkFetchError(
                    "AnchorLink pagination exceeded safety limit"
                )
            query = urlencode(
                {
                    "benefitNames": self._settings.free_food_filter,
                    "startsAfter": _utc_query(starts_after),
                    "startsBefore": _utc_query(starts_before),
                    "take": self._settings.page_size,
                    "skip": skip,
                }
            )
            url = (
                f"{self._settings.base_url.rstrip('/')}"
                f"{self._settings.search_path}?{query}"
            )
            result = self._fetcher.get(url, timeout=self._settings.timeout_seconds)
            if not result.ok or result.text is None:
                detail = result.error or f"HTTP {result.status}"
                raise AnchorLinkFetchError(
                    f"AnchorLink discovery request failed at offset {skip}: {detail}"
                )
            payload = _decode_search_payload(result.text)
            page_total = int(payload["@odata.count"])
            values = payload["value"]
            if total is None:
                total = page_total
            else:
                # Counts can grow while pagination is in flight. Never lower the
                # target and silently accept an incomplete shrinking result.
                total = max(total, page_total)

            checked_at = datetime.now(tz=UTC)
            for item in values:
                try:
                    record = self._record_from_item(
                        item,
                        window=window,
                        checked_at=checked_at,
                        now=now,
                    )
                except (TypeError, ValueError):
                    malformed_rows += 1
                    continue
                if record is None:
                    continue
                external_id = record.id.removeprefix("anchorlink-")
                if external_id in seen_ids:
                    raise AnchorLinkFetchError(
                        "AnchorLink pagination returned a duplicate event id"
                    )
                seen_ids.add(external_id)
                records.append(record)

            page_length = len(values)
            pages_fetched += 1
            if page_length == 0:
                if skip < total:
                    raise AnchorLinkFetchError(
                        "AnchorLink pagination ended before the reported total"
                    )
                break
            skip += page_length

        if malformed_rows:
            raise AnchorLinkFetchError(
                "AnchorLink returned rows with an invalid public event schema"
            )
        return records

    def _record_from_item(
        self,
        item: object,
        *,
        window: Window,
        checked_at: datetime,
        now: datetime,
    ) -> SourceRecord | None:
        if not isinstance(item, dict):
            raise TypeError("event row is not an object")

        benefits = item.get("benefitNames")
        if not isinstance(benefits, list) or not all(
            isinstance(value, str) for value in benefits
        ):
            raise ValueError("invalid benefit names")
        if FREE_FOOD_PERK not in benefits:
            return None

        status = item.get("status")
        visibility = item.get("visibility")
        if not isinstance(status, str) or not isinstance(visibility, str):
            raise ValueError("missing event publication state")
        if status != "Approved" or visibility != "Public":
            return None
        if not _matches_identifier(
            item.get("institutionId"), self._settings.institution_id
        ):
            return None
        if not _matches_branch(item, self._settings.branch_id):
            return None

        external_id = str(item.get("id", ""))
        if _EVENT_ID.fullmatch(external_id) is None:
            raise ValueError("invalid event id")
        title = item.get("name")
        if not isinstance(title, str) or not title.strip():
            raise ValueError("missing event name")

        starts_on = _aware_datetime(item.get("startsOn"))
        ends_on = _aware_datetime(item.get("endsOn"))
        if ends_on <= starts_on:
            raise ValueError("event end is not after start")
        local_start = starts_on.astimezone(self._timezone)
        local_end = ends_on.astimezone(self._timezone)
        if local_start.date() != window.target_date:
            return None
        # A date-scoped feed contains the complete selected day's listings,
        # including events that ended earlier that day. This also keeps an
        # evening refresh from erasing the day's calendar and summary.

        event_url = f"{_CANONICAL_EVENT_BASE_URL}/event/{external_id}"
        description = _plain_text(item.get("description"))
        location = item.get("location")
        organizer = item.get("organizationName")
        parsed_fields: dict[str, Any] = {
            "title": title.strip(),
            "event_date": local_start.date().isoformat(),
            # The normalizer contract is local HH:MM, not a full ISO datetime.
            "start_time": local_start.strftime("%H:%M"),
            "end_time": local_end.strftime("%H:%M"),
            "location": location.strip() if isinstance(location, str) else None,
            "organizer": organizer.strip() if isinstance(organizer, str) else None,
            "event_url": event_url,
            "source_identity": f"anchorlink:{external_id}",
            "food_confirmed": "confirmed",
            "food_description": description or "AnchorLink Free Food perk",
            "status": status,
            "cancelled": False,
        }
        return SourceRecord(
            id=f"anchorlink-{external_id}",
            event_id="",
            source_id=SourceId.ANCHOR_LINK,
            source_url=event_url,
            raw_payload=json.dumps(item, sort_keys=True),
            parsed_fields=parsed_fields,
            checked_at=checked_at,
            parse_status=ParseStatus.OK,
            source_updated_at=None,
        )


def _decode_search_payload(text: str) -> dict[str, Any]:
    try:
        payload: Any = json.loads(text)
    except json.JSONDecodeError as exc:
        raise AnchorLinkFetchError("AnchorLink returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise AnchorLinkFetchError("AnchorLink response is not an object")
    total = payload.get("@odata.count")
    values = payload.get("value")
    if isinstance(total, bool) or not isinstance(total, int) or total < 0:
        raise AnchorLinkFetchError("AnchorLink response has no valid @odata.count")
    if not isinstance(values, list):
        raise AnchorLinkFetchError("AnchorLink response has no event list")
    return payload


def _aware_datetime(value: object) -> datetime:
    if not isinstance(value, str):
        raise ValueError("missing event timestamp")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("event timestamp has no timezone")
    return parsed


def _matches_identifier(value: object, expected: int) -> bool:
    return (
        isinstance(value, (int, str))
        and not isinstance(value, bool)
        and str(value) == str(expected)
    )


def _matches_branch(item: dict[str, Any], expected: int) -> bool:
    branch_id = item.get("branchId")
    branch_ids = item.get("branchIds")
    if _matches_identifier(branch_id, expected):
        return True
    if isinstance(branch_ids, list):
        return any(_matches_identifier(value, expected) for value in branch_ids)
    return False


def _utc_query(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        stripped = data.strip()
        if stripped:
            self.parts.append(stripped)


def _plain_text(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    parser = _TextExtractor()
    parser.feed(value)
    text = " ".join(parser.parts)
    return text or None


def _has_free_food_perk(raw_payload: str | None) -> bool:
    """Return whether an offline fixture lists the exact Free Food perk."""

    if not raw_payload:
        return False
    try:
        payload = json.loads(raw_payload)
    except json.JSONDecodeError:
        return False
    if not isinstance(payload, dict):
        return False
    perks = payload.get("perks")
    return isinstance(perks, list) and FREE_FOOD_PERK in perks


__all__ = [
    "AnchorLinkAdapter",
    "AnchorLinkFetchError",
    "FREE_FOOD_PERK",
    "LiveAnchorLinkAdapter",
]
