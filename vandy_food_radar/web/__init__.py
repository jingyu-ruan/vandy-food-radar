"""Web presentation layer for Vandy Food Radar.

A server-rendered working page for one selected local date plus a small JSON
API that backs the cards, weekly schedule, map, calendar handoff, and walking
estimates. Everything reads only through the
:class:`~vandy_food_radar.store.Repository`; the view models in
:mod:`vandy_food_radar.web.viewmodel` are shared by the HTML and the API so the
two can never describe the feed differently.
"""

from __future__ import annotations

from .app import WEEK_LENGTH, create_app
from .viewmodel import DayFeed, EventCard, build_day_feed

__all__ = [
    "WEEK_LENGTH",
    "DayFeed",
    "EventCard",
    "build_day_feed",
    "create_app",
]
