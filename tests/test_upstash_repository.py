"""Tests for the durable Upstash-backed repository.

Live mode has one non-negotiable property: a refresh either publishes the whole
repository or it fails loudly. These tests drive that through a fake Redis so
there is no network, covering:

* a complete round trip (events plus source records, provenance, conflicts,
  score components, and history) across two independent instances;
* compare-and-set: a second instance that loaded the older revision is refused
  rather than allowed to overwrite a newer feed;
* every corrupt-snapshot shape raising :class:`DurableRepositoryError` instead
  of degrading into an empty or partial feed;
* transport and Upstash-level errors surfacing as the same explicit failure.
"""

from __future__ import annotations

import base64
import json
import sqlite3
import urllib.error
from datetime import UTC, datetime
from typing import Any

from vandy_food_radar.models import (
    CompetingValue,
    Conflict,
    EventHistory,
    FieldAgreement,
    FieldProvenance,
    ScoreComponent,
    ScoreFactor,
    SourceId,
    SourceRecord,
)
from vandy_food_radar.store import DurableRepositoryError, UpstashSqliteRepository

from .support import DEMO_DAY, make_event

REST_URL = "https://example-upstash.invalid"
REST_TOKEN = "fake-token"


class FakeRedis:
    """The two string keys the durable repository actually uses."""

    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.publishes = 0
        self.rejected_publishes = 0


class FakeUpstashRepository(UpstashSqliteRepository):
    """Durable repository wired to :class:`FakeRedis` instead of HTTP.

    Only the single ``_command`` transport method is replaced; the load,
    publish, validation, and compare-and-set logic under test is the real one.
    """

    def __init__(self, redis: FakeRedis) -> None:
        self._redis = redis
        super().__init__(REST_URL, REST_TOKEN)

    def _command(self, command: list[str]) -> object:
        assert command[0] == "EVAL"
        data_key, revision_key = command[3], command[4]
        if len(command) == 5:  # load
            return [
                self._redis.values.get(data_key, False),
                self._redis.values.get(revision_key, False),
            ]
        expected, encoded, new_revision = command[5], command[6], command[7]
        if self._redis.values.get(revision_key, "") != expected:
            self._redis.rejected_publishes += 1
            return 0
        self._redis.values[data_key] = encoded
        self._redis.values[revision_key] = new_revision
        self._redis.publishes += 1
        return 1


def _encode(database: bytes) -> str:
    return base64.b64encode(database).decode("ascii")


def _serialized_sqlite(script: str) -> bytes:
    connection = sqlite3.connect(":memory:")
    try:
        connection.executescript(script)
        connection.commit()
        return bytes(connection.serialize())
    finally:
        connection.close()


def _save_full_event(repository: UpstashSqliteRepository) -> None:
    """Persist one event together with every kind of child row."""

    event = make_event()
    record = SourceRecord(
        id="src-1",
        event_id=event.id,
        source_id=SourceId.ANCHOR_LINK,
        source_url="https://anchorlink.vanderbilt.edu/event/1",
        raw_payload='{"description": "Pizza and salad."}',
        parsed_fields={"title": event.title},
        checked_at=datetime(2025, 3, 11, 10, 0, tzinfo=UTC),
    )
    provenance = FieldProvenance(
        id="prov-1",
        event_id=event.id,
        field_name="start_time",
        chosen_value="18:00:00",
        chosen_source_id=SourceId.ANCHOR_LINK,
        agreement=FieldAgreement.SINGLE_SOURCE,
    )
    conflict = Conflict(
        id="conf-1",
        event_id=event.id,
        field_name="location",
        competing_values=[
            CompetingValue(value="Sarratt 216", source_id=SourceId.ANCHOR_LINK),
            CompetingValue(value="Sarratt 220", source_id=SourceId.OFFICIAL_PAGE),
        ],
        resolution="kept the official page value",
    )
    component = ScoreComponent(
        id="score-1",
        event_id=event.id,
        factor=ScoreFactor.FULL_MEAL,
        raw_value=1.0,
        weight=0.25,
        contribution=0.25,
        note="full meal",
    )
    repository.save_event(event, [record], [provenance], [conflict], [component])
    repository.append_history(
        EventHistory(
            id="hist-1",
            event_id=event.id,
            changed_at=datetime(2025, 3, 11, 11, 0, tzinfo=UTC),
            field_name="start_time",
            old_value="17:00:00",
            new_value="18:00:00",
            reason="value changed on re-run",
        )
    )


# ---------------------------------------------------------------------------
# construction
# ---------------------------------------------------------------------------


def test_missing_credentials_are_refused() -> None:
    for url, token in (("", REST_TOKEN), (REST_URL, ""), ("", "")):
        try:
            UpstashSqliteRepository(url, token)
        except DurableRepositoryError as exc:
            assert "UPSTASH_REDIS_REST_URL" in str(exc)
            continue
        raise AssertionError("missing credentials should have been refused")


def test_an_empty_store_loads_a_usable_empty_repository() -> None:
    redis = FakeRedis()
    repository = FakeUpstashRepository(redis)
    try:
        assert repository.get_events_for_day(DEMO_DAY) == []
        assert repository.stored_days() == []
        assert redis.values == {}
    finally:
        repository.close()


# ---------------------------------------------------------------------------
# publication round trip
# ---------------------------------------------------------------------------


def test_nothing_is_published_until_flush() -> None:
    redis = FakeRedis()
    repository = FakeUpstashRepository(redis)
    try:
        _save_full_event(repository)
        assert redis.values == {}
        assert redis.publishes == 0

        repository.flush()
        assert redis.publishes == 1
        assert set(redis.values) == {
            "vfr:repository:v1",
            "vfr:repository:v1:revision",
        }
    finally:
        repository.close()


def test_a_second_instance_sees_the_complete_published_repository() -> None:
    redis = FakeRedis()
    writer = FakeUpstashRepository(redis)
    try:
        _save_full_event(writer)
        writer.flush()
    finally:
        writer.close()

    reader = FakeUpstashRepository(redis)
    try:
        events = reader.get_events_for_day(DEMO_DAY)
        assert [event.title for event in events] == ["Free Pizza Night"]
        event = events[0]

        records = reader.get_source_records(event.id)
        assert [record.source_url for record in records] == [
            "https://anchorlink.vanderbilt.edu/event/1"
        ]
        assert records[0].raw_payload is not None
        assert "Pizza and salad." in records[0].raw_payload

        conflicts = reader.get_conflicts(event.id)
        assert [value.value for value in conflicts[0].competing_values] == [
            "Sarratt 216",
            "Sarratt 220",
        ]
        assert [c.factor for c in reader.get_score_components(event.id)] == [
            ScoreFactor.FULL_MEAL
        ]
        history = reader.get_history(event.id)
        assert [entry.field_name for entry in history] == ["start_time"]
        assert history[0].new_value == "18:00:00"
    finally:
        reader.close()


def test_metadata_survives_publication() -> None:
    redis = FakeRedis()
    writer = FakeUpstashRepository(redis)
    try:
        writer.set_metadata("refresh:last_success_at", "2025-03-11T17:00:00+00:00")
        writer.flush()
    finally:
        writer.close()

    reader = FakeUpstashRepository(redis)
    try:
        assert reader.get_metadata("refresh:last_success_at") == (
            "2025-03-11T17:00:00+00:00"
        )
        assert reader.get_metadata("missing") is None
    finally:
        reader.close()


def test_reload_adopts_a_feed_published_by_another_invocation() -> None:
    redis = FakeRedis()
    reader = FakeUpstashRepository(redis)
    writer = FakeUpstashRepository(redis)
    try:
        _save_full_event(writer)
        writer.flush()

        assert reader.get_events_for_day(DEMO_DAY) == []
        reader.reload()
        assert len(reader.get_events_for_day(DEMO_DAY)) == 1
    finally:
        reader.close()
        writer.close()


# ---------------------------------------------------------------------------
# compare-and-set
# ---------------------------------------------------------------------------


def test_a_stale_instance_cannot_overwrite_a_newer_feed() -> None:
    redis = FakeRedis()
    first = FakeUpstashRepository(redis)
    second = FakeUpstashRepository(redis)
    try:
        _save_full_event(first)
        first.flush()

        # ``second`` loaded before the publication, so its revision is stale.
        second.set_metadata("stale", "yes")
        try:
            second.flush()
        except DurableRepositoryError as exc:
            assert "changed during refresh" in str(exc)
        else:
            raise AssertionError("a stale publication should have been refused")

        assert redis.publishes == 1
        assert redis.rejected_publishes == 1

        # The published feed is still the first instance's work.
        verifier = FakeUpstashRepository(redis)
        try:
            assert len(verifier.get_events_for_day(DEMO_DAY)) == 1
            assert verifier.get_metadata("stale") is None
        finally:
            verifier.close()
    finally:
        first.close()
        second.close()


def test_a_reloaded_instance_can_publish_again() -> None:
    redis = FakeRedis()
    first = FakeUpstashRepository(redis)
    second = FakeUpstashRepository(redis)
    try:
        _save_full_event(first)
        first.flush()

        second.reload()
        second.set_metadata("after-reload", "yes")
        second.flush()
        assert redis.publishes == 2

        verifier = FakeUpstashRepository(redis)
        try:
            assert verifier.get_metadata("after-reload") == "yes"
        finally:
            verifier.close()
    finally:
        first.close()
        second.close()


def test_consecutive_publications_from_one_instance_succeed() -> None:
    redis = FakeRedis()
    repository = FakeUpstashRepository(redis)
    try:
        _save_full_event(repository)
        repository.flush()
        repository.set_metadata("second", "pass")
        repository.flush()
        assert redis.publishes == 2
        assert redis.rejected_publishes == 0
    finally:
        repository.close()


# ---------------------------------------------------------------------------
# corrupt snapshots fail loudly
# ---------------------------------------------------------------------------


def _expect_load_error(redis: FakeRedis, fragment: str) -> None:
    try:
        FakeUpstashRepository(redis)
    except DurableRepositoryError as exc:
        assert fragment in str(exc), f"expected {fragment!r} in {exc}"
    else:
        raise AssertionError(f"expected a load failure mentioning {fragment!r}")


def test_a_revision_without_repository_data_is_an_error() -> None:
    redis = FakeRedis()
    redis.values["vfr:repository:v1:revision"] = "abc123"
    _expect_load_error(redis, "revision exists without repository data")


def test_invalid_base64_is_an_error() -> None:
    redis = FakeRedis()
    redis.values["vfr:repository:v1"] = "not base64 !!"
    _expect_load_error(redis, "invalid base64")


def test_non_sqlite_bytes_are_an_error() -> None:
    redis = FakeRedis()
    redis.values["vfr:repository:v1"] = _encode(b"this is not a database")
    _expect_load_error(redis, "invalid SQLite snapshot")


def test_a_snapshot_with_an_incompatible_schema_is_an_error() -> None:
    redis = FakeRedis()
    redis.values["vfr:repository:v1"] = _encode(
        _serialized_sqlite("CREATE TABLE unrelated (id TEXT PRIMARY KEY);")
    )
    _expect_load_error(redis, "incompatible SQLite schema")


def test_an_invalid_load_envelope_is_an_error() -> None:
    class _BadShape(FakeUpstashRepository):
        def _command(self, command: list[str]) -> object:
            return "not-a-pair"

    try:
        _BadShape(FakeRedis())
    except DurableRepositoryError as exc:
        assert "invalid durable repository snapshot" in str(exc)
    else:
        raise AssertionError("a malformed EVAL result should have been refused")


def test_a_non_text_repository_value_is_an_error() -> None:
    class _NumericValue(FakeUpstashRepository):
        def _command(self, command: list[str]) -> object:
            return [12345, "rev"]

    try:
        _NumericValue(FakeRedis())
    except DurableRepositoryError as exc:
        assert "not text" in str(exc)
    else:
        raise AssertionError("a non-text repository value should have been refused")


def test_an_unconfirmed_publication_is_an_error() -> None:
    redis = FakeRedis()

    class _SilentPublish(FakeUpstashRepository):
        def _command(self, command: list[str]) -> object:
            if len(command) == 5:
                return super()._command(command)
            return None

    repository = _SilentPublish(redis)
    try:
        try:
            repository.flush()
        except DurableRepositoryError as exc:
            assert "did not confirm" in str(exc)
        else:
            raise AssertionError("an unconfirmed publication should have raised")
    finally:
        repository.close()


# ---------------------------------------------------------------------------
# transport errors
# ---------------------------------------------------------------------------


def test_a_transport_failure_surfaces_as_a_durable_error(
    monkeypatch: Any,
) -> None:
    def _boom(*_args: object, **_kwargs: object) -> object:
        raise urllib.error.URLError("no route to host")

    monkeypatch.setattr(
        "vandy_food_radar.store.upstash_repository.urllib.request.urlopen", _boom
    )
    try:
        UpstashSqliteRepository(REST_URL, REST_TOKEN)
    except DurableRepositoryError as exc:
        assert "could not reach" in str(exc)
    else:
        raise AssertionError("a transport failure should have raised")


def test_an_upstash_error_envelope_surfaces_as_a_durable_error(
    monkeypatch: Any,
) -> None:
    class _Response:
        def __enter__(self) -> _Response:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def read(self) -> bytes:
            return json.dumps({"error": "WRONGPASS invalid credentials"}).encode()

    monkeypatch.setattr(
        "vandy_food_radar.store.upstash_repository.urllib.request.urlopen",
        lambda *_args, **_kwargs: _Response(),
    )
    try:
        UpstashSqliteRepository(REST_URL, REST_TOKEN)
    except DurableRepositoryError as exc:
        assert "WRONGPASS" in str(exc)
    else:
        raise AssertionError("an Upstash error envelope should have raised")


def test_a_non_json_response_surfaces_as_a_durable_error(monkeypatch: Any) -> None:
    class _Response:
        def __enter__(self) -> _Response:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def read(self) -> bytes:
            return b"<html>503</html>"

    monkeypatch.setattr(
        "vandy_food_radar.store.upstash_repository.urllib.request.urlopen",
        lambda *_args, **_kwargs: _Response(),
    )
    try:
        UpstashSqliteRepository(REST_URL, REST_TOKEN)
    except DurableRepositoryError as exc:
        assert "invalid repository response" in str(exc)
    else:
        raise AssertionError("a non-JSON response should have raised")
