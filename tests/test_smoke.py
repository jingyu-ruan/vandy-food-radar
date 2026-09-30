"""Smoke test: the package imports and exposes its version."""

from __future__ import annotations

import vandy_food_radar


def test_package_has_version() -> None:
    assert isinstance(vandy_food_radar.__version__, str)
    assert vandy_food_radar.__version__
