"""Normalization stage (design.md §3.2, T3.1-T3.4, FR-8-FR-11).

Pure, deterministic, no-I/O helpers that convert a source's shallow
``parsed_fields`` into canonical event field values while preserving the
per-source originals. Comprises timezone-aware date/time parsing that flags
(never drops) unparseable values, a documented keyword-table food classifier,
and the normalizer that ties them together.
"""

from __future__ import annotations

from .datetime_parse import (
    ParsedDate,
    ParsedTime,
    parse_event_date,
    parse_event_time,
)
from .food_classifier import (
    FOOD_CATEGORY_KEYWORDS,
    FOOD_CONFIRMED_KEYWORDS,
    FOOD_NEGATION_KEYWORDS,
    FoodClassification,
    classify_food,
)
from .normalizer import NormalizedRecord, normalize

__all__ = [
    "FOOD_CATEGORY_KEYWORDS",
    "FOOD_CONFIRMED_KEYWORDS",
    "FOOD_NEGATION_KEYWORDS",
    "FoodClassification",
    "NormalizedRecord",
    "ParsedDate",
    "ParsedTime",
    "classify_food",
    "normalize",
    "parse_event_date",
    "parse_event_time",
]
