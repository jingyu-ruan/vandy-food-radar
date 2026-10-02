"""Flask application factory for the Vandy Food Radar workspace.

The surface is a single working page plus a small JSON API. Both are fed by
:mod:`vandy_food_radar.web.viewmodel`, so the server-rendered first paint and
every later client fetch describe the same events in the same order.

Routes, grouped by job:

* ``GET /`` renders the workspace for one selected local date (today by
  default, ``?date=YYYY-MM-DD`` to pick another). The server never widens that
  filter, so a selected date cannot show a neighbouring day's events.
* ``GET /api/day``, ``GET /api/week``, ``GET /api/meta`` back the cards,
  schedule, and map without a page reload.
* ``POST /api/walking`` returns a walking estimate, routed when a server-side
  OpenRouteService key is configured and an explicitly labelled straight-line
  estimate otherwise. There is no caller-supplied endpoint and therefore no
  general proxy.
* ``GET /calendar/ics/<identity_key>`` downloads an ICS file and the cards link
  to a Google prefill URL. Neither path needs server calendar credentials; the
  pre-existing authenticated Google *write* route is retained unchanged.
* ``POST /refresh`` and ``GET|POST /cron/refresh`` run the pipeline for
  ``days=1|2|7``. Both require the bearer token in live mode, refuse to run
  concurrently, and publish durably only after every requested day succeeds.

Live-mode guarantees carried over unchanged: durable reads are strict and fail
loudly instead of degrading to fixtures, ``/seed`` and the browser refresh
button exist only offline, and refresh writes are token-protected.
"""

from __future__ import annotations

import hmac
import json
import re
from collections.abc import Callable, Sequence
from dataclasses import replace
from datetime import UTC, date, datetime
from pathlib import Path
from threading import Lock, RLock
from zoneinfo import ZoneInfo

from flask import (
    Flask,
    Response,
    abort,
    flash,
    redirect,
    render_template,
    request,
    url_for,
)
from werkzeug.wrappers import Response as WerkzeugResponse

from ..calendar_links import build_ics, ics_filename
from ..config import Config
from ..models import Event, VerificationState
from ..pipeline import (
    LAST_SUCCESS_DAYS_KEY,
    LAST_SUCCESS_KEY,
    REFRESH_DAY_CHOICES,
    ChangeKind,
    detect_changes,
    run_days_with_snapshot,
    run_report_to_json,
    seed_demo,
)
from ..pipeline.orchestrator import material_change_key
from ..places import PlaceDataset, load_places_for
from ..providers.calendar import CalendarProvider, build_calendar_provider
from ..providers.location import (
    LocationProvider,
    build_location_provider,
)
from ..routing import RouteError, WalkingRouter, parse_waypoints
from ..sources import (
    AnchorLinkFetchError,
    SourceAdapter,
    build_sources,
    default_fetcher,
    window_dates,
)
from ..store import (
    DurableRepositoryError,
    Repository,
    SnapshotStore,
    build_snapshot_store,
)
from .viewmodel import DayFeed, build_day_feed

# Static assets live in the repo's public/static so Vercel's CDN serves them at
# /static/* (Vercel ignores Flask's static_folder); Flask serves the same folder
# at the same URL locally.
STATIC_DIR = Path(__file__).resolve().parents[2] / "public" / "static"

# How many days the schedule view browses.
WEEK_LENGTH = 7


class RefreshBusy(RuntimeError):
    """Raised when a refresh is already running in this process."""

    detail = "a refresh is already running"


def _json(payload: object, status: int = 200) -> Response:
    """Serialize ``payload`` as a JSON response with a deterministic body."""

    return Response(
        json.dumps(payload, sort_keys=True, ensure_ascii=False),
        mimetype="application/json",
        status=status,
    )


def parse_iso_date(raw: str | None, *, default: date) -> date:
    """Parse a strict ``YYYY-MM-DD`` query value, or return ``default``.

    Strict by design: a malformed date falls back to the default day rather
    than being coerced into a nearby one, so the selected date shown in the UI
    always matches the data that was queried.
    """

    if not raw or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw.strip()):
        return default
    try:
        return date.fromisoformat(raw.strip())
    except ValueError:
        return default


def parse_days(raw: str | None) -> int:
    """Parse the refresh ``days`` parameter against the allowed choices."""

    if not raw:
        return 1
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return 1
    return value if value in REFRESH_DAY_CHOICES else 1


def create_app(
    config: Config,
    *,
    repository: Repository,
    sources: Sequence[SourceAdapter] | None = None,
    location_provider: LocationProvider | None = None,
    today_provider: Callable[[], date] | None = None,
    snapshot_store: SnapshotStore | None = None,
    calendar_provider: CalendarProvider | None = None,
    places: PlaceDataset | None = None,
    router: WalkingRouter | None = None,
) -> Flask:
    """Create the Flask app reading through ``repository``.

    Every collaborator is injected so the whole surface is testable offline
    against an in-memory repository and fixture-backed sources.
    """

    app = Flask(__name__, static_folder=STATIC_DIR)
    # Keep the zero-configuration offline demo while deriving a stable,
    # domain-separated Flask signing key from the required live secret. This
    # avoids shipping a publicly known session-signing key in production.
    app.secret_key = (
        "vandy-food-radar-dev"
        if config.offline or not config.refresh_token
        else hmac.digest(
            config.refresh_token.encode("utf-8"),
            b"vfr-flask-session-v1",
            "sha256",
        ).hex()
    )
    provider = location_provider or build_location_provider(config)
    place_data = places if places is not None else load_places_for(config)
    walking_router = router if router is not None else WalkingRouter(config)
    event_timezone = ZoneInfo(config.timezone)
    today_fn = today_provider or (lambda: datetime.now(tz=event_timezone).date())
    store = (
        snapshot_store if snapshot_store is not None else build_snapshot_store(config)
    )
    calendar = (
        calendar_provider
        if calendar_provider is not None
        else build_calendar_provider(config)
    )
    repository_lock = RLock()
    # Non-reentrant and acquired without blocking: a second scheduler hit while
    # a refresh is in flight is rejected rather than queued, so two runs can
    # never interleave their writes.
    refresh_lock = Lock()

    def _refresh_sources() -> Sequence[SourceAdapter]:
        if sources is not None:
            return sources
        return build_sources(config, default_fetcher(config))

    def _reload_live_repository() -> None:
        if config.offline:
            return
        reload_repository = getattr(repository, "reload", None)
        if reload_repository is None:
            raise DurableRepositoryError(
                "live mode repository does not support durable reload"
            )
        reload_repository()

    def _authorized() -> bool:
        if config.offline:
            return True
        if not config.refresh_token:
            return False
        supplied = request.headers.get("Authorization", "")
        expected = f"Bearer {config.refresh_token}"
        return hmac.compare_digest(supplied, expected)

    def _ics_url(event: Event) -> str:
        return url_for(
            "calendar_ics",
            identity_key=event.identity_key,
            date=event.event_date.isoformat(),
        )

    def _feed(day: date, *, with_changes: bool = True, reload: bool = True) -> DayFeed:
        """Build the single-day feed, reloading durable state first."""

        with repository_lock:
            if reload:
                _reload_live_repository()
            changes: dict[str, ChangeKind] | None = None
            current = repository.get_events_for_day(day)
            if with_changes:
                changes = detect_changes(current, store.load_snapshot(day))
            changes = changes or {}
            for event in current:
                raw_change = repository.get_metadata(material_change_key(event))
                if not raw_change:
                    continue
                try:
                    record = json.loads(raw_change)
                    changed_at = datetime.fromisoformat(record["at"])
                    kind = ChangeKind(record["kind"])
                    age = (datetime.now(UTC) - changed_at).total_seconds()
                    if 0 <= age <= 86400 and kind in {
                        ChangeKind.TIME_CHANGED,
                        ChangeKind.VENUE_CHANGED,
                    }:
                        changes[event.identity_key] = kind
                except (ValueError, KeyError, TypeError):
                    continue
            return build_day_feed(
                repository,
                day,
                config=config,
                provider=provider,
                places=place_data,
                changes=changes,
                ics_url_for=_ics_url,
            )

    def _run_refresh(days: int) -> tuple[object, dict[str, ChangeKind]]:
        """Run a protected refresh for ``days``, serialized against itself."""

        if not refresh_lock.acquire(blocking=False):
            raise RefreshBusy()
        try:
            today = today_fn()
            targets = window_dates(config, today=today, days=days)
            with repository_lock:
                _reload_live_repository()
                return run_days_with_snapshot(
                    targets,
                    repository=repository,
                    sources=_refresh_sources(),
                    location_provider=provider,
                    config=config,
                    snapshot_store=store,
                    today=today,
                )
        finally:
            refresh_lock.release()

    def _refresh_error(exc: Exception) -> Response:
        app.logger.error("Live refresh failed: %s", exc)
        return _json(
            {"error": "live refresh failed; previous feed retained"}, status=502
        )

    def _last_success() -> dict[str, str | None]:
        get_metadata = getattr(repository, "get_metadata", None)
        if not callable(get_metadata):
            return {"at": None, "days": None}
        return {
            "at": get_metadata(LAST_SUCCESS_KEY),
            "days": get_metadata(LAST_SUCCESS_DAYS_KEY),
        }

    # ------------------------------------------------------------------
    # page
    # ------------------------------------------------------------------

    @app.get("/")
    def index() -> str | Response:
        today = today_fn()
        selected = parse_iso_date(request.args.get("date"), default=today)
        try:
            feed = _feed(selected)
            last_success = _last_success()
        except DurableRepositoryError as exc:
            app.logger.error("Live repository read failed: %s", exc)
            return Response(
                "Live event data is temporarily unavailable.",
                mimetype="text/plain",
                status=503,
            )
        return render_template(
            "index.html",
            feed=feed,
            cards=feed.cards,
            selected_date=selected,
            today=today,
            offline=config.offline,
            reference_label=config.reference_location.label,
            last_success=last_success,
            client_config=_client_config(config, today, selected, walking_router),
        )

    # ------------------------------------------------------------------
    # JSON API
    # ------------------------------------------------------------------

    @app.get("/api/meta")
    def api_meta() -> Response:
        today = today_fn()
        try:
            with repository_lock:
                _reload_live_repository()
                last_success = _last_success()
        except DurableRepositoryError as exc:
            app.logger.error("Live repository read failed: %s", exc)
            return _json({"error": "event data unavailable"}, status=503)
        payload = _client_config(config, today, today, walking_router)
        payload["last_success"] = last_success
        return _json(payload)

    @app.get("/api/day")
    def api_day() -> Response:
        today = today_fn()
        selected = parse_iso_date(request.args.get("date"), default=today)
        try:
            feed = _feed(selected)
        except DurableRepositoryError as exc:
            app.logger.error("Live repository read failed: %s", exc)
            return _json({"error": "event data unavailable"}, status=503)
        return _json(feed.to_json())

    @app.get("/api/week")
    def api_week() -> Response:
        today = today_fn()
        start = parse_iso_date(request.args.get("start"), default=today)
        if start.toordinal() > date.max.toordinal() - (WEEK_LENGTH - 1):
            return _json(
                {"error": "date is outside the supported calendar range"}, status=400
            )
        try:
            days = []
            with repository_lock:
                _reload_live_repository()
                for offset in range(WEEK_LENGTH):
                    day = date.fromordinal(start.toordinal() + offset)
                    feed = _feed(day, with_changes=False, reload=False)
                    days.append(
                        {
                            "date": day.isoformat(),
                            "events": [card.to_json() for card in feed.cards],
                        }
                    )
        except DurableRepositoryError as exc:
            app.logger.error("Live repository read failed: %s", exc)
            return _json({"error": "event data unavailable"}, status=503)
        return _json({"start": start.isoformat(), "days": days})

    @app.post("/api/walking")
    def api_walking() -> Response:
        payload = request.get_json(silent=True)
        try:
            points = parse_waypoints(payload, config=config)
        except RouteError as exc:
            return _json({"error": str(exc)}, status=400)
        result = walking_router.route(points)
        return _json(result.to_json())

    # ------------------------------------------------------------------
    # calendar handoff (no server credentials)
    # ------------------------------------------------------------------

    @app.get("/calendar/ics/<identity_key>")
    def calendar_ics(identity_key: str) -> Response:
        today = today_fn()
        day = parse_iso_date(request.args.get("date"), default=today)
        try:
            with repository_lock:
                _reload_live_repository()
                match = _find_event(repository, day, identity_key)
        except DurableRepositoryError as exc:
            app.logger.error("Live repository read failed: %s", exc)
            return Response(
                "Event data is temporarily unavailable.",
                mimetype="text/plain",
                status=503,
            )
        if match is None:
            abort(404)
        if resolved := place_data.resolve(match.location):
            match = replace(match, location=resolved.display_name)
        body = build_ics(match, timezone=config.timezone)
        return Response(
            body,
            mimetype="text/calendar",
            headers={
                "Content-Disposition": (f'attachment; filename="{ics_filename(match)}"')
            },
        )

    @app.post("/calendar/add/<identity_key>")
    def calendar_add(identity_key: str) -> WerkzeugResponse:
        """Add the one explicitly selected event through the server provider.

        Retained from the original design: this fires only for an explicit POST,
        never automatically, and skips cancelled events. With the Null provider
        the flashed message surfaces the graceful 'Calendar not configured'
        state. The credential-free Google prefill link and ICS download cover
        the common case without this route.
        """

        today = today_fn()
        day = parse_iso_date(request.args.get("date"), default=today)
        try:
            with repository_lock:
                _reload_live_repository()
                match = _find_event(repository, day, identity_key)
        except DurableRepositoryError as exc:
            app.logger.error("Live repository read failed: %s", exc)
            flash("Live event data is temporarily unavailable")
            return redirect(url_for("index", date=day.isoformat()))
        if match is None:
            flash("Event not found")
        elif match.verification_state is VerificationState.CANCELLED:
            flash("Cancelled events are not added to the calendar")
        else:
            result = calendar.add_event(match)
            if result.ok:
                flash(f"Added \u201c{match.title}\u201d to your calendar")
            else:
                flash(result.detail or "Could not add to calendar")
        return redirect(url_for("index", date=day.isoformat()))

    # ------------------------------------------------------------------
    # refresh
    # ------------------------------------------------------------------

    @app.post("/refresh")
    def refresh() -> WerkzeugResponse | Response:
        if not _authorized():
            return Response("Unauthorized", status=401)
        days = parse_days(request.args.get("days") or request.form.get("days"))
        try:
            _run_refresh(days)
        except RefreshBusy as exc:
            return _json({"error": exc.detail}, status=409)
        except (AnchorLinkFetchError, DurableRepositoryError) as exc:
            return _refresh_error(exc)
        return redirect(url_for("index"))

    @app.route("/cron/refresh", methods=["GET", "POST"])
    def cron_refresh() -> Response:
        """Protected scheduler entry point for a complete durable refresh."""

        if not _authorized():
            return _json({"error": "unauthorized"}, status=401)
        days = parse_days(request.args.get("days"))
        try:
            report, changes = _run_refresh(days)
        except RefreshBusy as exc:
            return _json({"error": exc.detail}, status=409)
        except (AnchorLinkFetchError, DurableRepositoryError) as exc:
            return _refresh_error(exc)
        return Response(
            run_report_to_json(report, changes),  # type: ignore[arg-type]
            mimetype="application/json",
            status=200,
        )

    @app.post("/seed")
    def seed() -> WerkzeugResponse:
        if not config.offline:
            abort(404)
        seed_demo(repository=repository, config=config, today=today_fn())
        return redirect(url_for("index"))

    return app


def _find_event(repository: Repository, day: date, identity_key: str) -> Event | None:
    """Find one event on ``day`` by identity key, never crossing days."""

    return next(
        (
            event
            for event in repository.get_events_for_day(day)
            if event.identity_key == identity_key
        ),
        None,
    )


def _client_config(
    config: Config,
    today: date,
    selected: date,
    router: WalkingRouter,
) -> dict[str, object]:
    """Describe server capabilities for the browser modules.

    Deliberately excludes every secret: the routing key is reported only as an
    availability boolean, never as a value.
    """

    return {
        "timezone": config.timezone,
        "today": today.isoformat(),
        "selected_date": selected.isoformat(),
        "offline": config.offline,
        "week_length": WEEK_LENGTH,
        "reference": {
            "label": config.reference_location.label,
            "lat": config.reference_location.lat,
            "lng": config.reference_location.lng,
        },
        "routing_available": router.routing_available,
        "dwell_minutes": config.itinerary.default_dwell_minutes,
        "max_exact_stops": config.itinerary.max_exact_stops,
        "max_waypoints": config.routing.max_waypoints,
        "refresh_day_choices": list(REFRESH_DAY_CHOICES),
    }


__all__ = ["WEEK_LENGTH", "RefreshBusy", "create_app", "parse_days", "parse_iso_date"]
