"""Campus place dataset and conservative location resolution.

Event listings name places the way a human would ("Sarratt Student Center, Room
216"). To draw a marker or estimate a walk the server needs coordinates, and the
curated dataset uses Vanderbilt's official campus map and explicitly sourced
OpenStreetMap coordinates for newer buildings. This module loads the dataset
and matches listed text against it.

Matching is deliberately conservative. A listing resolves only when its leading
building segment matches a place's name or one of its curated aliases exactly
after normalization, or when the segment starts with such a name followed by a
word boundary. Partial word overlap, edit-distance guessing, and "closest
building" heuristics are all rejected: an unresolved location is a correct
answer, whereas a plausible-looking wrong building is a bad one.

Room/suite detail is never discarded. ``ResolvedPlace.detail`` preserves the
remainder of the original string so the card can still show "Room 216" while
the coordinates come from the building.

The dataset file itself is owned externally (``public/static/campus-places.json``)
and is only ever read here. Entries with non-finite or out-of-range coordinates
are skipped rather than trusted.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import Config
from .models import GeoPoint

# Repository-relative default location of the externally owned dataset.
DEFAULT_PLACES_PATH = (
    Path(__file__).resolve().parents[1] / "public" / "static" / "campus-places.json"
)

# Separators that commonly divide "Building, Room 123" style location strings.
_SEGMENT_SPLIT = re.compile(r"\s*(?:,|\u2014|\u2013| - | \| |;)\s*")
_NON_ALNUM = re.compile(r"[^a-z0-9]+")
# Noise words dropped during normalization so "The Commons Center" matches
# "Commons Center". Kept tiny on purpose: aggressive stripping causes false
# matches between genuinely different buildings.
_NOISE_TOKENS = frozenset({"the"})
_STEVENSON_ROOM = re.compile(
    r"^(?:stevenson(?:\s+center)?|sc)\s*(?:room\s*)?([124567]\d{3})\b",
    re.IGNORECASE,
)


def _normalize(value: str) -> str:
    """Return a lowercase alphanumeric-token key for conservative comparison."""

    lowered = _NON_ALNUM.sub(" ", value.lower())
    tokens = [
        token for token in lowered.split() if token and token not in _NOISE_TOKENS
    ]
    return " ".join(tokens)


def _valid_coordinate(lat: Any, lng: Any) -> GeoPoint | None:
    """Return a validated :class:`GeoPoint`, or ``None`` for unusable input."""

    if isinstance(lat, bool) or isinstance(lng, bool):
        return None
    if not isinstance(lat, (int, float)) or not isinstance(lng, (int, float)):
        return None
    lat_f = float(lat)
    lng_f = float(lng)
    if not math.isfinite(lat_f) or not math.isfinite(lng_f):
        return None
    if not -90.0 <= lat_f <= 90.0 or not -180.0 <= lng_f <= 180.0:
        return None
    return GeoPoint(lat=lat_f, lng=lng_f)


@dataclass(frozen=True)
class CampusPlace:
    """One curated campus place from the official map dataset."""

    id: str
    name: str
    aliases: tuple[str, ...]
    point: GeoPoint
    source_url: str | None = None

    def match_keys(self) -> tuple[str, ...]:
        """Normalized name/alias keys this place may be matched on."""

        keys: list[str] = []
        for candidate in (self.name, *self.aliases):
            key = _normalize(candidate)
            if key and key not in keys:
                keys.append(key)
        return tuple(keys)


@dataclass(frozen=True)
class ResolvedPlace:
    """A listed location successfully tied to a curated campus place.

    ``detail`` keeps whatever the listing said beyond the building name (room,
    floor, suite) so no original information is lost on the way to the card.
    ``matched_text`` is the exact listing segment that matched.
    """

    place: CampusPlace
    detail: str | None
    matched_text: str

    @property
    def display_name(self) -> str:
        return f"{self.place.name}, {self.detail}" if self.detail else self.place.name


@dataclass(frozen=True)
class PlaceDataset:
    """An immutable, pre-indexed set of campus places."""

    places: tuple[CampusPlace, ...]

    @property
    def available(self) -> bool:
        """Whether any usable place was loaded."""

        return bool(self.places)

    def _index(self) -> list[tuple[str, CampusPlace]]:
        """Longest-key-first index so the most specific name wins a prefix test."""

        entries: list[tuple[str, CampusPlace]] = []
        for place in self.places:
            for key in place.match_keys():
                entries.append((key, place))
        entries.sort(key=lambda item: (-len(item[0]), item[0]))
        return entries

    def resolve(self, location: str | None) -> ResolvedPlace | None:
        """Resolve ``location`` conservatively, or return ``None``.

        Tries each comma/dash-delimited segment in order. A segment resolves on
        an exact normalized match, or when it begins with a place key followed
        by a token boundary (so "Sarratt Student Center 216" resolves while
        "Sarratt Student Centerville" does not). The unmatched remainder of the
        original string becomes :attr:`ResolvedPlace.detail`.
        """

        if not location or not location.strip():
            return None
        if not self.places:
            return None

        room_match = _STEVENSON_ROOM.match(location.strip())
        if room_match:
            building_key = f"stevenson center building {room_match.group(1)[0]}"
            place = next(
                (item for item in self.places if building_key in item.match_keys()),
                None,
            )
            if place is not None:
                remainder = location.strip()[room_match.end() :].strip(" ,-;")
                room_detail = f"Room {room_match.group(1)}"
                if remainder:
                    room_detail += f", {remainder}"
                return ResolvedPlace(
                    place=place, detail=room_detail, matched_text=room_match.group(0)
                )

        segments = [
            seg for seg in _SEGMENT_SPLIT.split(location.strip()) if seg.strip()
        ]
        if not segments:
            return None
        index = self._index()

        # Try the full name first; canonical names can contain an internal dash.
        candidates = [(None, location.strip()), *enumerate(segments)]
        for position, segment in candidates:
            normalized = _normalize(segment)
            if not normalized:
                continue
            for key, place in index:
                if normalized == key:
                    detail = (
                        _join_detail(segments, skip=position, trailing=None)
                        if position is not None
                        else None
                    )
                    return ResolvedPlace(
                        place=place, detail=detail, matched_text=segment.strip()
                    )
                if normalized.startswith(f"{key} "):
                    listed_next = normalized[len(key) + 1 :].split()[0]
                    if any(
                        longer.startswith(f"{key} ")
                        and listed_next.startswith(longer[len(key) + 1 :].split()[0])
                        and not normalized.startswith(f"{longer} ")
                        for longer in place.match_keys()
                    ):
                        continue
                    trailing = segment.strip()[len(key) :].strip(" ,-")
                    # Re-derive the trailing text from the normalized boundary so
                    # the detail keeps the listing's original capitalization.
                    trailing = _original_trailing(segment, key) or trailing
                    detail = (
                        _join_detail(segments, skip=position, trailing=trailing)
                        if position is not None
                        else trailing
                    )
                    return ResolvedPlace(
                        place=place, detail=detail, matched_text=segment.strip()
                    )
        return None


def _original_trailing(segment: str, key: str) -> str | None:
    """Return the segment's text after the matched key, original casing kept."""

    consumed = 0
    boundary = 0
    for match in re.finditer(r"[a-z0-9]+", segment, re.IGNORECASE):
        if match.group(0).lower() in _NOISE_TOKENS:
            continue
        consumed += 1
        boundary = match.end()
        if consumed == len(key.split()):
            break
    trailing = segment[boundary:].strip(" ,-")
    return trailing or None


def _join_detail(segments: list[str], *, skip: int, trailing: str | None) -> str | None:
    """Combine the trailing text and every non-matched segment into one detail."""

    parts: list[str] = []
    if trailing:
        parts.append(trailing)
    for index, segment in enumerate(segments):
        if index == skip:
            continue
        cleaned = segment.strip()
        if cleaned:
            parts.append(cleaned)
    return ", ".join(parts) or None


EMPTY_DATASET = PlaceDataset(places=())


def parse_places(payload: Any) -> PlaceDataset:
    """Build a :class:`PlaceDataset` from decoded JSON, skipping bad entries.

    The expected shape is an array of ``{id,name,aliases,lat,lng,source_url}``.
    Anything else — a non-array payload, a non-object entry, a missing name, a
    non-numeric or out-of-range coordinate — is skipped so one bad row cannot
    take down the feature or introduce a fabricated coordinate.
    """

    if not isinstance(payload, list):
        return EMPTY_DATASET
    places: list[CampusPlace] = []
    seen_ids: set[str] = set()
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            continue
        point = _valid_coordinate(entry.get("lat"), entry.get("lng"))
        if point is None:
            continue
        raw_id = entry.get("id")
        place_id = (
            raw_id.strip() if isinstance(raw_id, str) and raw_id.strip() else name
        )
        if place_id in seen_ids:
            continue
        seen_ids.add(place_id)
        raw_aliases = entry.get("aliases")
        aliases: tuple[str, ...] = ()
        if isinstance(raw_aliases, list):
            aliases = tuple(
                alias.strip()
                for alias in raw_aliases
                if isinstance(alias, str) and alias.strip()
            )
        source_url = entry.get("source_url")
        places.append(
            CampusPlace(
                id=place_id,
                name=name.strip(),
                aliases=aliases,
                point=point,
                source_url=(
                    source_url.strip()
                    if isinstance(source_url, str) and source_url.strip()
                    else None
                ),
            )
        )
    return PlaceDataset(places=tuple(places))


# Cache keyed on (resolved path, mtime_ns, size) so an updated dataset is picked
# up without restarting, while repeated requests do not re-read the file.
_cache: dict[tuple[str, int, int], PlaceDataset] = {}


def places_path(config: Config) -> Path:
    """Return the dataset path for ``config`` (its default when unset)."""

    configured = config.places.path.strip()
    return Path(configured) if configured else DEFAULT_PLACES_PATH


def load_places(path: Path | str) -> PlaceDataset:
    """Load and cache the dataset at ``path``.

    A missing, unreadable, or malformed file yields the empty dataset: every
    location then stays unresolved, which is the correct degraded behavior.
    """

    resolved = Path(path)
    try:
        stat = resolved.stat()
    except OSError:
        return EMPTY_DATASET
    key = (str(resolved), stat.st_mtime_ns, stat.st_size)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    try:
        payload = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return EMPTY_DATASET
    dataset = parse_places(payload)
    _cache.clear()
    _cache[key] = dataset
    return dataset


def load_places_for(config: Config) -> PlaceDataset:
    """Load the dataset selected by ``config``."""

    return load_places(places_path(config))


__all__ = [
    "DEFAULT_PLACES_PATH",
    "EMPTY_DATASET",
    "CampusPlace",
    "PlaceDataset",
    "ResolvedPlace",
    "load_places",
    "load_places_for",
    "parse_places",
    "places_path",
]
