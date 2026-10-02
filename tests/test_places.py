"""Tests for the campus place dataset loader and conservative resolution.

The important property is restraint: a listing resolves only on an exact or
word-boundary name/alias match, room detail survives, and bad data is skipped
rather than turned into a coordinate. The repository's real dataset is also
exercised so the schema contract stays honest.
"""

from __future__ import annotations

import json
from pathlib import Path

from vandy_food_radar.config import Config
from vandy_food_radar.places import (
    DEFAULT_PLACES_PATH,
    PlaceDataset,
    load_places,
    load_places_for,
    parse_places,
    places_path,
)

SAMPLE = [
    {
        "id": "sarratt",
        "name": "Sarratt Student Center",
        "aliases": ["Sarratt", "Sarratt Center"],
        "lat": 36.1464554,
        "lng": -86.8037437,
        "source_url": "https://www.vanderbilt.edu/map/",
    },
    {
        "id": "stevenson",
        "name": "Stevenson Center",
        "aliases": [],
        "lat": 36.1430,
        "lng": -86.8050,
        "source_url": "https://www.vanderbilt.edu/map/",
    },
]


def _dataset() -> PlaceDataset:
    return parse_places(SAMPLE)


def test_exact_name_resolves_with_no_detail() -> None:
    resolved = _dataset().resolve("Stevenson Center")
    assert resolved is not None
    assert resolved.place.name == "Stevenson Center"
    assert resolved.detail is None


def test_room_detail_is_preserved_not_discarded() -> None:
    resolved = _dataset().resolve("Sarratt Student Center, Room 216")
    assert resolved is not None
    assert resolved.place.id == "sarratt"
    assert resolved.detail == "Room 216"


def test_trailing_room_without_a_comma_still_resolves() -> None:
    resolved = _dataset().resolve("Sarratt Student Center 216")
    assert resolved is not None
    assert resolved.place.id == "sarratt"
    assert resolved.detail == "216"


def test_alias_resolves_and_keeps_the_rest_as_detail() -> None:
    resolved = _dataset().resolve("Sarratt, Second Floor Lounge")
    assert resolved is not None
    assert resolved.place.id == "sarratt"
    assert resolved.detail == "Second Floor Lounge"


def test_leading_article_is_tolerated() -> None:
    resolved = _dataset().resolve("The Stevenson Center")
    assert resolved is not None
    assert resolved.place.id == "stevenson"


def test_unlisted_and_blank_locations_stay_unresolved() -> None:
    dataset = _dataset()
    assert dataset.resolve("Some Unlisted Barn") is None
    assert dataset.resolve("Barnyard Hall, Room 3") is None
    assert dataset.resolve("") is None
    assert dataset.resolve("   ") is None
    assert dataset.resolve(None) is None


def test_a_longer_name_is_not_matched_by_a_shorter_different_building() -> None:
    """A listing must not borrow coordinates from a longer place name."""

    dataset = _dataset()
    # "Stevenson Center" has no aliases, so nothing may match a longer string
    # that merely starts with a different building's words.
    assert dataset.resolve("Stevens Center") is None
    assert dataset.resolve("Stevenson") is None


def test_a_near_miss_of_the_canonical_name_stays_unresolved() -> None:
    """A longer word that merely extends the canonical name must not match.

    ``resolve`` accepts a key followed by a token boundary, so "Sarratt
    Student Center 216" resolves while "Sarratt Student Centerville" — a
    different building that extends the canonical name — must not. Note that
    this guard covers the canonical-name continuation only; a short alias
    followed by unrelated building words still resolves (see
    ``test_repository_dataset_has_no_prefix_shadowing_alias`` for why that is
    currently harmless for the shipped dataset).
    """

    dataset = _dataset()
    assert dataset.resolve("Sarratt Student Centerville") is None
    assert dataset.resolve("Stevenson Centerville") is None


def test_longer_name_wins_over_a_shorter_alias_prefix() -> None:
    dataset = parse_places(
        [
            {"id": "a", "name": "Commons", "lat": 36.14, "lng": -86.80},
            {"id": "b", "name": "Commons Center", "lat": 36.141, "lng": -86.801},
        ]
    )
    resolved = dataset.resolve("Commons Center, Room 1")
    assert resolved is not None
    assert resolved.place.id == "b"


def test_invalid_entries_are_skipped_rather_than_trusted() -> None:
    dataset = parse_places(
        [
            {"id": "ok", "name": "Good Hall", "lat": 36.1, "lng": -86.8},
            {"id": "no-name", "lat": 36.1, "lng": -86.8},
            {"id": "string-coords", "name": "Bad A", "lat": "36.1", "lng": "-86.8"},
            {"id": "out-of-range", "name": "Bad B", "lat": 120.0, "lng": -86.8},
            {"id": "bool-coords", "name": "Bad C", "lat": True, "lng": False},
            {"id": "missing-lng", "name": "Bad D", "lat": 36.1},
            "not-an-object",
        ]
    )
    assert [place.id for place in dataset.places] == ["ok"]


def test_duplicate_ids_keep_only_the_first_entry() -> None:
    dataset = parse_places(
        [
            {"id": "dup", "name": "First", "lat": 36.1, "lng": -86.8},
            {"id": "dup", "name": "Second", "lat": 36.2, "lng": -86.9},
        ]
    )
    assert [place.name for place in dataset.places] == ["First"]


def test_non_array_payload_yields_an_empty_dataset() -> None:
    assert parse_places({"places": []}).places == ()
    assert parse_places(None).available is False


def test_missing_and_malformed_files_degrade_to_unresolved(tmp_path: Path) -> None:
    missing = tmp_path / "nope.json"
    assert load_places(missing).available is False

    broken = tmp_path / "broken.json"
    broken.write_text("{not json", encoding="utf-8")
    assert load_places(broken).available is False


def test_loading_is_cached_per_file_signature(tmp_path: Path) -> None:
    path = tmp_path / "places.json"
    path.write_text(json.dumps(SAMPLE), encoding="utf-8")
    first = load_places(path)
    assert first.available is True
    assert load_places(path) is first


def test_config_selects_the_repository_dataset_by_default() -> None:
    assert places_path(Config()) == DEFAULT_PLACES_PATH


def test_an_explicit_configured_path_is_used(tmp_path: Path) -> None:
    config = Config()
    path = tmp_path / "custom.json"
    path.write_text(json.dumps(SAMPLE), encoding="utf-8")
    config.places.path = str(path)
    assert places_path(config) == path
    assert load_places_for(config).resolve("Stevenson Center") is not None


def test_an_empty_dataset_resolves_nothing_rather_than_guessing() -> None:
    empty = parse_places([])
    assert empty.available is False
    assert empty.resolve("Sarratt Student Center") is None


def test_repository_dataset_matches_the_agreed_schema() -> None:
    """The externally owned dataset must load and resolve real listings."""

    assert DEFAULT_PLACES_PATH.is_file(), "campus-places.json is expected in the repo"
    payload = json.loads(DEFAULT_PLACES_PATH.read_text(encoding="utf-8"))
    assert isinstance(payload, list) and payload
    for entry in payload:
        assert set(entry) >= {"id", "name", "aliases", "lat", "lng", "source_url"}
        assert isinstance(entry["aliases"], list)
        assert -90.0 <= entry["lat"] <= 90.0
        assert -180.0 <= entry["lng"] <= 180.0

    dataset = load_places_for(Config())
    # Every usable row survived validation.
    assert len(dataset.places) == len(payload)
    resolved = dataset.resolve("Sarratt Student Center, Room 216")
    assert resolved is not None
    assert resolved.detail == "Room 216"


def test_repository_dataset_ids_and_coordinates_are_distinct() -> None:
    dataset = load_places_for(Config())
    ids = [place.id for place in dataset.places]
    assert len(set(ids)) == len(ids)
    points = [(place.point.lat, place.point.lng) for place in dataset.places]
    assert len(set(points)) == len(points)
    # Every row cites where its coordinates came from.
    assert all(place.source_url for place in dataset.places)


def test_repository_dataset_has_no_prefix_shadowing_alias() -> None:
    """Guards the gap documented by the xfail above.

    ``resolve`` accepts a key followed by a token boundary, so a short alias
    that is a prefix of a *different* place's name would lend its coordinates
    to the wrong building. No such pair exists today; this test fails loudly if
    one is ever added to the dataset.
    """

    dataset = load_places_for(Config())
    owners: dict[str, str] = {}
    for place in dataset.places:
        for key in place.match_keys():
            owners.setdefault(key, place.id)

    shadowed = [
        (short, owner, longer, other)
        for short, owner in owners.items()
        for longer, other in owners.items()
        if other != owner and longer.startswith(f"{short} ")
    ]
    assert shadowed == []
