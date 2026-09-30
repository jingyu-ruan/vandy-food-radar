"""Pipeline orchestration (design.md §1.1, T6.5, FR-41–FR-43, AC-10/AC-11).

Threads the MVP stages together — ingest -> normalize -> dedup -> verify ->
score -> save — behind a single :func:`run` entry point that reads sources
through injected adapters and persists through the :class:`Repository`. Writes
are idempotent (upsert on ``dedup_key``) and changed tracked fields append
:class:`~vandy_food_radar.models.EventHistory` rows. Also exposes the
:func:`seed_demo` helper that loads the offline corpus with its dates retargeted
onto the target day so the web view is never empty.
"""

from __future__ import annotations

from .orchestrator import RunReport, run, seed_demo

__all__ = ["RunReport", "run", "seed_demo"]
