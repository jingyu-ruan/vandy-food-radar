"""Anchor Link source adapter (design.md §3, T2.2, FR-1/2).

Ingests Vanderbilt Anchor Link events, keeping only those whose raw payload
advertises the "Free Food" perk (FR-1). Reads through the injected fetcher so
the same adapter runs against the offline corpus or a live source.
"""

from __future__ import annotations

import json
from typing import Any

from ..models import ParseStatus, SourceId, SourceRecord
from ._common import build_source_record, corpus_records_for
from .base import HttpFetcher, Window

FREE_FOOD_PERK = "Free Food"


class AnchorLinkAdapter:
    """Emit :class:`SourceRecord` objects for Anchor Link free-food events."""

    source_id = SourceId.ANCHOR_LINK.value

    def __init__(self, fetcher: HttpFetcher) -> None:
        self._fetcher = fetcher

    def fetch(self, window: Window) -> list[SourceRecord]:
        """Return free-food Anchor Link records for ``window``.

        A record that fails to fetch/parse is still returned with a non-``ok``
        ``parse_status`` (it cannot be perk-filtered without a payload) so the
        run continues and the failure is visible downstream (FR-7).
        """

        records: list[SourceRecord] = []
        for raw in corpus_records_for(SourceId.ANCHOR_LINK):
            record = build_source_record(SourceId.ANCHOR_LINK, raw, self._fetcher)
            if record.parse_status is not ParseStatus.OK:
                records.append(record)
                continue
            if _has_free_food_perk(record.raw_payload):
                records.append(record)
        return records


def _has_free_food_perk(raw_payload: str | None) -> bool:
    """Return ``True`` when the raw payload lists the "Free Food" perk."""

    if not raw_payload:
        return False
    try:
        payload: Any = json.loads(raw_payload)
    except json.JSONDecodeError:
        return False
    if not isinstance(payload, dict):
        return False
    perks = payload.get("perks")
    if not isinstance(perks, list):
        return False
    return FREE_FOOD_PERK in perks
