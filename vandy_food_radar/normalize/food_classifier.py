"""Documented keyword-table food classifier (design.md §3.2, T3.3, FR-11, E-6).

Maps free-text food descriptions to a :class:`~vandy_food_radar.models.FoodCategory`
and a :class:`~vandy_food_radar.models.FoodConfirmed` status using a small,
fully documented keyword table. There is deliberately **no** machine-learning
model (MVP constraint): the mapping is transparent so a user can understand why
an event was classified the way it was.

The classifier derives category and confirmed status *independently from the
description text*, so a record that lacks explicit ``food_category`` /
``food_confirmed`` keys is still classified from its wording. When a source
provides those keys, the normalizer may prefer them; this module only inspects
text.

Pure and deterministic: no network, DB, or file I/O.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..models import FoodCategory, FoodConfirmed

# ---------------------------------------------------------------------------
# Keyword table (documented, ordered by specificity)
# ---------------------------------------------------------------------------
#
# Category keywords. A description matching any FULL_MEAL keyword classifies as
# a full meal (a served meal generally outranks snacks in ranking, FR-11). Only
# if no full-meal signal is present do SNACKS_OR_REFRESHMENTS keywords apply.
# Matching is whole-word, case-insensitive, on the lowercased description.
FOOD_CATEGORY_KEYWORDS: dict[FoodCategory, tuple[str, ...]] = {
    FoodCategory.FULL_MEAL: (
        "dinner",
        "lunch",
        "breakfast",
        "brunch",
        "buffet",
        "meal",
        "pizza",
        "bbq",
        "barbecue",
        "tacos",
        "taco",
        "catered",
        "catering",
    ),
    FoodCategory.SNACKS_OR_REFRESHMENTS: (
        "refreshments",
        "snacks",
        "snack",
        "coffee",
        "cookies",
        "appetizers",
        "bagels",
        "popcorn",
        "light bites",
        "desserts",
        "dessert",
        "treats",
    ),
}

# Positive confirmation keywords: explicit free-food language or concrete menu
# items indicate the food is confirmed (FoodConfirmed.CONFIRMED).
FOOD_CONFIRMED_KEYWORDS: tuple[str, ...] = (
    "free food",
    "free pizza",
    "free lunch",
    "free dinner",
    "free breakfast",
    "food provided",
    "food will be provided",
    "lunch provided",
    "dinner provided",
    "breakfast provided",
    "refreshments provided",
    "snacks provided",
    "served",
    "catered",
    "menu",
)

# Negation keywords: explicit statements that no food is available contradict a
# food claim (FoodConfirmed.CONTRADICTED). Checked before positive keywords so
# a "no free food" phrase is not mistaken for a confirmation (E-6).
FOOD_NEGATION_KEYWORDS: tuple[str, ...] = (
    "no free food",
    "no food",
    "food not provided",
    "food will not be provided",
    "byo",
    "bring your own",
)


@dataclass(frozen=True)
class FoodClassification:
    """Category + confirmed status derived from a description.

    ``matched_keywords`` lists the keywords that drove the decision so the
    result stays explainable (FR-11).
    """

    category: FoodCategory
    confirmed: FoodConfirmed
    matched_keywords: tuple[str, ...]


def _contains_word(text: str, keyword: str) -> bool:
    """Return whether ``keyword`` appears in ``text`` on word boundaries.

    Multi-word keywords are matched as a contiguous phrase. Matching is
    whole-word so "meal" does not match "oatmeal".
    """

    pattern = r"\b" + re.escape(keyword) + r"\b"
    return re.search(pattern, text) is not None


def classify_food(description: str | None) -> FoodClassification:
    """Classify a food ``description`` via the documented keyword table.

    Category resolution (most specific first):
      * any FULL_MEAL keyword -> ``FULL_MEAL``
      * else any SNACKS_OR_REFRESHMENTS keyword -> ``SNACKS_OR_REFRESHMENTS``
      * else (non-empty text with no food keyword) -> ``UNSPECIFIED``
      * empty/missing text -> ``NONE``

    Confirmed resolution:
      * any negation keyword -> ``CONTRADICTED``
      * else any explicit free-food/menu keyword -> ``CONFIRMED``
      * else -> ``UNCONFIRMED`` (vague or absent)
    """

    if description is None or not description.strip():
        return FoodClassification(
            category=FoodCategory.NONE,
            confirmed=FoodConfirmed.UNCONFIRMED,
            matched_keywords=(),
        )

    text = description.lower()
    matched: list[str] = []

    # --- category ---------------------------------------------------------
    category = FoodCategory.UNSPECIFIED
    full_meal_hits = [
        kw
        for kw in FOOD_CATEGORY_KEYWORDS[FoodCategory.FULL_MEAL]
        if _contains_word(text, kw)
    ]
    snack_hits = [
        kw
        for kw in FOOD_CATEGORY_KEYWORDS[FoodCategory.SNACKS_OR_REFRESHMENTS]
        if _contains_word(text, kw)
    ]
    if full_meal_hits:
        category = FoodCategory.FULL_MEAL
        matched.extend(full_meal_hits)
    elif snack_hits:
        category = FoodCategory.SNACKS_OR_REFRESHMENTS
        matched.extend(snack_hits)

    # --- confirmed --------------------------------------------------------
    negation_hits = [kw for kw in FOOD_NEGATION_KEYWORDS if _contains_word(text, kw)]
    confirmed_hits = [kw for kw in FOOD_CONFIRMED_KEYWORDS if _contains_word(text, kw)]
    if negation_hits:
        confirmed = FoodConfirmed.CONTRADICTED
        matched.extend(negation_hits)
    elif confirmed_hits:
        confirmed = FoodConfirmed.CONFIRMED
        matched.extend(confirmed_hits)
    else:
        confirmed = FoodConfirmed.UNCONFIRMED

    return FoodClassification(
        category=category,
        confirmed=confirmed,
        matched_keywords=tuple(dict.fromkeys(matched)),
    )


__all__ = [
    "FOOD_CATEGORY_KEYWORDS",
    "FOOD_CONFIRMED_KEYWORDS",
    "FOOD_NEGATION_KEYWORDS",
    "FoodClassification",
    "classify_food",
]
