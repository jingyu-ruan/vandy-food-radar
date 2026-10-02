"""Short, verbatim food excerpts for cards; full listings remain in details."""

from __future__ import annotations

import re

_FOOD_WORDS = re.compile(
    r"\b(?:food|dinner|lunch|breakfast|brunch|pizza|tacos?|buffet|meal|"
    r"coffee|matcha|tea|snacks?|cookies|refreshments|baked goods|treats?)\b",
    re.IGNORECASE,
)
_SENTENCE_BREAK = re.compile(
    r"(?<!\bSt\.)(?<!\bDr\.)(?<!\bProf\.)(?<!\bMr\.)(?<!\bMs\.)(?<!\bMrs\.)"
    r"(?<!\ba\.m\.)(?<!\bp\.m\.)(?<=[.!?])\s+",
    re.IGNORECASE,
)


def food_excerpt(description: str | None, *, limit: int = 180) -> str | None:
    """Use a published food sentence without rewriting or inventing details."""
    if not description:
        return None
    text = re.sub(r"\s+", " ", description).strip()
    sentences = _SENTENCE_BREAK.split(text)
    matches = [sentence for sentence in sentences if _FOOD_WORDS.search(sentence)]
    if not matches:
        return None
    excerpt = " ".join(matches[:2])
    if len(excerpt) <= limit:
        return excerpt
    return excerpt[: limit - 1].rsplit(" ", 1)[0].rstrip(".,;:") + "…"
