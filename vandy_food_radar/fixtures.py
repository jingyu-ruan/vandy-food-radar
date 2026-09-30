"""Loader helpers for the offline fixture corpus (design.md §9, T0.4).

The fixture corpus lives under ``tests/fixtures/`` as JSON files representing
raw source payloads (the shape adapters will later produce), plus one HTML
snippet standing in for an unparseable official page. These helpers load the
corpus from disk with no network access so tests can verify it deterministically.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# Repository-relative location of the fixture corpus.
FIXTURES_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"


def fixtures_dir() -> Path:
    """Return the path to the fixture corpus directory."""

    return FIXTURES_DIR


def list_json_fixtures() -> list[Path]:
    """Return every JSON fixture file, sorted by name for determinism."""

    return sorted(FIXTURES_DIR.glob("*.json"))


def list_html_fixtures() -> list[Path]:
    """Return every HTML fixture file, sorted by name for determinism."""

    return sorted(FIXTURES_DIR.glob("*.html"))


def load_json_fixture(name: str) -> Any:
    """Load and parse a single JSON fixture by file name.

    ``name`` may be given with or without the ``.json`` suffix.
    """

    if not name.endswith(".json"):
        name = f"{name}.json"
    path = FIXTURES_DIR / name
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def load_all_json_fixtures() -> dict[str, Any]:
    """Load every JSON fixture, keyed by file stem, sorted for determinism."""

    return {path.stem: _load(path) for path in list_json_fixtures()}


def load_text_fixture(name: str) -> str:
    """Load a raw text/HTML fixture by file name (verbatim)."""

    path = FIXTURES_DIR / name
    return path.read_text(encoding="utf-8")


def _load(path: Path) -> Any:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)
