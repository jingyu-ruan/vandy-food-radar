"""Persistence boundaries for local and stateless-serverless operation."""

from __future__ import annotations

from .base import Repository
from .snapshot import (
    InMemorySnapshotStore,
    SnapshotStore,
    UpstashSnapshotStore,
    build_snapshot_store,
    events_from_json,
    events_to_json,
)
from .sqlite_repository import SqliteRepository
from .upstash_repository import DurableRepositoryError, UpstashSqliteRepository

__all__ = [
    "DurableRepositoryError",
    "InMemorySnapshotStore",
    "Repository",
    "SnapshotStore",
    "SqliteRepository",
    "UpstashSnapshotStore",
    "UpstashSqliteRepository",
    "build_snapshot_store",
    "events_from_json",
    "events_to_json",
]
