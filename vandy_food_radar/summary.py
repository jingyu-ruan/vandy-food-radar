"""Deterministic daily brief generated from the published feed.

The brief answers "what does today look like?" in two or three sentences. It is
assembled by fixed rules from values already present in the feed — counts, the
earliest start, the top-ranked title, how many listings are cancelled or carry
conflicts. No language model is involved, no API key is required, and nothing
is asserted that is not computable from the events themselves. If the feed is
empty the brief says so instead of inventing activity.

Because it is a pure function of the feed, it is cached by a content hash of
the exact inputs it reads. Re-rendering the same day costs one hash.
"""

from __future__ import annotations

import hashlib
from collections import OrderedDict
from dataclasses import dataclass
from datetime import date, time

from .models import Event, FoodCategory, FoodConfirmed, VerificationState

# Bounded memo: the app only ever shows a handful of days at a time.
_CACHE_LIMIT = 64
_cache: OrderedDict[str, DailyBrief] = OrderedDict()


@dataclass(frozen=True)
class DailyBrief:
    """A grounded brief for one local day.

    ``headline`` is a short status line; ``sentences`` are the supporting facts
    in reading order. ``content_hash`` identifies the exact feed state the brief
    was derived from.
    """

    target_date: date
    headline: str
    sentences: tuple[str, ...]
    content_hash: str

    @property
    def text(self) -> str:
        """The brief as one paragraph."""

        return " ".join(self.sentences)


def _format_time(value: time) -> str:
    """Render a local time the way the cards do (12-hour, no leading zero)."""

    hour = value.hour % 12 or 12
    suffix = "AM" if value.hour < 12 else "PM"
    if value.minute:
        return f"{hour}:{value.minute:02d} {suffix}"
    return f"{hour} {suffix}"


def content_hash(target_date: date, events: list[Event]) -> str:
    """Hash exactly the fields the brief reads, in a stable order."""

    digest = hashlib.sha256()
    digest.update(target_date.isoformat().encode("utf-8"))
    rows = sorted(
        (
            event.identity_key,
            event.title,
            event.start_time.isoformat() if event.start_time else "",
            event.end_time.isoformat() if event.end_time else "",
            event.location or "",
            event.food_category.value,
            event.food_confirmed.value,
            event.verification_state.value,
            f"{event.score_total:.6f}" if event.score_total is not None else "",
        )
        for event in events
    )
    for row in rows:
        digest.update("\x1f".join(row).encode("utf-8"))
        digest.update(b"\x1e")
    return digest.hexdigest()


def _plural(count: int, singular: str, plural: str | None = None) -> str:
    word = singular if count == 1 else (plural or f"{singular}s")
    return f"{count} {word}"


def build_brief(target_date: date, events: list[Event]) -> DailyBrief:
    """Build (and cache) the brief for ``target_date``.

    Every sentence is derived from the supplied events; nothing is asserted
    about days or sources that are not represented in the input.
    """

    key = content_hash(target_date, events)
    cached = _cache.get(key)
    if cached is not None:
        _cache.move_to_end(key)
        return cached

    brief = _compose(target_date, events, key)
    _cache[key] = brief
    while len(_cache) > _CACHE_LIMIT:
        _cache.popitem(last=False)
    return brief


def _compose(target_date: date, events: list[Event], key: str) -> DailyBrief:
    if not events:
        return DailyBrief(
            target_date=target_date,
            headline="No listings",
            sentences=(
                "There are no events to display for this date.",
                "Check another date or try again after the next refresh.",
            ),
            content_hash=key,
        )

    active = [
        event
        for event in events
        if event.verification_state is not VerificationState.CANCELLED
    ]
    cancelled = len(events) - len(active)
    meals = sum(1 for event in active if event.food_category is FoodCategory.FULL_MEAL)
    confirmed = sum(
        1 for event in active if event.food_confirmed is FoodConfirmed.CONFIRMED
    )
    conflicting = sum(
        1
        for event in active
        if event.verification_state is VerificationState.CONFLICTING
    )
    starts = sorted(event.start_time for event in active if event.start_time)

    sentences: list[str] = []
    if active:
        lead = f"{_plural(len(active), 'listing')} with free food"
        if starts:
            lead += f", starting from {_format_time(starts[0])}"
        sentences.append(f"{lead}.")
    else:
        sentences.append("Every listing for this day is cancelled.")

    if meals:
        sentences.append(
            f"{_plural(meals, 'event')} describe a full meal rather than snacks."
            if meals != 1
            else "1 event describes a full meal rather than snacks."
        )
    elif active:
        sentences.append("All of them describe snacks or unspecified food.")

    if confirmed and confirmed < len(active):
        sentences.append(
            f"Free food is confirmed by a source for {confirmed} of {len(active)}."
        )
    elif active and confirmed == len(active):
        sentences.append("Free food is confirmed by a source for all of them.")

    caveats: list[str] = []
    if cancelled:
        caveats.append(f"{_plural(cancelled, 'listing')} cancelled")
    if conflicting:
        caveats.append(f"{_plural(conflicting, 'listing')} with conflicting details")
    if caveats:
        sentences.append(f"Check {' and '.join(caveats)}.")

    top = next(
        (
            event
            for event in sorted(
                active,
                key=lambda item: (
                    -(item.score_total if item.score_total is not None else 0.0),
                    item.title.lower(),
                ),
            )
        ),
        None,
    )
    if top is not None:
        headline = f"{_plural(len(active), 'listing')} \u00b7 top: {top.title}"
    else:
        headline = "All listings cancelled"

    return DailyBrief(
        target_date=target_date,
        headline=headline,
        sentences=tuple(sentences),
        content_hash=key,
    )


__all__ = ["DailyBrief", "build_brief", "content_hash"]
