"""Tests for the grounded daily brief.

The brief must be a pure function of the feed: every claim computable from the
supplied events, nothing invented, no model and no credentials involved, and
cached by a content hash of exactly the fields it reads.
"""

from __future__ import annotations

from datetime import date, time

from vandy_food_radar.models import (
    Event,
    FoodCategory,
    FoodConfirmed,
    VerificationState,
)
from vandy_food_radar.summary import build_brief, content_hash

from .support import DEMO_DAY, make_event


def _event(
    title: str,
    *,
    start: time | None = None,
    category: FoodCategory = FoodCategory.FULL_MEAL,
    confirmed: FoodConfirmed = FoodConfirmed.CONFIRMED,
    state: VerificationState = VerificationState.VERIFIED,
    score: float | None = 0.5,
) -> Event:
    return make_event(
        identity_key=f"2025-03-11|{title.lower()}",
        event_id=f"evt-{title.lower().replace(' ', '-')}",
        title=title,
        start_time=start,
        food_category=category,
        food_confirmed=confirmed,
        verification_state=state,
        score_total=score,
    )


# ---------------------------------------------------------------------------
# empty and degenerate feeds
# ---------------------------------------------------------------------------


def test_an_empty_day_says_so_instead_of_inventing_activity() -> None:
    brief = build_brief(DEMO_DAY, [])
    assert brief.headline == "No listings"
    assert brief.target_date == DEMO_DAY
    assert brief.text == " ".join(brief.sentences)
    # The copy is the coordinator's to word; what must hold is that it reports
    # emptiness and asserts nothing about events, counts, or food.
    assert len(brief.sentences) >= 1
    assert "no events" in brief.text.lower() or "no free" in brief.text.lower()
    for invented in ("listing with free food", "full meal", "confirmed by a source"):
        assert invented not in brief.text


def test_a_fully_cancelled_day_is_described_as_cancelled() -> None:
    brief = build_brief(
        DEMO_DAY,
        [
            _event("Movie Night", state=VerificationState.CANCELLED),
            _event("Taco Tuesday", state=VerificationState.CANCELLED),
        ],
    )
    assert brief.headline == "All listings cancelled"
    assert brief.sentences[0] == "Every listing for this day is cancelled."
    assert "2 listings cancelled" in brief.text


# ---------------------------------------------------------------------------
# grounded content
# ---------------------------------------------------------------------------


def test_counts_and_earliest_start_come_from_the_feed() -> None:
    brief = build_brief(
        DEMO_DAY,
        [
            _event("Late Dinner", start=time(19, 30)),
            _event(
                "Morning Bagels",
                start=time(9, 0),
                category=FoodCategory.SNACKS_OR_REFRESHMENTS,
            ),
        ],
    )
    assert brief.sentences[0] == "2 listings with free food, starting from 9 AM."
    assert "1 event describes a full meal rather than snacks." in brief.sentences
    assert "Free food is confirmed by a source for all of them." in brief.sentences


def test_a_single_listing_is_phrased_in_the_singular() -> None:
    brief = build_brief(DEMO_DAY, [_event("Solo Supper", start=time(18, 15))])
    assert brief.sentences[0] == "1 listing with free food, starting from 6:15 PM."
    assert brief.headline == "1 listing \u00b7 top: Solo Supper"


def test_a_day_with_no_listed_start_times_omits_the_time_clause() -> None:
    brief = build_brief(DEMO_DAY, [_event("Unknown Hour")])
    assert brief.sentences[0] == "1 listing with free food."


def test_snack_only_days_say_so() -> None:
    brief = build_brief(
        DEMO_DAY,
        [_event("Cookies", category=FoodCategory.SNACKS_OR_REFRESHMENTS)],
    )
    assert "All of them describe snacks or unspecified food." in brief.sentences


def test_partial_confirmation_is_reported_as_a_fraction() -> None:
    brief = build_brief(
        DEMO_DAY,
        [
            _event("Confirmed Dinner"),
            _event("Maybe Snacks", confirmed=FoodConfirmed.UNCONFIRMED),
        ],
    )
    assert "Free food is confirmed by a source for 1 of 2." in brief.sentences


def test_caveats_combine_cancellations_and_conflicts() -> None:
    brief = build_brief(
        DEMO_DAY,
        [
            _event("Good Dinner"),
            _event("Disputed Lunch", state=VerificationState.CONFLICTING),
            _event("Dropped Social", state=VerificationState.CANCELLED),
        ],
    )
    caveat = next(s for s in brief.sentences if s.startswith("Check "))
    assert caveat == (
        "Check 1 listing cancelled and 1 listing with conflicting details."
    )
    # Cancelled listings are excluded from the active count.
    assert brief.sentences[0].startswith("2 listings with free food")


def test_the_headline_top_pick_is_the_highest_scoring_active_event() -> None:
    brief = build_brief(
        DEMO_DAY,
        [
            _event("Runner Up", score=0.4),
            _event("Best Dinner", score=0.9),
            _event("Cancelled Winner", score=1.0, state=VerificationState.CANCELLED),
        ],
    )
    assert brief.headline == "2 listings \u00b7 top: Best Dinner"


def test_the_brief_mentions_no_event_outside_the_feed() -> None:
    brief = build_brief(DEMO_DAY, [_event("Only Listing")])
    assert "Only Listing" in brief.text + brief.headline
    for absent in ("Free Pizza Night", "AnchorLink", "AI", "estimated"):
        assert absent not in brief.text


# ---------------------------------------------------------------------------
# content hashing and caching
# ---------------------------------------------------------------------------


def test_the_hash_ignores_input_order() -> None:
    first = _event("Alpha", start=time(10, 0))
    second = _event("Beta", start=time(11, 0))
    assert content_hash(DEMO_DAY, [first, second]) == content_hash(
        DEMO_DAY, [second, first]
    )


def test_the_hash_tracks_every_field_the_brief_reads() -> None:
    base = [_event("Alpha", start=time(10, 0))]
    baseline = content_hash(DEMO_DAY, base)

    assert content_hash(date(2025, 3, 12), base) != baseline
    assert baseline != content_hash(DEMO_DAY, [_event("Alpha", start=time(11, 0))])
    assert baseline != content_hash(
        DEMO_DAY,
        [_event("Alpha", start=time(10, 0), category=FoodCategory.UNSPECIFIED)],
    )
    assert baseline != content_hash(
        DEMO_DAY,
        [_event("Alpha", start=time(10, 0), state=VerificationState.CANCELLED)],
    )
    assert baseline != content_hash(
        DEMO_DAY, [_event("Alpha", start=time(10, 0), score=0.51)]
    )


def test_the_hash_is_stable_for_identical_input() -> None:
    events = [_event("Alpha", start=time(10, 0))]
    assert content_hash(DEMO_DAY, events) == content_hash(DEMO_DAY, events)
    assert len(content_hash(DEMO_DAY, events)) == 64


def test_identical_input_is_served_from_the_cache() -> None:
    events = [_event("Cached Dinner", start=time(18, 0))]
    first = build_brief(DEMO_DAY, events)
    second = build_brief(DEMO_DAY, events)
    assert first is second
    assert first.content_hash == content_hash(DEMO_DAY, events)


def test_a_changed_feed_produces_a_new_brief() -> None:
    first = build_brief(DEMO_DAY, [_event("Dinner A", start=time(18, 0))])
    second = build_brief(DEMO_DAY, [_event("Dinner A", start=time(19, 0))])
    assert first is not second
    assert first.content_hash != second.content_hash
    assert first.sentences != second.sentences
