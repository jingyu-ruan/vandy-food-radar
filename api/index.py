"""Vercel Python entrypoint: expose the Flask WSGI ``app`` callable.

The Vercel Python runtime serves the module-level ``app`` object. This is a thin
re-export of the offline-ready application built in
:mod:`vandy_food_radar.web.wsgi`; no request-handling logic lives here.
"""

from __future__ import annotations

from vandy_food_radar.web.wsgi import app

__all__ = ["app"]
