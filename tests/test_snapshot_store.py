"""Offline tests for the SnapshotStore seam (M7-M9, FEAT-001).

Covers the JSON codec round-trip, the in-memory store, the Upstash store over
a FAKE HTTP client (no network), outage degradation, and the
:func:`build_snapshot_store` selector.
"""

from __future__ import annotations

import json
from datetime import date, time

from vandy_food_radar.config import Config
from vandy_food_radar.models import Event, VerificationState
from vandy_food_radar.store import (
    InMemorySnapshotStore,
    UpstashSnapshotStore,
    build_snapshot_store,
    events_from_json,
    events_to_json,
)
from vandy_food_radar.store.snapshot import SnapshotHttp

TARGET_DAY = date(2025, 3, 11)


def _build_event(
    *,
    identity_key: str,
    title: str,
    start_time: time | None = time(18, 0),
    location: str | None = "Hall A",
    verification_state: VerificationState = VerificationState.VERIFIED,
    score_total: float | None = 0.75,
) -> Event:
    return Event(
        id="ignored",
        dedup_key="ignored",
        title=title,
        event_date=TARGET_DAY,
        identity_key=identity_key,
        start_time=start_time,
        end_time=time(19, 0),
        location=location,
        verification_state=verification_state,
        score_total=score_total,
    )


class _FakeSnapshotHttp:
    """Records posted commands and returns canned responses (no network)."""

    def __init__(self, response: str | None = None) -> None:
        self.response = response
        self.calls: list[tuple[str, str, list[str]]] = []

    def post(self, url: str, token: str, command: list[str]) -> str | None:
        self.calls.append((url, token, command))
        return self.response


def test_codec_round_trip_preserves_change_fields() -> None:
    events = [
        _build_event(identity_key="k1", title="Free Pizza Night"),
        _build_event(
            identity_key="k2",
            title="Career Mixer",
            start_time=None,
            location=None,
            verification_state=VerificationState.CANCELLED,
            score_total=None,
        ),
    ]
    decoded = events_from_json(events_to_json(events))

    assert len(decoded) == 2
    for original, restored in zip(events, decoded, strict=True):
        assert restored.identity_key == original.identity_key
        assert restored.title == original.title
        assert restored.event_date == original.event_date
        assert restored.start_time == original.start_time
        assert restored.end_time == original.end_time
        assert restored.location == original.location
        assert restored.verification_state == original.verification_state
        assert restored.score_total == original.score_total


def test_codec_is_deterministic() -> None:
    events = [_build_event(identity_key="k1", title="Free Pizza Night")]
    assert events_to_json(events) == events_to_json(events)


def test_in_memory_store_save_load_and_missing_date() -> None:
    store = InMemorySnapshotStore()
    events = [_build_event(identity_key="k1", title="Free Pizza Night")]

    assert store.load_snapshot(TARGET_DAY) is None

    store.save_snapshot(TARGET_DAY, events)
    loaded = store.load_snapshot(TARGET_DAY)
    assert loaded is not None
    assert len(loaded) == 1
    assert loaded[0].identity_key == "k1"
    assert loaded[0].title == "Free Pizza Night"

    assert store.load_snapshot(date(2025, 3, 12)) is None


def test_upstash_save_posts_set_command() -> None:
    http = _FakeSnapshotHttp()
    store = UpstashSnapshotStore("https://kv", "tok", http=http)
    events = [_build_event(identity_key="k1", title="Free Pizza Night")]

    store.save_snapshot(TARGET_DAY, events)

    assert len(http.calls) == 1
    url, token, command = http.calls[0]
    assert url == "https://kv"
    assert token == "tok"
    assert command[0] == "SET"
    assert command[1] == "vfr:snapshot:2025-03-11"
    assert command[2] == events_to_json(events)


def test_upstash_load_decodes_result_envelope() -> None:
    events = [_build_event(identity_key="k1", title="Free Pizza Night")]
    envelope = json.dumps({"result": events_to_json(events)})
    http = _FakeSnapshotHttp(response=envelope)
    store = UpstashSnapshotStore("https://kv", "tok", http=http)

    loaded = store.load_snapshot(TARGET_DAY)

    assert http.calls[0][2] == ["GET", "vfr:snapshot:2025-03-11"]
    assert loaded is not None
    assert loaded[0].identity_key == "k1"


def test_upstash_load_returns_none_on_http_none() -> None:
    http = _FakeSnapshotHttp(response=None)
    store = UpstashSnapshotStore("https://kv", "tok", http=http)
    assert store.load_snapshot(TARGET_DAY) is None


def test_upstash_load_returns_none_on_null_result() -> None:
    http = _FakeSnapshotHttp(response=json.dumps({"result": None}))
    store = UpstashSnapshotStore("https://kv", "tok", http=http)
    assert store.load_snapshot(TARGET_DAY) is None


def test_build_snapshot_store_selects_in_memory_when_unset() -> None:
    config = Config.from_env({})
    store = build_snapshot_store(config)
    assert isinstance(store, InMemorySnapshotStore)


def test_build_snapshot_store_selects_upstash_when_both_set() -> None:
    config = Config.from_env(
        {
            "UPSTASH_REDIS_REST_URL": "https://kv",
            "UPSTASH_REDIS_REST_TOKEN": "tok",
        }
    )
    store = build_snapshot_store(config)
    assert isinstance(store, UpstashSnapshotStore)


def test_snapshot_http_protocol_is_satisfied() -> None:
    fake: SnapshotHttp = _FakeSnapshotHttp()
    assert fake.post("u", "t", ["GET", "k"]) is None
