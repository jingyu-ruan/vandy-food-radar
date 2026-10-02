"""Tests for the GitHub Actions refresh workflow.

GitHub Actions supplies the timer for the Sites application, so the workflow's
cadence and authenticated publication readback are part of its contract:

* two cadences — ``days=2`` every two hours and ``days=7`` every six — and both
  spans are ones the server actually accepts;
* a single concurrency group with ``cancel-in-progress: false``, so refreshes
  serialize instead of interleaving;
* the Site service token travels only to its fixed HTTPS origin, with redirects
  refused and transient failures retried;
* no ``GITHUB_TOKEN`` permissions, and no secret inlined in the file.

The workflow is parsed as YAML where possible and otherwise read as text, so no
new dependency is required.
"""

from __future__ import annotations

import re
from pathlib import Path

from vandy_food_radar.pipeline import REFRESH_DAY_CHOICES

WORKFLOW_PATH = (
    Path(__file__).resolve().parents[1] / ".github" / "workflows" / "hourly-refresh.yml"
)


def _text() -> str:
    return WORKFLOW_PATH.read_text(encoding="utf-8")


def _cron_expressions(text: str) -> list[str]:
    return re.findall(r'-\s+cron:\s*"([^"]+)"', text)


def test_the_workflow_exists_and_is_scheduled() -> None:
    assert WORKFLOW_PATH.is_file()
    text = _text()
    assert "schedule:" in text
    assert "workflow_dispatch:" in text


def test_both_cadences_are_scheduled_at_two_and_six_hours() -> None:
    crons = _cron_expressions(_text())
    assert len(crons) == 2
    minutes = []
    steps = []
    for expression in crons:
        fields = expression.split()
        assert len(fields) == 5, expression
        minute, hour = fields[0], fields[1]
        assert minute.isdigit()
        assert hour.startswith("*/")
        minutes.append(int(minute))
        steps.append(int(hour.removeprefix("*/")))
    assert sorted(steps) == [2, 6]
    # Distinct minutes, so the two cadences never fire in the same minute.
    assert len(set(minutes)) == 2
    # Off-the-hour, as the comment in the workflow claims.
    assert all(0 < minute < 60 for minute in minutes)


def test_the_six_hour_cadence_requests_the_week_and_the_default_is_two_days() -> None:
    text = _text()
    six_hour = next(
        expression
        for expression in _cron_expressions(text)
        if expression.split()[1] == "*/6"
    )
    # The six-hour schedule is the one mapped to the seven-day span.
    assert f'"{six_hour}" ]; then\n            days=7' in text
    assert re.search(r"else\s*\n\s*days=2", text)


def test_only_server_supported_day_spans_can_be_requested() -> None:
    text = _text()
    assert 'case "$days" in\n            2|7) ;;' in text
    requested = {2, 7}
    assert requested <= set(REFRESH_DAY_CHOICES)
    # The manual trigger offers exactly those spans.
    options = re.search(r"options:\n((?:\s+-\s+\"\d+\"\n)+)", text)
    assert options is not None
    assert sorted(re.findall(r'"(\d+)"', options.group(1))) == ["2", "7"]


def test_runs_are_serialized_by_one_concurrency_group() -> None:
    text = _text()
    match = re.search(
        r"^concurrency:\n  group: (?P<group>\S+)\n  cancel-in-progress: "
        r"(?P<cancel>\S+)$",
        text,
        re.MULTILINE,
    )
    assert match is not None
    assert match.group("group") == "vandy-food-radar-live-refresh"
    assert match.group("cancel") == "false"
    # One group for every trigger: no per-cadence group expression.
    assert text.count("concurrency:") == 1


def test_the_token_is_only_ever_sent_over_https() -> None:
    text = _text()
    assert "base != 'https://vandy-food-radar.rjy020128.chatgpt.site'" in text
    assert "'OAI-Sites-Authorization': 'Bearer ' + token" in text
    assert "class NoRedirect(urllib.request.HTTPRedirectHandler):" in text
    assert "return None" in text
    assert "urllib.request.build_opener(NoRedirect())" in text
    assert "request(f'/api/refresh?days={days}', 'POST')" in text


def test_transient_failures_are_retried_and_bounded() -> None:
    text = _text()
    assert "for attempt in range(3):" in text
    assert "exc.code in (409, 429, 500, 502, 503, 504)" in text
    assert "client.open(req, timeout=60)" in text
    assert "min(30, max(1, int(retry_after)))" in text
    assert re.search(r"timeout-minutes: \d+", text)


def test_the_workflow_requests_no_github_token_scope() -> None:
    assert "permissions: {}" in _text()


def test_credentials_come_only_from_repository_secrets() -> None:
    text = _text()
    assert "${{ secrets.VFR_SITES_SERVICE_TOKEN }}" in text
    # Nothing that looks like an inlined bearer token or Upstash URL.
    assert "upstash" not in text.lower()
    assert not re.search(r"Bearer [A-Za-z0-9]{8,}", text)


def test_every_requested_day_is_read_back_from_durable_storage() -> None:
    text = _text()
    assert "for date in expected:" in text
    assert "request('/api/events?date=' + urllib.parse.quote(date), 'GET')" in text
    assert "feed.get('state') in ('ok', 'empty')" in text
    assert "feed.get('publishedAt') == result['publishedAt']" in text
    assert "all(event.get('eventDate') == date for event in events)" in text
    assert "total != result.get('published')" in text
