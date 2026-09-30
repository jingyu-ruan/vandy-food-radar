"""Typed configuration for Vandy Food Radar (CFG-1..CFG-8).

All configuration lives here with sane defaults so the tool runs out of the box
in OFFLINE mode with no network access, no credentials, and no maps API. Values
can be overridden from environment variables (see ``Config.from_env``); the
defaults reproduce the design's documented behavior.

Nothing in this module performs I/O beyond reading environment variables.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from enum import Enum, StrEnum
from typing import TypeVar

from .models import ScoreFactor, SourceId

EnumT = TypeVar("EnumT", bound=Enum)

# Environment variable prefix for all overrides.
ENV_PREFIX = "VFR_"

# ---------------------------------------------------------------------------
# Provider selection (CFG-8)
# ---------------------------------------------------------------------------


class LocationProviderKind(StrEnum):
    """Which walking-distance provider to use (FR-29, FR-30)."""

    HAVERSINE = "haversine"
    GOOGLE_MAPS = "google_maps"
    NULL = "null"


class CalendarProviderKind(StrEnum):
    """Which calendar-write provider to use (FR-39, FR-40)."""

    NONE = "none"
    GOOGLE = "google"


class TargetWindow(StrEnum):
    """The default ingestion window (CFG-2)."""

    NEXT_DAY = "next_day"
    TODAY = "today"


# ---------------------------------------------------------------------------
# Config sub-sections
# ---------------------------------------------------------------------------


@dataclass
class ReferenceLocation:
    """User's configurable home base (CFG-3, FR-28).

    Defaults to a central campus point (Kirkland Hall, Vanderbilt); this is a
    configurable default, never hard-coded into ranking logic.
    """

    label: str = "Kirkland Hall"
    lat: float = 36.1487
    lng: float = -86.8027


@dataclass
class AnchorLinkSource:
    """Anchor Link source settings (CFG-4)."""

    enabled: bool = True
    # Query/filter that selects the "Free Food" perk. Placeholder for the
    # adapter to consume; no live call is made in offline mode.
    free_food_query: str = "perk=Free+Food"
    base_url: str = "https://anchorlink.vanderbilt.edu"


@dataclass
class GoogleCalendarSource:
    """Google Calendar source settings (CFG-4)."""

    enabled: bool = True
    calendar_id: str = ""
    api_key: str = ""


@dataclass
class OfficialPageSource:
    """Official/linked event page verification settings (CFG-4)."""

    enabled: bool = True


@dataclass
class SourcesConfig:
    """Enable/disable flags and credential/URL placeholders per source."""

    anchor_link: AnchorLinkSource = field(default_factory=AnchorLinkSource)
    google_calendar: GoogleCalendarSource = field(default_factory=GoogleCalendarSource)
    official_page: OfficialPageSource = field(default_factory=OfficialPageSource)


def _default_authority_precedence() -> list[SourceId]:
    """Default authority order for conflict resolution (CFG-5, FR-19).

    Higher authority first: official page > Anchor Link > Google Calendar.
    """

    return [
        SourceId.OFFICIAL_PAGE,
        SourceId.ANCHOR_LINK,
        SourceId.GOOGLE_CALENDAR,
    ]


def _default_ranking_weights() -> dict[ScoreFactor, float]:
    """Default ranking weights (CFG-6, design.md §6.1). Sum to 1.0."""

    return {
        ScoreFactor.FOOD_CONFIRMED: 0.25,
        ScoreFactor.FULL_MEAL: 0.25,
        ScoreFactor.FOOD_SPECIFICITY: 0.15,
        ScoreFactor.RSVP_LIKELIHOOD: 0.10,
        ScoreFactor.TIMING: 0.05,
        ScoreFactor.WALKING: 0.10,
        ScoreFactor.CONFIDENCE: 0.10,
    }


@dataclass
class RankingConfig:
    """Ranking weights and thresholds in one place (CFG-6, FR-27)."""

    weights: dict[ScoreFactor, float] = field(default_factory=_default_ranking_weights)
    # Neutral value used when walking time is unknown so it never zeroes the
    # score (FR-30, AC-8).
    walking_unknown_value: float = 0.5
    # Preferred start-time window (24h local hours) for the `timing` factor.
    timing_good_start_hour: int = 11
    timing_good_end_hour: int = 20


@dataclass
class DedupConfig:
    """Deduplication similarity thresholds (CFG-7, FR-13, FR-15)."""

    # >= MERGE_THRESHOLD -> merge as the same event.
    merge_threshold: float = 0.75
    # [review_low, merge_threshold) -> merge and flag possible_duplicate.
    review_low: float = 0.55
    # Time proximity window (minutes) for the time-similarity component.
    time_proximity_minutes: int = 30


@dataclass
class ProvidersConfig:
    """Active provider selection (CFG-8)."""

    location: LocationProviderKind = LocationProviderKind.HAVERSINE
    calendar: CalendarProviderKind = CalendarProviderKind.NONE


@dataclass
class CalendarWriteConfig:
    """Google Calendar write credentials/target (M8, FR-39/FR-40).

    Disabled by default so the no-op :class:`NullCalendarProvider` is used;
    a real writer is built only when ``enabled`` is set, credentials are
    present, and the calendar provider is selected. ``credentials_json`` is the
    raw service-account JSON (from ``GOOGLE_CALENDAR_CREDENTIALS_JSON``); it is
    never committed.
    """

    enabled: bool = False
    calendar_id: str = ""
    credentials_json: str = ""


@dataclass
class MapsConfig:
    """Google Maps Distance Matrix credentials for live walking (M9, FR-29/30).

    Disabled by default so the offline :class:`HaversineLocationProvider` stays
    the default; the live :class:`GoogleMapsLocationProvider` is used only when
    ``enabled`` is set, ``api_key`` is present, and the location provider is
    ``GOOGLE_MAPS``. ``api_key`` (from ``GOOGLE_MAPS_API_KEY``) is a secret and
    is never committed.
    """

    enabled: bool = False
    api_key: str = ""


@dataclass
class SnapshotConfig:
    """Upstash Redis REST credentials for cross-run snapshots (M7-M9).

    Both fields default empty so the offline in-memory snapshot store is the
    default; the Upstash-backed store is used only when both are provided.
    Upstash/Vercel set these plain env var names (not ``VFR_``-prefixed).
    """

    upstash_rest_url: str = ""
    upstash_rest_token: str = ""


@dataclass
class Config:
    """Top-level application configuration (CFG-1..CFG-8).

    Constructed with defaults suitable for offline/fixture runs. Use
    :meth:`from_env` to layer environment overrides on top.
    """

    # CFG-1
    timezone: str = "America/Chicago"
    # CFG-2
    target_window: TargetWindow = TargetWindow.NEXT_DAY
    # Runs with no network access when True (default for MVP / tests).
    offline: bool = True
    # CFG-3
    reference_location: ReferenceLocation = field(default_factory=ReferenceLocation)
    # CFG-4
    sources: SourcesConfig = field(default_factory=SourcesConfig)
    # CFG-5
    authority_precedence: list[SourceId] = field(
        default_factory=_default_authority_precedence
    )
    # CFG-6
    ranking: RankingConfig = field(default_factory=RankingConfig)
    # CFG-7
    dedup: DedupConfig = field(default_factory=DedupConfig)
    # CFG-8
    providers: ProvidersConfig = field(default_factory=ProvidersConfig)
    # Live Google Maps walking credentials (M9); disabled by default.
    maps: MapsConfig = field(default_factory=MapsConfig)
    # Cross-run snapshot store credentials (M7-M9); empty => offline default.
    snapshot: SnapshotConfig = field(default_factory=SnapshotConfig)
    # Google Calendar write credentials (M8); disabled by default.
    calendar_write: CalendarWriteConfig = field(default_factory=CalendarWriteConfig)

    @classmethod
    def from_env(cls, environ: dict[str, str] | None = None) -> Config:
        """Build a Config from defaults with environment overrides.

        Only a curated subset of settings is overridable from the environment;
        anything not set falls back to the default, so the tool always runs
        out of the box. Unrecognized values fall back to defaults rather than
        raising, keeping startup robust.
        """

        env = environ if environ is not None else dict(os.environ)
        cfg = cls()

        offline = env.get(f"{ENV_PREFIX}OFFLINE")
        if offline is not None:
            cfg.offline = _parse_bool(offline, default=cfg.offline)

        timezone = env.get(f"{ENV_PREFIX}TIMEZONE")
        if timezone:
            cfg.timezone = timezone

        window = env.get(f"{ENV_PREFIX}TARGET_WINDOW")
        if window:
            cfg.target_window = _parse_enum(TargetWindow, window, cfg.target_window)

        label = env.get(f"{ENV_PREFIX}REF_LABEL")
        if label:
            cfg.reference_location.label = label
        lat = env.get(f"{ENV_PREFIX}REF_LAT")
        if lat is not None:
            cfg.reference_location.lat = _parse_float(lat, cfg.reference_location.lat)
        lng = env.get(f"{ENV_PREFIX}REF_LNG")
        if lng is not None:
            cfg.reference_location.lng = _parse_float(lng, cfg.reference_location.lng)

        cal_id = env.get(f"{ENV_PREFIX}GOOGLE_CALENDAR_ID")
        if cal_id is not None:
            cfg.sources.google_calendar.calendar_id = cal_id
        api_key = env.get(f"{ENV_PREFIX}GOOGLE_CALENDAR_API_KEY")
        if api_key is not None:
            cfg.sources.google_calendar.api_key = api_key

        location_provider = env.get(f"{ENV_PREFIX}LOCATION_PROVIDER")
        if location_provider:
            cfg.providers.location = _parse_enum(
                LocationProviderKind, location_provider, cfg.providers.location
            )
        calendar_provider = env.get(f"{ENV_PREFIX}CALENDAR_PROVIDER")
        if calendar_provider:
            cfg.providers.calendar = _parse_enum(
                CalendarProviderKind, calendar_provider, cfg.providers.calendar
            )

        calendar_write_enabled = env.get(f"{ENV_PREFIX}CALENDAR_WRITE_ENABLED")
        if calendar_write_enabled is not None:
            cfg.calendar_write.enabled = _parse_bool(
                calendar_write_enabled, default=cfg.calendar_write.enabled
            )
        calendar_write_id = env.get(f"{ENV_PREFIX}CALENDAR_ID")
        if calendar_write_id is not None:
            cfg.calendar_write.calendar_id = calendar_write_id
        # Google sets this plain (non-VFR_-prefixed) env var name; the raw
        # service-account JSON is a secret and is never committed.
        credentials_json = env.get("GOOGLE_CALENDAR_CREDENTIALS_JSON")
        if credentials_json is not None:
            cfg.calendar_write.credentials_json = credentials_json

        maps_enabled = env.get(f"{ENV_PREFIX}MAPS_ENABLED")
        if maps_enabled is not None:
            cfg.maps.enabled = _parse_bool(maps_enabled, default=cfg.maps.enabled)
        # Google sets this plain (non-VFR_-prefixed) env var name; it is a
        # secret and is never committed.
        maps_api_key = env.get("GOOGLE_MAPS_API_KEY")
        if maps_api_key is not None:
            cfg.maps.api_key = maps_api_key

        # Upstash/Vercel set these plain (non-VFR_-prefixed) env var names.
        upstash_url = env.get("UPSTASH_REDIS_REST_URL")
        if upstash_url is not None:
            cfg.snapshot.upstash_rest_url = upstash_url
        upstash_token = env.get("UPSTASH_REDIS_REST_TOKEN")
        if upstash_token is not None:
            cfg.snapshot.upstash_rest_token = upstash_token

        return cfg


# ---------------------------------------------------------------------------
# Small parsing helpers (pure, no I/O)
# ---------------------------------------------------------------------------


def _parse_bool(value: str, default: bool) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def _parse_float(value: str, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _parse_enum(enum_cls: type[EnumT], value: str, default: EnumT) -> EnumT:
    try:
        return enum_cls(value.strip().lower())
    except ValueError:
        return default


def default_config() -> Config:
    """Return the out-of-the-box offline configuration."""

    return Config()
