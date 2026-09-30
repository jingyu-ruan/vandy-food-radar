"""Regression tests for the Vercel deploy config (production 404 on every path).

Vercel deploys this repo as a zero-config Flask framework project and routes
internal rewrites using the *rewritten* destination path, so a catch-all rewrite
to ``/api/index`` made Flask see ``/api/index`` for every URL and 404. These
tests pin: no rewrites/routes in ``vercel.json``, every cron path is a real
Flask route, the ``api.index`` entrypoint serves ``/``, and the stylesheet lives
in ``public/static`` (Vercel ignores Flask's static folder and serves
``public/`` from its CDN).
"""

from __future__ import annotations

import importlib
import json
import sys
from pathlib import Path
from typing import Any

import pytest
from flask import Flask

REPO_ROOT = Path(__file__).resolve().parents[1]


def _vercel_config() -> dict[str, Any]:
    data: dict[str, Any] = json.loads((REPO_ROOT / "vercel.json").read_text())
    return data


def _build_app(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Flask:
    monkeypatch.setenv("VFR_DB", str(tmp_path / "store.db"))
    from vandy_food_radar.web.wsgi import build_app

    return build_app()


def test_vercel_json_has_no_rewrites_or_routes() -> None:
    config = _vercel_config()
    assert "rewrites" not in config
    assert "routes" not in config
    assert "builds" not in config


def test_every_cron_path_is_a_flask_route(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    app = _build_app(monkeypatch, tmp_path)
    rules = {rule.rule for rule in app.url_map.iter_rules()}
    crons = _vercel_config()["crons"]
    assert crons
    for cron in crons:
        assert cron["path"] in rules
        response = app.test_client().get(cron["path"])
        assert response.status_code == 200


def test_api_index_entrypoint_serves_root(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("VFR_DB", str(tmp_path / "store.db"))
    # api.index builds its app at import time; import fresh under the tmp DB.
    for name in ("api.index", "vandy_food_radar.web.wsgi"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    module = importlib.import_module("api.index")
    app = module.app
    assert isinstance(app, Flask)
    response = app.test_client().get("/")
    assert response.status_code == 200


def test_stylesheet_is_served_from_public_static(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    assert (REPO_ROOT / "public" / "static" / "app.css").is_file()
    app = _build_app(monkeypatch, tmp_path)
    response = app.test_client().get("/static/app.css")
    assert response.status_code == 200
    response.close()
