"""Flask application factory (design.md §1.1, T6.6–T6.8, FR-34–FR-38).

Builds a server-rendered app that reads the next day's ranked events **only**
through the injected :class:`~vandy_food_radar.store.Repository` and renders them
as dense cards: title, time, location, food description, RSVP status, walking
time (or 'unavailable'), source links, a verification badge, and the ranking
explanation, with an expandable list of recorded conflicts. Event states are
visibly distinguished with per-state styling. A 'Refresh now' POST re-runs the
pipeline for the target day through injected sources/providers.

The factory injects all collaborators so the app is testable offline with an
in-memory repository and the fixture-backed pipeline.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, time

from flask import Flask, Response, flash, redirect, render_template, url_for
from werkzeug.wrappers import Response as WerkzeugResponse

from ..config import Config
from ..models import (
    Conflict,
    Event,
    FoodConfirmed,
    GeoPoint,
    ScoreComponent,
    SourceRecord,
    VerificationState,
)
from ..pipeline import (
    ChangeKind,
    detect_changes,
    run_report_to_json,
    run_with_snapshot,
    seed_demo,
)
from ..pipeline import run as run_pipeline
from ..providers.calendar import CalendarProvider, build_calendar_provider
from ..providers.location import (
    LocationProvider,
    WalkingStatus,
    build_location_provider,
)
from ..ranking import build_explanation
from ..ranking.engine import ScoredEvent, order_events
from ..sources import SourceAdapter, Window, build_sources, default_fetcher
from ..store import Repository, SnapshotStore, build_snapshot_store

# Human-readable labels for the per-event change badges (FR-42/FR-43).
_CHANGE_LABELS: dict[ChangeKind, str] = {
    ChangeKind.NEW: "New",
    ChangeKind.TIME_CHANGED: "Time changed",
    ChangeKind.VENUE_CHANGED: "Venue changed",
    ChangeKind.CANCELLED: "Cancelled",
}

# Human-readable labels for the verification states shown on each card.
_STATE_LABELS: dict[VerificationState, str] = {
    VerificationState.VERIFIED: "Verified",
    VerificationState.PARTIALLY_VERIFIED: "Partially verified",
    VerificationState.CONFLICTING: "Conflicting info",
    VerificationState.FOOD_UNCONFIRMED: "Food unconfirmed",
    VerificationState.CANCELLED: "Cancelled",
}


@dataclass
class ConflictView:
    """A single recorded conflict rendered for the expandable section."""

    field_name: str
    values: list[str]
    resolution: str | None


@dataclass
class EventCard:
    """Everything one dense event card needs, assembled from the repository."""

    event: Event
    state_label: str
    state_class: str
    time_range: str
    food_confirmed_label: str
    rsvp_label: str
    walking_label: str
    source_links: list[tuple[str, str]]
    explanation: str
    conflicts: list[ConflictView]
    change_kind: ChangeKind | None = None
    change_label: str | None = None


def create_app(
    config: Config,
    *,
    repository: Repository,
    sources: Sequence[SourceAdapter] | None = None,
    location_provider: LocationProvider | None = None,
    today_provider: Callable[[], date] | None = None,
    snapshot_store: SnapshotStore | None = None,
    calendar_provider: CalendarProvider | None = None,
) -> Flask:
    """Create the Flask app reading through ``repository`` (design.md §1.1).

    ``sources`` / ``location_provider`` power the 'Refresh now' action; when
    omitted they default to the offline fixture sources and the configured
    location provider. ``today_provider`` supplies "today" (injectable for
    tests) so window derivation never depends directly on the wall clock.
    """

    app = Flask(__name__)
    # Secret key backs Flask flash() for the calendar-status message; a fixed
    # dev value keeps offline/demo mode working with no configuration.
    app.secret_key = "vandy-food-radar-dev"
    provider = location_provider or build_location_provider(config)
    today_fn = today_provider or (lambda: datetime.now(tz=UTC).date())
    store = (
        snapshot_store if snapshot_store is not None else build_snapshot_store(config)
    )
    calendar = (
        calendar_provider
        if calendar_provider is not None
        else build_calendar_provider(config)
    )

    def _refresh_sources() -> Sequence[SourceAdapter]:
        if sources is not None:
            return sources
        return build_sources(config, default_fetcher(config))

    @app.get("/")
    def index() -> str:
        window = Window.from_config(config, today=today_fn())
        current = repository.get_events_for_day(window.target_date)
        # Read-only change detection against the previous snapshot; the index
        # view never re-saves the snapshot (that happens in /refresh and
        # /cron/refresh). A missing snapshot means every event reads NEW.
        previous = store.load_snapshot(window.target_date)
        changes = detect_changes(current, previous)
        cards = _build_cards(repository, config, provider, window.target_date, changes)
        return render_template(
            "index.html",
            cards=cards,
            target_date=window.target_date,
            reference_label=config.reference_location.label,
        )

    @app.post("/refresh")
    def refresh() -> WerkzeugResponse:
        window = Window.from_config(config, today=today_fn())
        run_pipeline(
            window,
            repository=repository,
            sources=_refresh_sources(),
            location_provider=provider,
            config=config,
        )
        return redirect(url_for("index"))

    @app.route("/cron/refresh", methods=["GET", "POST"])
    def cron_refresh() -> Response:
        """Vercel-Cron entry point: refresh tomorrow via run_with_snapshot.

        Runs the pipeline for the target day, reconciles changes against the
        previous snapshot, repopulates the snapshot, and returns the RunReport
        counts plus the change tally as JSON. No in-process scheduler exists;
        Vercel Cron invokes this route daily.
        """

        window = Window.from_config(config, today=today_fn())
        report, changes = run_with_snapshot(
            window,
            repository=repository,
            sources=_refresh_sources(),
            location_provider=provider,
            config=config,
            snapshot_store=store,
        )
        return Response(
            run_report_to_json(report, changes),
            mimetype="application/json",
            status=200,
        )

    @app.post("/seed")
    def seed() -> WerkzeugResponse:
        seed_demo(repository=repository, config=config, today=today_fn())
        return redirect(url_for("index"))

    @app.post("/calendar/add/<identity_key>")
    def calendar_add(identity_key: str) -> WerkzeugResponse:
        """Add the one explicitly selected event to the calendar (FR-39/FR-40).

        Finds the single event for the target window matching ``identity_key``,
        skips cancelled events, and calls the injected calendar provider. Never
        auto-adds: this fires only for an explicit POST. With the Null provider
        the flashed message surfaces the graceful 'Calendar not configured'
        state from :class:`CalendarWriteResult.detail`.
        """

        window = Window.from_config(config, today=today_fn())
        match = next(
            (
                event
                for event in repository.get_events_for_day(window.target_date)
                if event.identity_key == identity_key
            ),
            None,
        )
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
        return redirect(url_for("index"))

    return app


# ---------------------------------------------------------------------------
# view-model assembly (reads only through the Repository)
# ---------------------------------------------------------------------------


def _build_cards(
    repository: Repository,
    config: Config,
    provider: LocationProvider,
    day: date,
    changes: dict[str, ChangeKind] | None = None,
) -> list[EventCard]:
    """Assemble ranked :class:`EventCard` view-models for ``day``.

    Reads the events and their persisted :class:`ScoreComponent` rows through
    the Repository — the scores were computed and stored at pipeline time, so
    the view never recomputes them (avoiding redundant work and any
    display/persistence drift). Reordered with the deterministic ranking order
    (cancelled last, score desc, earlier start, title) so the display honors
    §6.2 even though the SQL read orders only by score/title.
    """

    events = repository.get_events_for_day(day)
    scored = [
        ScoredEvent(event=event, components=repository.get_score_components(event.id))
        for event in events
    ]
    ordered = order_events(scored)
    change_map = changes or {}
    return [
        _build_card(
            repository,
            config,
            provider,
            item.event,
            item.components,
            change_map.get(item.event.identity_key),
        )
        for item in ordered
    ]


def _build_card(
    repository: Repository,
    config: Config,
    provider: LocationProvider,
    event: Event,
    components: list[ScoreComponent],
    change_kind: ChangeKind | None = None,
) -> EventCard:
    """Build one card from an event and its persisted score components."""

    conflicts = repository.get_conflicts(event.id)
    sources = repository.get_source_records(event.id)
    explanation = build_explanation(
        components, verification_state=event.verification_state
    )
    return EventCard(
        event=event,
        state_label=_STATE_LABELS.get(
            event.verification_state, event.verification_state.value
        ),
        state_class=f"state-{event.verification_state.value}",
        time_range=_format_time_range(event.start_time, event.end_time),
        food_confirmed_label=_food_label(event.food_confirmed),
        rsvp_label=_rsvp_label(event),
        walking_label=_walking_label(config, provider, event),
        source_links=_source_links(event, sources),
        explanation=explanation,
        conflicts=[_conflict_view(c) for c in conflicts],
        change_kind=change_kind,
        change_label=(
            _CHANGE_LABELS.get(change_kind)
            if change_kind is not None and change_kind is not ChangeKind.UNCHANGED
            else None
        ),
    )


def _format_time_range(start: time | None, end: time | None) -> str:
    if start is None:
        return "Time TBD"
    if end is None:
        return start.strftime("%H:%M")
    return f"{start.strftime('%H:%M')}–{end.strftime('%H:%M')}"


def _food_label(confirmed: FoodConfirmed) -> str:
    return {
        FoodConfirmed.CONFIRMED: "Food confirmed",
        FoodConfirmed.UNCONFIRMED: "Food unconfirmed",
        FoodConfirmed.CONTRADICTED: "Food disputed",
    }[confirmed]


def _rsvp_label(event: Event) -> str:
    if event.rsvp_required is None:
        return "RSVP unknown"
    if not event.rsvp_required:
        return "No RSVP needed"
    if event.rsvp_link_ok is False:
        return "RSVP required (link broken)"
    return "RSVP required"


def _walking_label(config: Config, provider: LocationProvider, event: Event) -> str:
    ref = config.reference_location
    origin = GeoPoint(lat=ref.lat, lng=ref.lng)
    result = provider.walking(origin, event.location_geo)
    if result.status is WalkingStatus.OK and result.minutes is not None:
        return f"~{result.minutes} min walk"
    return "Walking time unavailable"


def _source_links(event: Event, sources: list[SourceRecord]) -> list[tuple[str, str]]:
    """Return (label, url) pairs for every source that carried a URL."""

    links: list[tuple[str, str]] = []
    seen: set[str] = set()
    for record in sources:
        url = record.source_url
        if url and url not in seen:
            seen.add(url)
            links.append((record.source_id.value.replace("_", " "), url))
    if event.event_url and event.event_url not in seen:
        links.append(("event page", event.event_url))
    return links


def _conflict_view(conflict: Conflict) -> ConflictView:
    values = [
        f"{cv.source_id.value.replace('_', ' ')}: {cv.value}"
        for cv in conflict.competing_values
    ]
    return ConflictView(
        field_name=conflict.field_name.replace("_", " "),
        values=values,
        resolution=conflict.resolution,
    )


__all__ = ["EventCard", "ConflictView", "create_app"]
