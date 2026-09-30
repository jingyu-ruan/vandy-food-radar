"""Persistence layer for Vandy Food Radar (design.md §2, T1.1-T1.3).

Exposes the :class:`Repository` protocol (the boundary every other layer
persists through) and the stdlib :class:`SqliteRepository` implementation,
plus the :class:`SnapshotStore` seam used by the stateless-serverless run path
for cross-session change detection (M7-M9).
"""

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

__all__ = [
    "Repository",
    "SqliteRepository",
    "SnapshotStore",
    "InMemorySnapshotStore",
    "UpstashSnapshotStore",
    "build_snapshot_store",
    "events_to_json",
    "events_from_json",
]
