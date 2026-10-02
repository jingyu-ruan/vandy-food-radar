"""Durable SQLite repository snapshots stored in Upstash Redis.

The pipeline still uses the established SQLite Repository implementation. In
live serverless mode the complete database is loaded from and atomically
published to one Upstash value, so event cards and all provenance survive
across stateless Vercel invocations.
"""

from __future__ import annotations

import base64
import binascii
import json
import sqlite3
import urllib.error
import urllib.request
import uuid

from .sqlite_repository import SCHEMA, SqliteRepository

_REPOSITORY_KEY = "vfr:repository:v1"
_REVISION_KEY = "vfr:repository:v1:revision"
_HTTP_TIMEOUT_SECONDS = 10.0
_REQUIRED_TABLES = {
    "conflicts",
    "event_history",
    "events",
    "field_provenance",
    "score_components",
    "source_records",
}

# Read the data and revision in one Redis operation so a request cannot observe
# a revision from one publication and repository bytes from another.
_LOAD_SCRIPT = """
local repository = redis.call('GET', KEYS[1])
local revision = redis.call('GET', KEYS[2])
return {repository or false, revision or false}
""".strip()

# Publish only if no other serverless invocation has replaced the revision
# loaded by this instance. Both SETs execute atomically inside Redis.
_PUBLISH_SCRIPT = """
local current = redis.call('GET', KEYS[2]) or ''
if current ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[3])
return 1
""".strip()


class DurableRepositoryError(RuntimeError):
    """Raised when the durable live repository cannot be loaded or published."""


class UpstashSqliteRepository(SqliteRepository):
    """A complete SQLite Repository persisted as a strict Upstash snapshot.

    Mutations remain local until :meth:`flush` publishes the complete database.
    Unlike the best-effort change-badge snapshot store, load/save failures here
    raise so a live refresh cannot report success without durable publication.
    An optimistic revision check prevents concurrent stateless invocations from
    silently overwriting a newer feed with work based on stale state.
    """

    def __init__(self, rest_url: str, rest_token: str) -> None:
        if not rest_url or not rest_token:
            raise DurableRepositoryError(
                "live mode requires UPSTASH_REDIS_REST_URL and "
                "UPSTASH_REDIS_REST_TOKEN"
            )
        self._rest_url = rest_url.rstrip("/")
        self._rest_token = rest_token
        self._loaded_revision = ""
        super().__init__(":memory:", check_same_thread=False)
        try:
            self._empty_database = self._conn.serialize()
        except (AttributeError, sqlite3.DatabaseError) as exc:
            raise DurableRepositoryError(
                "this Python SQLite runtime cannot serialize repositories"
            ) from exc
        self.reload()

    def reload(self) -> None:
        """Replace local state with one atomically-read durable snapshot."""

        result = self._command(
            ["EVAL", _LOAD_SCRIPT, "2", _REPOSITORY_KEY, _REVISION_KEY]
        )
        if not isinstance(result, list) or len(result) != 2:
            raise DurableRepositoryError(
                "Upstash returned an invalid durable repository snapshot"
            )
        encoded, revision = result
        repository_missing = encoded is None or encoded is False
        revision_missing = revision is None or revision is False

        if repository_missing:
            if not revision_missing:
                raise DurableRepositoryError(
                    "durable repository revision exists without repository data"
                )
            self._install_database(self._empty_database)
            self._loaded_revision = ""
            return
        if not isinstance(encoded, str):
            raise DurableRepositoryError("durable repository value is not text")
        if not revision_missing and not isinstance(revision, str):
            raise DurableRepositoryError("durable repository revision is not text")

        try:
            database = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise DurableRepositoryError(
                "durable repository contains invalid base64 data"
            ) from exc
        self._install_database(database)
        # An empty revision supports migration from snapshots written before
        # optimistic concurrency control was introduced.
        self._loaded_revision = revision if isinstance(revision, str) else ""

    def flush(self) -> None:
        """Atomically publish local state unless its loaded revision is stale."""

        try:
            self._conn.execute("VACUUM")
            encoded = base64.b64encode(self._conn.serialize()).decode("ascii")
        except (AttributeError, sqlite3.DatabaseError) as exc:
            raise DurableRepositoryError(
                "could not serialize the live event repository"
            ) from exc

        new_revision = uuid.uuid4().hex
        result = self._command(
            [
                "EVAL",
                _PUBLISH_SCRIPT,
                "2",
                _REPOSITORY_KEY,
                _REVISION_KEY,
                self._loaded_revision,
                encoded,
                new_revision,
            ]
        )
        if result != 1:
            if result == 0:
                raise DurableRepositoryError(
                    "durable repository changed during refresh; retry required"
                )
            raise DurableRepositoryError("Upstash did not confirm repository save")
        self._loaded_revision = new_revision

    def _install_database(self, database: bytes) -> None:
        """Validate serialized bytes before replacing the working database."""

        validator = sqlite3.connect(":memory:")
        try:
            validator.deserialize(database)
            integrity = validator.execute("PRAGMA integrity_check").fetchone()
            tables = {
                str(row[0])
                for row in validator.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
        except (AttributeError, sqlite3.DatabaseError) as exc:
            raise DurableRepositoryError(
                "durable repository contains an invalid SQLite snapshot"
            ) from exc
        finally:
            validator.close()

        if integrity is None or integrity[0] != "ok":
            raise DurableRepositoryError("durable repository integrity check failed")
        if not _REQUIRED_TABLES.issubset(tables):
            raise DurableRepositoryError(
                "durable repository has an incompatible SQLite schema"
            )

        try:
            self._conn.deserialize(database)
            self._conn.execute("PRAGMA foreign_keys = ON")
            # A snapshot published by an earlier release can predate tables or
            # indexes added since. Every statement is CREATE ... IF NOT EXISTS,
            # so re-applying the schema migrates the loaded snapshot forward
            # without disturbing existing rows.
            self._conn.executescript(SCHEMA)
            self._conn.commit()
        except (AttributeError, sqlite3.DatabaseError) as exc:
            raise DurableRepositoryError(
                "could not install the durable SQLite snapshot"
            ) from exc

    def _command(self, command: list[str]) -> object:
        data = json.dumps(command).encode("utf-8")
        request = urllib.request.Request(
            self._rest_url,
            data=data,
            headers={
                "Authorization": f"Bearer {self._rest_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(
                request, timeout=_HTTP_TIMEOUT_SECONDS
            ) as response:
                body = response.read().decode("utf-8")
        except (
            urllib.error.URLError,
            TimeoutError,
            UnicodeDecodeError,
            ValueError,
            OSError,
        ) as exc:
            raise DurableRepositoryError(
                "could not reach the durable Upstash repository"
            ) from exc
        try:
            envelope = json.loads(body)
        except json.JSONDecodeError as exc:
            raise DurableRepositoryError(
                "Upstash returned an invalid repository response"
            ) from exc
        if not isinstance(envelope, dict) or "result" not in envelope:
            detail = envelope.get("error") if isinstance(envelope, dict) else None
            raise DurableRepositoryError(
                f"Upstash repository command failed{f': {detail}' if detail else ''}"
            )
        return envelope["result"]


__all__ = ["DurableRepositoryError", "UpstashSqliteRepository"]
