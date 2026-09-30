"""Offline :class:`HttpFetcher` backed by the fixture corpus (T2.2, design.md §9).

Resolves a ``source_url`` to its fixture payload using
:mod:`vandy_food_radar.fixtures` so the whole pipeline runs with no live
network. This is the injected default whenever ``config.offline`` is ``True``.

A URL not present in the corpus returns a :class:`FetchResult` marked as a fetch
error rather than raising, mirroring how a real fetcher reports an unreachable
page (FR-7, E-11).
"""

from __future__ import annotations

import json
from typing import Any

from ..fixtures import load_all_json_fixtures, load_text_fixture
from .base import FetchResult, HttpFetcher


class FixtureFetcher(HttpFetcher):
    """Serve fixture payloads keyed by their ``source_url`` (offline default).

    The corpus is loaded once at construction. For a JSON fixture the body is
    the fixture record re-serialized as JSON text; for an unparseable page whose
    fixture names a ``raw_payload_file`` the raw HTML is returned verbatim so an
    adapter still receives content and fails at the parse stage.
    """

    def __init__(self) -> None:
        self._by_url: dict[str, dict[str, Any]] = {}
        for record in load_all_json_fixtures().values():
            url = record.get("source_url")
            if isinstance(url, str):
                self._by_url[url] = record

    def get(self, url: str, *, timeout: float = 10.0) -> FetchResult:
        """Return the fixture body for ``url`` or a fetch-error result."""

        record = self._by_url.get(url)
        if record is None:
            return FetchResult(
                url=url,
                ok=False,
                status=404,
                error=f"No fixture registered for URL: {url}",
            )
        html_name = record.get("raw_payload_file")
        if isinstance(html_name, str):
            text = load_text_fixture(html_name)
        else:
            text = json.dumps(record, sort_keys=True)
        return FetchResult(url=url, ok=True, status=200, text=text)
