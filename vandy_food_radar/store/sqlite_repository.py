"""SQLite implementation of the :class:`Repository` protocol (design.md §2.2, T1.2).

Uses only the standard-library :mod:`sqlite3`. Every entity from
:mod:`vandy_food_radar.models` is persisted, keeping enough per-source detail
(raw payload, parsed fields, per-source timestamps, provenance, conflicts) to
explain how each normalized record was produced (FR-31, FR-32).

Writes are idempotent: :meth:`SqliteRepository.save_event` upserts the event by
``dedup_key`` inside one transaction and replaces the event's child rows, so a
repeated scheduled run never duplicates events or their attached records
(FR-42, AC-10). Values are serialized deterministically to text (ISO strings
for date/time/datetime, ``.value`` for enums, JSON for structured fields).
"""

from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, time
from typing import Any

from ..models import (
    CompetingValue,
    Conflict,
    Event,
    EventHistory,
    FieldProvenance,
    FoodCategory,
    FoodConfirmed,
    GeoPoint,
    ParseStatus,
    ScoreComponent,
    ScoreFactor,
    SourceId,
    SourceRecord,
    VerificationState,
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    dedup_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    event_date TEXT NOT NULL,
    start_time TEXT,
    end_time TEXT,
    location TEXT,
    location_lat REAL,
    location_lng REAL,
    organizer TEXT,
    rsvp_required INTEGER,
    rsvp_url TEXT,
    rsvp_link_ok INTEGER,
    event_url TEXT,
    food_confirmed TEXT NOT NULL,
    food_category TEXT NOT NULL,
    food_description TEXT,
    verification_state TEXT NOT NULL,
    confidence REAL,
    score_total REAL,
    created_at TEXT,
    updated_at TEXT
);

CREATE TABLE IF NOT EXISTS source_records (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    source_url TEXT,
    raw_payload TEXT,
    parsed_fields TEXT NOT NULL,
    checked_at TEXT,
    parse_status TEXT NOT NULL,
    source_updated_at TEXT
);

CREATE TABLE IF NOT EXISTS field_provenance (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    field_name TEXT NOT NULL,
    chosen_value TEXT,
    chosen_source_id TEXT,
    agreement TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conflicts (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    field_name TEXT NOT NULL,
    competing_values TEXT NOT NULL,
    resolution TEXT
);

CREATE TABLE IF NOT EXISTS score_components (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    factor TEXT NOT NULL,
    raw_value REAL,
    weight REAL NOT NULL,
    contribution REAL NOT NULL,
    note TEXT
);

CREATE TABLE IF NOT EXISTS event_history (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    changed_at TEXT NOT NULL,
    field_name TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    reason TEXT
);
"""


class SqliteRepository:
    """SQLite-backed :class:`Repository` implementation.

    Pass an on-disk path or ``":memory:"``. The schema is created on first
    use. Foreign keys with cascade delete keep child rows consistent when an
    event's records are replaced during an upsert.
    """

    def __init__(self, db_path: str = ":memory:") -> None:
        self._conn = sqlite3.connect(db_path)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def close(self) -> None:
        """Close the underlying connection."""
        self._conn.close()

    # ------------------------------------------------------------------
    # Writes
    # ------------------------------------------------------------------

    def save_event(
        self,
        event: Event,
        source_records: list[SourceRecord],
        provenance: list[FieldProvenance],
        conflicts: list[Conflict],
        score_components: list[ScoreComponent],
    ) -> None:
        """Upsert the event (by ``dedup_key``) and replace its child rows."""
        with self._conn:  # one transaction; commits on success, rolls back on error
            self._conn.execute(
                """
                INSERT INTO events (
                    id, dedup_key, title, event_date, start_time, end_time,
                    location, location_lat, location_lng, organizer,
                    rsvp_required, rsvp_url, rsvp_link_ok, event_url,
                    food_confirmed, food_category, food_description,
                    verification_state, confidence, score_total,
                    created_at, updated_at
                ) VALUES (
                    :id, :dedup_key, :title, :event_date, :start_time, :end_time,
                    :location, :location_lat, :location_lng, :organizer,
                    :rsvp_required, :rsvp_url, :rsvp_link_ok, :event_url,
                    :food_confirmed, :food_category, :food_description,
                    :verification_state, :confidence, :score_total,
                    :created_at, :updated_at
                )
                ON CONFLICT(dedup_key) DO UPDATE SET
                    title = excluded.title,
                    event_date = excluded.event_date,
                    start_time = excluded.start_time,
                    end_time = excluded.end_time,
                    location = excluded.location,
                    location_lat = excluded.location_lat,
                    location_lng = excluded.location_lng,
                    organizer = excluded.organizer,
                    rsvp_required = excluded.rsvp_required,
                    rsvp_url = excluded.rsvp_url,
                    rsvp_link_ok = excluded.rsvp_link_ok,
                    event_url = excluded.event_url,
                    food_confirmed = excluded.food_confirmed,
                    food_category = excluded.food_category,
                    food_description = excluded.food_description,
                    verification_state = excluded.verification_state,
                    confidence = excluded.confidence,
                    score_total = excluded.score_total,
                    updated_at = excluded.updated_at
                """,
                self._event_params(event),
            )
            # Canonical event id keyed on dedup_key (may differ from event.id
            # on a repeat run); child rows reference the persisted id.
            row = self._conn.execute(
                "SELECT id FROM events WHERE dedup_key = ?", (event.dedup_key,)
            ).fetchone()
            event_id = str(row["id"])

            # Replace child rows so re-runs never duplicate them (FR-42).
            for table in (
                "source_records",
                "field_provenance",
                "conflicts",
                "score_components",
            ):
                self._conn.execute(
                    f"DELETE FROM {table} WHERE event_id = ?", (event_id,)
                )

            self._conn.executemany(
                """
                INSERT INTO source_records (
                    id, event_id, source_id, source_url, raw_payload,
                    parsed_fields, checked_at, parse_status, source_updated_at
                ) VALUES (
                    :id, :event_id, :source_id, :source_url, :raw_payload,
                    :parsed_fields, :checked_at, :parse_status, :source_updated_at
                )
                """,
                [self._source_record_params(r, event_id) for r in source_records],
            )
            self._conn.executemany(
                """
                INSERT INTO field_provenance (
                    id, event_id, field_name, chosen_value, chosen_source_id,
                    agreement
                ) VALUES (
                    :id, :event_id, :field_name, :chosen_value, :chosen_source_id,
                    :agreement
                )
                """,
                [self._provenance_params(p, event_id) for p in provenance],
            )
            self._conn.executemany(
                """
                INSERT INTO conflicts (
                    id, event_id, field_name, competing_values, resolution
                ) VALUES (
                    :id, :event_id, :field_name, :competing_values, :resolution
                )
                """,
                [self._conflict_params(c, event_id) for c in conflicts],
            )
            self._conn.executemany(
                """
                INSERT INTO score_components (
                    id, event_id, factor, raw_value, weight, contribution, note
                ) VALUES (
                    :id, :event_id, :factor, :raw_value, :weight, :contribution,
                    :note
                )
                """,
                [self._score_component_params(s, event_id) for s in score_components],
            )

    def append_history(self, entry: EventHistory) -> None:
        """Append one history row (never replaced), recording a change."""
        with self._conn:
            self._conn.execute(
                """
                INSERT INTO event_history (
                    id, event_id, changed_at, field_name, old_value, new_value,
                    reason
                ) VALUES (
                    :id, :event_id, :changed_at, :field_name, :old_value,
                    :new_value, :reason
                )
                """,
                {
                    "id": entry.id,
                    "event_id": entry.event_id,
                    "changed_at": _dt(entry.changed_at),
                    "field_name": entry.field_name,
                    "old_value": _json_or_none(entry.old_value),
                    "new_value": _json_or_none(entry.new_value),
                    "reason": entry.reason,
                },
            )

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def get_events_for_day(self, day: date) -> list[Event]:
        """Return events on ``day`` ordered by score (desc) then title."""
        rows = self._conn.execute(
            """
            SELECT * FROM events WHERE event_date = ?
            ORDER BY score_total DESC NULLS LAST, title ASC
            """,
            (day.isoformat(),),
        ).fetchall()
        return [self._row_to_event(r) for r in rows]

    def find_by_dedup_key(self, key: str) -> Event | None:
        """Return the event with ``dedup_key == key``, or ``None``."""
        row = self._conn.execute(
            "SELECT * FROM events WHERE dedup_key = ?", (key,)
        ).fetchone()
        return self._row_to_event(row) if row is not None else None

    def get_conflicts(self, event_id: str) -> list[Conflict]:
        """Return recorded conflicts for an event."""
        rows = self._conn.execute(
            "SELECT * FROM conflicts WHERE event_id = ? ORDER BY id", (event_id,)
        ).fetchall()
        return [self._row_to_conflict(r) for r in rows]

    def get_score_components(self, event_id: str) -> list[ScoreComponent]:
        """Return the score components for an event."""
        rows = self._conn.execute(
            "SELECT * FROM score_components WHERE event_id = ? ORDER BY id",
            (event_id,),
        ).fetchall()
        return [self._row_to_score_component(r) for r in rows]

    def get_source_records(self, event_id: str) -> list[SourceRecord]:
        """Return the per-source records for an event."""
        rows = self._conn.execute(
            "SELECT * FROM source_records WHERE event_id = ? ORDER BY id",
            (event_id,),
        ).fetchall()
        return [self._row_to_source_record(r) for r in rows]

    def get_history(self, event_id: str) -> list[EventHistory]:
        """Return the change history for an event, oldest first."""
        rows = self._conn.execute(
            """
            SELECT * FROM event_history WHERE event_id = ?
            ORDER BY changed_at ASC, id ASC
            """,
            (event_id,),
        ).fetchall()
        return [self._row_to_history(r) for r in rows]

    # ------------------------------------------------------------------
    # Row <-> entity mapping
    # ------------------------------------------------------------------

    @staticmethod
    def _event_params(event: Event) -> dict[str, Any]:
        geo = event.location_geo
        return {
            "id": event.id,
            "dedup_key": event.dedup_key,
            "title": event.title,
            "event_date": event.event_date.isoformat(),
            "start_time": _t(event.start_time),
            "end_time": _t(event.end_time),
            "location": event.location,
            "location_lat": geo.lat if geo is not None else None,
            "location_lng": geo.lng if geo is not None else None,
            "organizer": event.organizer,
            "rsvp_required": _bool(event.rsvp_required),
            "rsvp_url": event.rsvp_url,
            "rsvp_link_ok": _bool(event.rsvp_link_ok),
            "event_url": event.event_url,
            "food_confirmed": event.food_confirmed.value,
            "food_category": event.food_category.value,
            "food_description": event.food_description,
            "verification_state": event.verification_state.value,
            "confidence": event.confidence,
            "score_total": event.score_total,
            "created_at": _dt(event.created_at),
            "updated_at": _dt(event.updated_at),
        }

    @staticmethod
    def _source_record_params(record: SourceRecord, event_id: str) -> dict[str, Any]:
        return {
            "id": record.id,
            "event_id": event_id,
            "source_id": record.source_id.value,
            "source_url": record.source_url,
            "raw_payload": record.raw_payload,
            "parsed_fields": json.dumps(record.parsed_fields, sort_keys=True),
            "checked_at": _dt(record.checked_at),
            "parse_status": record.parse_status.value,
            "source_updated_at": _dt(record.source_updated_at),
        }

    @staticmethod
    def _provenance_params(prov: FieldProvenance, event_id: str) -> dict[str, Any]:
        return {
            "id": prov.id,
            "event_id": event_id,
            "field_name": prov.field_name,
            "chosen_value": _json_or_none(prov.chosen_value),
            "chosen_source_id": (
                prov.chosen_source_id.value
                if prov.chosen_source_id is not None
                else None
            ),
            "agreement": prov.agreement.value,
        }

    @staticmethod
    def _conflict_params(conflict: Conflict, event_id: str) -> dict[str, Any]:
        competing = [
            {
                "value": cv.value,
                "source_id": cv.source_id.value,
                "source_updated_at": _dt(cv.source_updated_at),
            }
            for cv in conflict.competing_values
        ]
        return {
            "id": conflict.id,
            "event_id": event_id,
            "field_name": conflict.field_name,
            "competing_values": json.dumps(competing, sort_keys=True),
            "resolution": conflict.resolution,
        }

    @staticmethod
    def _score_component_params(
        component: ScoreComponent, event_id: str
    ) -> dict[str, Any]:
        return {
            "id": component.id,
            "event_id": event_id,
            "factor": component.factor.value,
            "raw_value": component.raw_value,
            "weight": component.weight,
            "contribution": component.contribution,
            "note": component.note,
        }

    @staticmethod
    def _row_to_event(row: sqlite3.Row) -> Event:
        lat = row["location_lat"]
        lng = row["location_lng"]
        geo = (
            GeoPoint(lat=lat, lng=lng) if lat is not None and lng is not None else None
        )
        return Event(
            id=row["id"],
            dedup_key=row["dedup_key"],
            title=row["title"],
            event_date=date.fromisoformat(row["event_date"]),
            start_time=_parse_time(row["start_time"]),
            end_time=_parse_time(row["end_time"]),
            location=row["location"],
            location_geo=geo,
            organizer=row["organizer"],
            rsvp_required=_parse_bool(row["rsvp_required"]),
            rsvp_url=row["rsvp_url"],
            rsvp_link_ok=_parse_bool(row["rsvp_link_ok"]),
            event_url=row["event_url"],
            food_confirmed=FoodConfirmed(row["food_confirmed"]),
            food_category=FoodCategory(row["food_category"]),
            food_description=row["food_description"],
            verification_state=VerificationState(row["verification_state"]),
            confidence=row["confidence"],
            score_total=row["score_total"],
            created_at=_parse_dt(row["created_at"]),
            updated_at=_parse_dt(row["updated_at"]),
        )

    @staticmethod
    def _row_to_source_record(row: sqlite3.Row) -> SourceRecord:
        return SourceRecord(
            id=row["id"],
            event_id=row["event_id"],
            source_id=SourceId(row["source_id"]),
            source_url=row["source_url"],
            raw_payload=row["raw_payload"],
            parsed_fields=json.loads(row["parsed_fields"]),
            checked_at=_parse_dt(row["checked_at"]),
            parse_status=ParseStatus(row["parse_status"]),
            source_updated_at=_parse_dt(row["source_updated_at"]),
        )

    @staticmethod
    def _row_to_conflict(row: sqlite3.Row) -> Conflict:
        competing = [
            CompetingValue(
                value=cv["value"],
                source_id=SourceId(cv["source_id"]),
                source_updated_at=_parse_dt(cv["source_updated_at"]),
            )
            for cv in json.loads(row["competing_values"])
        ]
        return Conflict(
            id=row["id"],
            event_id=row["event_id"],
            field_name=row["field_name"],
            competing_values=competing,
            resolution=row["resolution"],
        )

    @staticmethod
    def _row_to_score_component(row: sqlite3.Row) -> ScoreComponent:
        return ScoreComponent(
            id=row["id"],
            event_id=row["event_id"],
            factor=ScoreFactor(row["factor"]),
            raw_value=row["raw_value"],
            weight=row["weight"],
            contribution=row["contribution"],
            note=row["note"],
        )

    @staticmethod
    def _row_to_history(row: sqlite3.Row) -> EventHistory:
        changed_at = _parse_dt(row["changed_at"])
        assert changed_at is not None  # NOT NULL column
        return EventHistory(
            id=row["id"],
            event_id=row["event_id"],
            changed_at=changed_at,
            field_name=row["field_name"],
            old_value=_json_load_or_none(row["old_value"]),
            new_value=_json_load_or_none(row["new_value"]),
            reason=row["reason"],
        )


# ---------------------------------------------------------------------------
# Deterministic serialization helpers (pure, no I/O)
# ---------------------------------------------------------------------------


def _dt(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _t(value: time | None) -> str | None:
    return value.isoformat() if value is not None else None


def _bool(value: bool | None) -> int | None:
    return int(value) if value is not None else None


def _json_or_none(value: Any) -> str | None:
    return json.dumps(value, sort_keys=True) if value is not None else None


def _json_load_or_none(value: str | None) -> Any:
    return json.loads(value) if value is not None else None


def _parse_dt(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value is not None else None


def _parse_time(value: str | None) -> time | None:
    return time.fromisoformat(value) if value is not None else None


def _parse_bool(value: int | None) -> bool | None:
    return bool(value) if value is not None else None
