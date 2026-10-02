"""Deterministic deduplication / merge stage (design.md §4, T4.2/T4.3).

Within each ``event_date`` block, clusters normalized records by combined
similarity using the configurable thresholds in
:class:`~vandy_food_radar.config.DedupConfig`:

* ``>= merge_threshold`` — merge as the same event.
* ``[review_low, merge_threshold)`` — merge **and** flag ``possible_duplicate``.
* ``< review_low`` — keep separate.

Each cluster yields one :class:`MergedEvent` that links every contributing
normalized record and carries a deterministic ``dedup_key`` (``event_date`` +
a stable fingerprint of normalized title tokens, venue, and rounded start time)
so repeated runs upsert idempotently rather than creating duplicates (FR-42,
E-1, E-13).

Canonical per-field value selection is deliberately deferred to the Verifier
(§5): this stage only groups records and computes the key. The provisional
:class:`~vandy_food_radar.models.Event` it emits carries placeholder canonical
fields (earliest-source title/date/start) purely so downstream stages have a
shell to populate; the authoritative record list is ``members``.

Pure and deterministic: no network, DB, or file I/O.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, time
from uuid import NAMESPACE_URL, uuid5

from ..config import DedupConfig
from ..models import Event
from ..normalize import NormalizedRecord
from .similarity import block_by_date, combined_similarity, title_tokens

# Rounding granularity (minutes) applied to the start time inside the
# fingerprint so trivially-close times share a key while distinct times differ.
FINGERPRINT_TIME_ROUNDING_MINUTES = 30


@dataclass
class MergedEvent:
    """One deduplicated event: the merged group of contributing records.

    ``members`` lists every :class:`NormalizedRecord` that was clustered into
    this event (one entry per contributing source). ``possible_duplicate`` is
    ``True`` when at least one member joined on a borderline score in
    ``[review_low, merge_threshold)`` and the merge should be surfaced for
    review (FR-14/FR-15). ``event`` is a provisional canonical shell whose field
    values are finalized later by the Verifier.
    """

    dedup_key: str
    members: list[NormalizedRecord]
    possible_duplicate: bool
    event: Event = field(init=False)

    def __post_init__(self) -> None:
        self.event = _build_event_shell(self.dedup_key, self.members)


def _round_minutes(value: time | None, *, granularity: int) -> str:
    """Return a rounded ``HHMM`` stamp for a start time, or ``"none"``."""

    if value is None:
        return "none"
    total = value.hour * 60 + value.minute
    if granularity > 0:
        total = round(total / granularity) * granularity
    total %= 24 * 60
    return f"{total // 60:02d}{total % 60:02d}"


def _venue_fingerprint(location: str | None) -> str:
    """Deterministic normalized venue token string for the fingerprint."""

    return " ".join(sorted(title_tokens(location)))


def compute_dedup_key(
    event_date: date | None,
    title: str | None,
    location: str | None,
    start_time: time | None,
) -> str:
    """Build the deterministic ``dedup_key`` (design.md §4, step 5).

    The key is ``event_date`` + a stable fingerprint of sorted normalized title
    tokens, the normalized venue, and the rounded start time. It fingerprints
    the *current* shape of the merged cluster so within-run clustering and
    change detection are precise. For cross-run identity that must survive a
    verified time or venue change, use :func:`compute_identity_key` instead
    (FR-42).
    """

    day = event_date.isoformat() if event_date is not None else "no-date"
    title_fp = " ".join(sorted(title_tokens(title)))
    venue_fp = _venue_fingerprint(location)
    time_fp = _round_minutes(start_time, granularity=FINGERPRINT_TIME_ROUNDING_MINUTES)
    return f"{day}|{title_fp}|{venue_fp}|{time_fp}"


def compute_identity_key(event_date: date | None, title: str | None) -> str:
    """Build the stable cross-run ``identity_key`` (FR-42/FR-43, E-2, E-3).

    Composed only from ``event_date`` and the sorted normalized title tokens —
    deliberately *excluding* venue and start time so that a verified time change
    (18:00 -> 19:00) or venue change (Hall A -> Hall B) keeps the same identity
    and updates the existing event in place, with the change recorded as history
    (AC-11), rather than inserting a duplicate record.
    """

    day = event_date.isoformat() if event_date is not None else "no-date"
    title_fp = " ".join(sorted(title_tokens(title)))
    return f"{day}|{title_fp}"


def _canonical_member(members: list[NormalizedRecord]) -> NormalizedRecord:
    """Pick a stable representative for placeholder canonical/key fields.

    Deterministic and *content-based*: the member with the most title tokens
    (richest title), ties broken by the longest and then lexically-smallest
    title, location, and start time. The tie-break deliberately avoids
    ``source_record_id`` because that id is a fresh UUID per ingest run, which
    would otherwise make the derived ``dedup_key`` unstable across runs and
    break idempotent upsert (FR-42, AC-10).
    """

    return max(members, key=_canonical_sort_key)


def _canonical_sort_key(record: NormalizedRecord) -> tuple[int, int, str, str, str]:
    """Stable, content-only ordering key for representative selection."""

    title = record.title or ""
    location = record.location or ""
    start = record.start_time.isoformat() if record.start_time is not None else ""
    # Negate the lexical strings so ``max`` prefers the smallest title/location.
    return (
        len(title_tokens(title)),
        len(title),
        _neg_lexical(title),
        _neg_lexical(location),
        start,
    )


def _neg_lexical(value: str) -> str:
    """Invert a string's code points so ``max`` yields the lexically-smallest."""

    return "".join(chr(0x10FFFF - ord(ch)) for ch in value)


def _build_event_shell(dedup_key: str, members: list[NormalizedRecord]) -> Event:
    """Assemble a provisional canonical Event for a merged cluster.

    Field values are placeholders (from the representative member); the Verifier
    replaces them with authority-resolved values. ``event_date`` falls back to
    the UNIX epoch only when no member carried a parseable date, keeping the
    model's non-null contract satisfied without inventing a plausible date.
    """

    representative = _canonical_member(members)
    event_date = next(
        (m.event_date for m in members if m.event_date is not None),
        representative.event_date,
    )
    resolved_date = event_date if event_date is not None else date(1970, 1, 1)
    source_identities = sorted(
        {member.source_identity for member in members if member.source_identity}
    )
    identity_key = (
        f"source|{source_identities[0]}"
        if len(source_identities) == 1
        else compute_identity_key(resolved_date, representative.title)
    )
    return Event(
        # Distinct provider IDs can share the same title/time/venue fingerprint.
        # Give those records distinct stable primary keys while retaining the
        # fingerprint for cross-source similarity and legacy fixture events.
        id=(
            uuid5(NAMESPACE_URL, identity_key).hex
            if len(source_identities) == 1
            else dedup_key
        ),
        dedup_key=dedup_key,
        identity_key=identity_key,
        title=representative.title or "",
        event_date=resolved_date,
        start_time=representative.start_time,
        end_time=representative.end_time,
        location=representative.location,
        organizer=representative.organizer,
        rsvp_required=representative.rsvp_required,
        rsvp_url=representative.rsvp_url,
        event_url=representative.event_url,
        food_confirmed=representative.food_confirmed,
        food_category=representative.food_category,
        food_description=representative.food_description,
    )


def _cluster_block(
    records: list[NormalizedRecord],
    *,
    config: DedupConfig,
) -> list[tuple[list[NormalizedRecord], bool]]:
    """Greedily cluster one date block; return (members, possible_duplicate).

    Each record joins the first existing cluster where its best similarity to a
    member is ``>= review_low`` (merging), flagging ``possible_duplicate`` when
    that best score is below ``merge_threshold``. Otherwise it seeds a new
    cluster. Deterministic: records are processed in the given (stable) order.
    """

    clusters: list[list[NormalizedRecord]] = []
    borderline: list[bool] = []

    for record in records:
        best_index = -1
        best_score = 0.0
        for index, cluster in enumerate(clusters):
            comparable = [
                member
                for member in cluster
                if not (
                    record.source_identity
                    and member.source_identity
                    and record.source_id is member.source_id
                    and record.source_identity != member.source_identity
                )
            ]
            if not comparable:
                continue
            score = max(
                combined_similarity(record, member, config=config)
                for member in comparable
            )
            if score >= config.review_low and score > best_score:
                best_score = score
                best_index = index
        if best_index >= 0:
            clusters[best_index].append(record)
            if best_score < config.merge_threshold:
                borderline[best_index] = True
        else:
            clusters.append([record])
            borderline.append(False)

    return list(zip(clusters, borderline, strict=True))


def deduplicate(
    records: list[NormalizedRecord],
    *,
    config: DedupConfig,
) -> list[MergedEvent]:
    """Deduplicate normalized records into merged events (FR-12–FR-15).

    Blocks by ``event_date`` (E-10), clusters each block by combined similarity
    against the configured thresholds, and returns one :class:`MergedEvent` per
    cluster with a deterministic ``dedup_key``. Output order is stable: blocks
    are emitted in sorted-date order (undated last) and clusters in first-seen
    order within a block.
    """

    blocks = block_by_date(records)
    merged: list[MergedEvent] = []

    for block_date in _sorted_block_keys(blocks):
        for members, possible_duplicate in _cluster_block(
            blocks[block_date], config=config
        ):
            representative = _canonical_member(members)
            dedup_key = compute_dedup_key(
                block_date,
                representative.title,
                representative.location,
                representative.start_time,
            )
            merged.append(
                MergedEvent(
                    dedup_key=dedup_key,
                    members=members,
                    possible_duplicate=possible_duplicate,
                )
            )

    return merged


def _sorted_block_keys(
    blocks: dict[date | None, list[NormalizedRecord]],
) -> list[date | None]:
    """Return block dates in ascending order with the undated block (None) last."""

    dated = sorted(d for d in blocks if d is not None)
    result: list[date | None] = list(dated)
    if None in blocks:
        result.append(None)
    return result


__all__ = [
    "FINGERPRINT_TIME_ROUNDING_MINUTES",
    "MergedEvent",
    "compute_dedup_key",
    "compute_identity_key",
    "deduplicate",
]
