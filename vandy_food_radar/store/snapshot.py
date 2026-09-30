"""Cross-run snapshot store: the storage seam for stateless-serverless runs.

The serverless request path is stateless, so cross-session change detection
cannot rely on SQLite persisting between invocations. Instead each run stores
the change-relevant fields of that run's canonical events per target date in a
:class:`SnapshotStore`, and the next run compares against it.

Two implementations back the same :class:`SnapshotStore` protocol:

* :class:`InMemorySnapshotStore` — the offline default (process-local dict).
* :class:`UpstashSnapshotStore` — Upstash Redis over its REST API using the
  stdlib :mod:`urllib.request` (no new dependency). A KV outage degrades to
  "no snapshot" (load returns ``None``, save is best-effort) and never raises.

Only the fields that drive change detection are serialized (identity_key,
title, event_date, start/end time, location, verification_state, score_total);
all other :class:`~vandy_food_radar.models.Event` fields are left at their
dataclass defaults on decode. Coercions mirror
:func:`vandy_food_radar.pipeline.orchestrator._tracked_value`.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import date, time
from typing import Protocol

from ..config import Config
from ..models import Event, VerificationState

# Redis key namespace for per-date snapshots.
_KEY_PREFIX = "vfr:snapshot:"
# Short timeout so a slow/unreachable KV never blocks a request.
_HTTP_TIMEOUT_SECONDS = 5.0


def _snapshot_key(target_date: date) -> str:
    """Return the Redis key holding the snapshot for ``target_date``."""

    return f"{_KEY_PREFIX}{target_date.isoformat()}"


# ---------------------------------------------------------------------------
# JSON codec for the change-detection fields (pure, no I/O)
# ---------------------------------------------------------------------------


def _time_iso(value: time | None) -> str | None:
    """ISO string for a time, or ``None`` (mirrors ``_tracked_value``)."""

    return value.isoformat() if value is not None else None


def _time_from_iso(value: str | None) -> time | None:
    """Parse an ISO time string back to :class:`time`, or ``None``."""

    return time.fromisoformat(value) if value is not None else None


def events_to_json(events: list[Event]) -> str:
    """Serialize the change-detection fields of ``events`` to a JSON string.

    Only the fields that :mod:`vandy_food_radar.pipeline.change_detect` reads
    are included. Uses ``sort_keys=True`` for deterministic output.
    """

    payload = [
        {
            "identity_key": event.identity_key,
            "title": event.title,
            "event_date": event.event_date.isoformat(),
            "start_time": _time_iso(event.start_time),
            "end_time": _time_iso(event.end_time),
            "location": event.location,
            "verification_state": event.verification_state.value,
            "score_total": event.score_total,
        }
        for event in events
    ]
    return json.dumps(payload, sort_keys=True)


def events_from_json(text: str) -> list[Event]:
    """Reconstruct events from :func:`events_to_json` output.

    Rebuilds only the change-detection fields; every other
    :class:`~vandy_food_radar.models.Event` field stays at its dataclass
    default.
    """

    payload = json.loads(text)
    events: list[Event] = []
    for item in payload:
        events.append(
            Event(
                id="",
                dedup_key="",
                title=item["title"],
                event_date=date.fromisoformat(item["event_date"]),
                identity_key=item["identity_key"],
                start_time=_time_from_iso(item["start_time"]),
                end_time=_time_from_iso(item["end_time"]),
                location=item["location"],
                verification_state=VerificationState(item["verification_state"]),
                score_total=item["score_total"],
            )
        )
    return events


# ---------------------------------------------------------------------------
# Snapshot store protocol + implementations
# ---------------------------------------------------------------------------


class SnapshotStore(Protocol):
    """Boundary for storing/loading the previous run's canonical events."""

    def save_snapshot(self, target_date: date, events: list[Event]) -> None:
        """Store ``events`` as the snapshot for ``target_date`` (best-effort)."""
        ...

    def load_snapshot(self, target_date: date) -> list[Event] | None:
        """Return the stored snapshot for ``target_date``, or ``None``."""
        ...


class InMemorySnapshotStore:
    """Process-local snapshot store (the offline default).

    Round-trips through the JSON codec so its behavior matches the Upstash
    store (e.g. non-change fields are dropped on load).
    """

    def __init__(self) -> None:
        self._store: dict[str, str] = {}

    def save_snapshot(self, target_date: date, events: list[Event]) -> None:
        """Store the encoded snapshot keyed by ``target_date``."""

        self._store[target_date.isoformat()] = events_to_json(events)

    def load_snapshot(self, target_date: date) -> list[Event] | None:
        """Return the decoded snapshot for ``target_date``, or ``None``."""

        text = self._store.get(target_date.isoformat())
        if text is None:
            return None
        return events_from_json(text)


class SnapshotHttp(Protocol):
    """Minimal HTTP seam for the Upstash REST call (injected for tests)."""

    def post(self, url: str, token: str, command: list[str]) -> str | None:
        """POST ``command`` to Upstash; return the body text or ``None``."""
        ...


class _UrllibSnapshotHttp:
    """Default :class:`SnapshotHttp` over stdlib :mod:`urllib.request`.

    Returns the response body text, or ``None`` on any error (URLError,
    HTTPError, timeout, decoding) so a KV outage never propagates.
    """

    def post(self, url: str, token: str, command: list[str]) -> str | None:
        """POST the Upstash command; swallow all errors and return ``None``."""

        data = json.dumps(command).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(
                request, timeout=_HTTP_TIMEOUT_SECONDS
            ) as response:
                body: str = response.read().decode("utf-8")
                return body
        except (urllib.error.URLError, TimeoutError, ValueError, OSError):
            return None


class UpstashSnapshotStore:
    """Snapshot store backed by Upstash Redis over its REST API.

    ``save`` issues ``SET`` (best-effort; swallows failure) and ``load`` issues
    ``GET`` and parses the Upstash envelope ``{"result": <json-string|null>}``.
    Any HTTP/JSON error or missing/null result yields ``None`` from load, so a
    KV outage degrades to "no snapshot" (all events NEW) instead of raising.
    """

    def __init__(
        self,
        rest_url: str,
        rest_token: str,
        *,
        http: SnapshotHttp | None = None,
    ) -> None:
        self._rest_url = rest_url
        self._rest_token = rest_token
        self._http: SnapshotHttp = http if http is not None else _UrllibSnapshotHttp()

    def save_snapshot(self, target_date: date, events: list[Event]) -> None:
        """Best-effort ``SET`` of the encoded snapshot; never raises."""

        command = ["SET", _snapshot_key(target_date), events_to_json(events)]
        self._http.post(self._rest_url, self._rest_token, command)

    def load_snapshot(self, target_date: date) -> list[Event] | None:
        """``GET`` and decode the snapshot; return ``None`` on any failure."""

        command = ["GET", _snapshot_key(target_date)]
        body = self._http.post(self._rest_url, self._rest_token, command)
        if body is None:
            return None
        try:
            envelope = json.loads(body)
            result = envelope.get("result")
            if result is None:
                return None
            return events_from_json(result)
        except (ValueError, AttributeError, KeyError):
            return None


def build_snapshot_store(config: Config) -> SnapshotStore:
    """Select the snapshot store for ``config``.

    Returns :class:`UpstashSnapshotStore` only when both the Upstash REST URL
    and token are non-empty; otherwise the offline
    :class:`InMemorySnapshotStore`.
    """

    url = config.snapshot.upstash_rest_url
    token = config.snapshot.upstash_rest_token
    if url and token:
        return UpstashSnapshotStore(url, token)
    return InMemorySnapshotStore()
