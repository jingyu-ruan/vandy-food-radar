"""Web presentation layer for Vandy Food Radar (design.md §1.1, T6.6–T6.8).

A small server-rendered Flask app that shows the next day's ranked events as
dense cards. It reads **only** through the :class:`~vandy_food_radar.store.\
Repository` and offers a 'Refresh now' action that re-runs the pipeline for the
target day.
"""

from __future__ import annotations

from .app import create_app

__all__ = ["create_app"]
