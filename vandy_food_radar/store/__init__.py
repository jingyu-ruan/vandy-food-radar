"""Persistence layer for Vandy Food Radar (design.md §2, T1.1-T1.3).

Exposes the :class:`Repository` protocol (the boundary every other layer
persists through) and the stdlib :class:`SqliteRepository` implementation.
"""

from __future__ import annotations

from .base import Repository
from .sqlite_repository import SqliteRepository

__all__ = ["Repository", "SqliteRepository"]
