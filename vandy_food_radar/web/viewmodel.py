"""View models shared by the server-rendered page and the JSON API.

One assembly path builds every card so the first paint and any later client
fetch can never disagree. Each card is a plain dataclass with a ``to_json``
projection; Jinja reads the dataclass, ``/api`` reads the projection.

Two editorial rules are enforced here rather than in the templates:

* **Only material warnings are shown.** A cancellation, a genuine cross-source
  conflict, and a time or venue change are things a reader must act on. The
  routine "partially verified" state — which is simply what a single-source
  listing looks like — is not a warning and is not displayed as one.
* **Nothing is asserted that a source did not publish.** Coordinates come only
  from the curated campus dataset, participation comes only from matched text,
  and external links are dropped unless they are ``http``/``https``.

All text reaches the browser through Jinja autoescaping or ``JSON.stringify``;
no field here is marked safe for raw HTML injection.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date, time
from urllib.parse import urlsplit

from ..calendar_links import google_calendar_url
from ..config import Config, LocationProviderKind
from ..models import (
    Conflict,
    Event,
    FoodCategory,
    FoodConfirmed,
    GeoPoint,
    ScoreComponent,
    SourceRecord,
    VerificationState,
)
from ..participation import (
    ParticipationAssessment,
    assess_participation,
    participation_input_for,
)
from ..pipeline import ChangeKind
from ..places import PlaceDataset
from ..providers.location import LocationProvider, WalkingStatus
from ..ranking import build_explanation, recommendation_stars
from ..ranking.engine import ScoredEvent, order_events
from ..store import Repository
from ..summary import DailyBrief, build_brief
from .excerpts import food_excerpt

# Only these schemes may ever reach an ``href``.
_SAFE_SCHEMES = frozenset({"http", "https"})

# Verification states worth showing as a badge. "Partially verified" and
# "food unconfirmed" are communicated through the food chip instead, so the
# card is not covered in routine status pills.
_BADGE_STATES: dict[VerificationState, str] = {
    VerificationState.CANCELLED: "Cancelled",
    VerificationState.CONFLICTING: "Conflicting details",
}

# Fields whose cross-source disagreement changes what a reader should do: when
# and where to show up, and whether food is actually provided. A difference in
# title wording, description phrasing, or which URL a source links to is real
# provenance — it stays in the details pane — but it is not a warning.
_MATERIAL_CONFLICT_FIELDS = frozenset(
    {
        "event_date",
        "start_time",
        "end_time",
        "location",
        "food_confirmed",
        "rsvp_required",
    }
)

_CHANGE_LABELS: dict[ChangeKind, str] = {
    ChangeKind.NEW: "New",
    ChangeKind.TIME_CHANGED: "Time changed",
    ChangeKind.VENUE_CHANGED: "Venue changed",
    ChangeKind.CANCELLED: "Cancelled",
}

_FOOD_LABELS: dict[FoodConfirmed, str] = {
    FoodConfirmed.CONFIRMED: "Food confirmed",
    FoodConfirmed.UNCONFIRMED: "Food unconfirmed",
    FoodConfirmed.CONTRADICTED: "Food disputed",
}

_CATEGORY_LABELS: dict[FoodCategory, str] = {
    FoodCategory.FULL_MEAL: "Full meal",
    FoodCategory.SNACKS_OR_REFRESHMENTS: "Snacks",
    FoodCategory.UNSPECIFIED: "Unspecified",
    FoodCategory.NONE: "No food described",
}

_SOURCE_LABELS: dict[str, str] = {
    "anchor_link": "AnchorLink",
    "google_calendar": "Calendar",
    "official_page": "Official page",
}


def safe_url(url: str | None) -> str | None:
    """Return ``url`` only when it is an absolute http(s) URL, else ``None``.

    Guards every outbound link and the map/itinerary payloads against
    ``javascript:``, ``data:``, and other active schemes arriving through
    source text.
    """

    if not url or not isinstance(url, str):
        return None
    candidate = url.strip()
    if not candidate:
        return None
    try:
        parts = urlsplit(candidate)
    except ValueError:
        return None
    if parts.scheme.lower() not in _SAFE_SCHEMES:
        return None
    if not parts.netloc:
        return None
    return candidate


def format_clock(value: time) -> str:
    """Render a local time in the 12-hour form used across the UI."""

    hour = value.hour % 12 or 12
    suffix = "AM" if value.hour < 12 else "PM"
    if value.minute:
        return f"{hour}:{value.minute:02d} {suffix}"
    return f"{hour} {suffix}"


def format_time_range(start: time | None, end: time | None) -> str:
    """Format a start/end pair, flagging an end that crosses midnight."""

    if start is None:
        return "Time not listed"
    if end is None:
        return format_clock(start)
    if end <= start:
        return f"{format_clock(start)} \u2013 {format_clock(end)} (next day)"
    return f"{format_clock(start)} \u2013 {format_clock(end)}"


@dataclass
class ConflictView:
    """One recorded cross-source disagreement, rendered for the details pane."""

    field_name: str
    values: list[str]
    resolution: str | None

    def to_json(self) -> dict[str, object]:
        """Projection for the JSON API."""

        return {
            "field": self.field_name,
            "values": list(self.values),
            "resolution": self.resolution,
        }


@dataclass
class PlaceView:
    """The resolved building for an event, when the dataset matched one."""

    name: str
    lat: float
    lng: float
    source_url: str | None
    detail: str | None

    def to_json(self) -> dict[str, object]:
        """Projection for the JSON API."""

        return {
            "name": self.name,
            "lat": self.lat,
            "lng": self.lng,
            "source_url": self.source_url,
            "detail": self.detail,
        }


@dataclass
class EventCard:
    """Everything one card needs, assembled once for HTML and JSON alike."""

    event: Event
    stars: int
    time_label: str
    start_iso: str | None
    end_iso: str | None
    food_label: str
    food_category_label: str
    food_description: str | None
    description: str | None
    location_listed: str | None
    place: PlaceView | None
    rsvp_label: str
    rsvp_url: str | None
    organizer: str | None
    participation_note: str
    participation_level: str
    participation_certain: bool
    participation_warnings: list[str]
    walking_label: str
    source_links: list[tuple[str, str]]
    event_url: str | None
    explanation: str
    conflicts: list[ConflictView]
    badge_label: str | None
    change_kind: ChangeKind | None = None
    change_label: str | None = None
    google_calendar_url: str | None = None
    ics_url: str | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def cancelled(self) -> bool:
        """Whether this listing is cancelled."""

        return self.event.verification_state is VerificationState.CANCELLED

    @property
    def state_class(self) -> str:
        """CSS modifier for the card's verification state."""

        return f"is-{self.event.verification_state.value}"

    def to_json(self) -> dict[str, object]:
        """Projection consumed by the browser modules."""

        return {
            "identity_key": self.event.identity_key,
            "title": self.event.title,
            "date": self.event.event_date.isoformat(),
            "stars": self.stars,
            "score": self.event.score_total,
            "time_label": self.time_label,
            "start": self.start_iso,
            "end": self.end_iso,
            "food_label": self.food_label,
            "food_category": self.food_category_label,
            "food_description": self.food_description,
            "description": self.description,
            "location_listed": self.location_listed,
            "place": self.place.to_json() if self.place else None,
            "rsvp_label": self.rsvp_label,
            "rsvp_url": self.rsvp_url,
            "organizer": self.organizer,
            "participation": {
                "level": self.participation_level,
                "note": self.participation_note,
                "certain": self.participation_certain,
                "warnings": list(self.participation_warnings),
            },
            "walking_label": self.walking_label,
            "sources": [
                {"label": label, "url": url} for label, url in self.source_links
            ],
            "event_url": self.event_url,
            "explanation": self.explanation,
            "conflicts": [conflict.to_json() for conflict in self.conflicts],
            "badge": self.badge_label,
            "change": self.change_label,
            "cancelled": self.cancelled,
            "state": self.event.verification_state.value,
            "warnings": list(self.warnings),
            "calendar": {
                "google": self.google_calendar_url,
                "ics": self.ics_url,
            },
        }


@dataclass
class DayFeed:
    """The complete, strictly single-day payload behind one selected date."""

    target_date: date
    cards: list[EventCard]
    brief: DailyBrief

    def to_json(self) -> dict[str, object]:
        """Projection consumed by the browser modules."""

        return {
            "date": self.target_date.isoformat(),
            "brief": {
                "headline": self.brief.headline,
                "sentences": list(self.brief.sentences),
                "text": self.brief.text,
                "content_hash": self.brief.content_hash,
            },
            "events": [card.to_json() for card in self.cards],
        }


def _rsvp_label(event: Event) -> str:
    if event.rsvp_required is None:
        return "RSVP not stated"
    if not event.rsvp_required:
        return "No RSVP needed"
    if event.rsvp_link_ok is False:
        return "RSVP required (link looks broken)"
    return "RSVP required"


def _walking_label(
    config: Config, provider: LocationProvider, point: GeoPoint | None
) -> str:
    reference = config.reference_location
    origin = GeoPoint(lat=reference.lat, lng=reference.lng)
    result = provider.walking(origin, point)
    if result.status is WalkingStatus.OK and result.minutes is not None:
        if config.providers.location is LocationProviderKind.HAVERSINE:
            return f"~{result.minutes} min estimate from {reference.label}"
        return f"{result.minutes} min walk from {reference.label}"
    return "Walking time unavailable"


def _source_links(event: Event, records: list[SourceRecord]) -> list[tuple[str, str]]:
    links: list[tuple[str, str]] = []
    seen: set[str] = set()
    for record in records:
        url = safe_url(record.source_url)
        if url is None or url in seen:
            continue
        seen.add(url)
        label = _SOURCE_LABELS.get(
            record.source_id.value, record.source_id.value.replace("_", " ")
        )
        links.append((label, url))
    event_url = safe_url(event.event_url)
    if event_url is not None and event_url not in seen:
        links.append(("Event page", event_url))
    return links


def _conflict_view(conflict: Conflict) -> ConflictView:
    return ConflictView(
        field_name=conflict.field_name.replace("_", " "),
        values=[
            f"{value.source_id.value.replace('_', ' ')}: {value.value}"
            for value in conflict.competing_values
        ],
        resolution=conflict.resolution,
    )


def _warnings(
    event: Event,
    material_conflicts: list[ConflictView],
    change_kind: ChangeKind | None,
    assessment: ParticipationAssessment,
) -> list[str]:
    """Collect only warnings a reader has to act on."""

    warnings: list[str] = []
    if event.verification_state is VerificationState.CANCELLED:
        warnings.append("This listing is cancelled.")
    if change_kind is ChangeKind.TIME_CHANGED:
        warnings.append("The listed time changed since the last refresh.")
    if change_kind is ChangeKind.VENUE_CHANGED:
        warnings.append("The listed venue changed since the last refresh.")
    if material_conflicts:
        fields = ", ".join(
            sorted({conflict.field_name for conflict in material_conflicts})
        )
        warnings.append(f"Sources disagree on {fields}; check the source listing.")
    if event.food_confirmed is FoodConfirmed.CONTRADICTED:
        warnings.append("Sources disagree about whether food is provided.")
    warnings.extend(assessment.warnings)
    return warnings


def _badge_label(event: Event, material_conflicts: list[ConflictView]) -> str | None:
    """Return the one status badge worth showing, if any.

    A cancellation always shows. "Conflicting details" shows only when the
    disagreement is material: an event flagged conflicting purely because two
    sources word the title differently would otherwise look alarming for no
    actionable reason.
    """

    if event.verification_state is VerificationState.CANCELLED:
        return _BADGE_STATES[VerificationState.CANCELLED]
    if event.verification_state is VerificationState.CONFLICTING and material_conflicts:
        return _BADGE_STATES[VerificationState.CONFLICTING]
    return None


def build_card(
    event: Event,
    components: list[ScoreComponent],
    records: list[SourceRecord],
    conflicts: list[Conflict],
    *,
    config: Config,
    provider: LocationProvider,
    places: PlaceDataset,
    change_kind: ChangeKind | None = None,
    calendar_urls: bool = True,
) -> EventCard:
    """Assemble one card from persisted event data."""

    resolved = places.resolve(event.location)
    place = (
        PlaceView(
            name=resolved.place.name,
            lat=resolved.place.point.lat,
            lng=resolved.place.point.lng,
            source_url=safe_url(resolved.place.source_url),
            detail=resolved.detail,
        )
        if resolved is not None
        else None
    )
    point = event.location_geo or (
        GeoPoint(lat=place.lat, lng=place.lng) if place else None
    )
    assessment = assess_participation(participation_input_for(event, records))
    conflict_views = [_conflict_view(conflict) for conflict in conflicts]
    material = [
        view
        for view, conflict in zip(conflict_views, conflicts, strict=True)
        if conflict.field_name in _MATERIAL_CONFLICT_FIELDS
    ]
    calendar_event = (
        replace(event, location=resolved.display_name) if resolved else event
    )

    return EventCard(
        event=event,
        stars=recommendation_stars(event.score_total),
        time_label=format_time_range(event.start_time, event.end_time),
        start_iso=event.start_time.isoformat() if event.start_time else None,
        end_iso=event.end_time.isoformat() if event.end_time else None,
        food_label=_FOOD_LABELS.get(event.food_confirmed, "Food unconfirmed"),
        food_category_label=_CATEGORY_LABELS.get(event.food_category, "Unspecified"),
        food_description=food_excerpt(event.food_description),
        description=event.food_description,
        location_listed=event.location,
        place=place,
        rsvp_label=_rsvp_label(event),
        rsvp_url=safe_url(event.rsvp_url),
        organizer=event.organizer,
        participation_note=assessment.note,
        participation_level=assessment.level.value,
        participation_certain=assessment.certain,
        participation_warnings=list(assessment.warnings),
        walking_label=_walking_label(config, provider, point),
        source_links=_source_links(event, records),
        event_url=safe_url(event.event_url),
        explanation=build_explanation(
            components, verification_state=event.verification_state
        ),
        conflicts=conflict_views,
        badge_label=_badge_label(event, material),
        change_kind=change_kind,
        change_label=(
            _CHANGE_LABELS.get(change_kind)
            if change_kind is not None
            and change_kind not in {ChangeKind.UNCHANGED, ChangeKind.NEW}
            else None
        ),
        google_calendar_url=(
            google_calendar_url(calendar_event, timezone=config.timezone)
            if calendar_urls
            else None
        ),
        ics_url=None,
        warnings=_warnings(event, material, change_kind, assessment),
    )


def build_day_feed(
    repository: Repository,
    day: date,
    *,
    config: Config,
    provider: LocationProvider,
    places: PlaceDataset,
    changes: dict[str, ChangeKind] | None = None,
    ics_url_for: object = None,
) -> DayFeed:
    """Build the ranked, strictly single-day feed for ``day``.

    Reads only through the :class:`~vandy_food_radar.store.Repository` and only
    for ``day``, so an explicit date filter can never mix in a neighbouring
    day's events. Score components were computed at pipeline time and are read
    back rather than recomputed, keeping display and persistence in step.
    """

    events = repository.get_events_for_day(day)
    # Defensive: the query is already date-scoped, but the display contract is
    # that one selected date never shows another date's events.
    events = [event for event in events if event.event_date == day]
    scored = [
        ScoredEvent(event=event, components=repository.get_score_components(event.id))
        for event in events
    ]
    ordered = order_events(scored)
    change_map = changes or {}

    cards: list[EventCard] = []
    for item in ordered:
        card = build_card(
            item.event,
            item.components,
            repository.get_source_records(item.event.id),
            repository.get_conflicts(item.event.id),
            config=config,
            provider=provider,
            places=places,
            change_kind=change_map.get(item.event.identity_key),
        )
        if callable(ics_url_for):
            card.ics_url = ics_url_for(item.event)
        cards.append(card)

    return DayFeed(
        target_date=day,
        cards=cards,
        brief=build_brief(day, [item.event for item in ordered]),
    )


__all__ = [
    "ConflictView",
    "DayFeed",
    "EventCard",
    "PlaceView",
    "build_card",
    "build_day_feed",
    "format_clock",
    "format_time_range",
    "safe_url",
]
