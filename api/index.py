"""Vercel Python entrypoint exposing the Flask WSGI ``app`` callable.

The imported application selects the fixture-backed offline demo or the strict
Upstash-backed live mode from environment configuration. Request handling stays
in :mod:`vandy_food_radar.web`.
"""

from __future__ import annotations

from vandy_food_radar.web.wsgi import app

__all__ = ["app"]
