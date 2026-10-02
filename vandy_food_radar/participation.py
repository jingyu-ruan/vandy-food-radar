"""Deterministic participation assessment from listed event text.

Answers one practical question for a reader: *can I just show up?* The answer is
derived from the event title, description, and organizer name. Explicit access
and eligibility statements take priority. Familiar activity formats also yield
small, labelled inferences about participation; missing evidence stays neutral.
No external model is consulted, and matching phrases are retained for review.

Two distinct outputs come out of one pass:

* a coarse :class:`ParticipationLevel` plus a short product-UI note, and
* zero or more ``restrictions``: explicit eligibility limits ("members only",
  "graduate students only"). These are surfaced to the reader as warnings. They
  are deliberately *not* folded into the ranking score, because an event that is
  genuinely closed to someone is not "slightly worse" — it is a caveat they need
  to read.

The convenience value returned by :func:`participation_factor_value` is the only
thing ranking consumes, and it is capped by
``RankingConfig.participation_influence``.

Pure and deterministic: no I/O, no clock, no randomness.
"""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import StrEnum

from .models import Event, SourceRecord

# ---------------------------------------------------------------------------
# Evidence patterns
# ---------------------------------------------------------------------------

# Phrases that explicitly invite anyone to attend.
_OPEN_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"open to (?:the )?(?:all|everyone|public|any(?:one)?)", "open to everyone"),
    (r"(?:all|any) (?:are |is )?welcome", "all welcome"),
    (r"free (?:and )?open to the public", "free and open to the public"),
    (
        r"no (?:rsvp|registration|sign[- ]?up|ticket)s? "
        r"(?:is |are )?(?:required|needed)",
        "no registration required",
    ),
    (r"(?:drop|walk)[- ]ins? welcome", "drop-ins welcome"),
    (r"for all (?:vanderbilt )?students", "for all students"),
    (
        r"all (?:vanderbilt )?students (?:are )?(?:welcome|invited)",
        "all students welcome",
    ),
    (r"everyone (?:is )?welcome", "everyone welcome"),
    (
        r"(?:absolutely )?everyone (?:can (?:join|attend)|is invited)",
        "everyone invited",
    ),
    (r"who can join[: ]+absolutely everyone", "everyone invited"),
)

# Phrases that explicitly restrict who may attend. These become warnings.
_RESTRICTION_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"members? only", "listed as members only"),
    (r"(?:by )?invit(?:ation|e)[- ]only", "listed as invitation only"),
    (
        r"(?:must be|only for|restricted to|limited to) "
        r"(?:current )?(?:members|affiliates)",
        "limited to members",
    ),
    (
        r"(graduate|grad|undergraduate|undergrad|doctoral|phd|law|medical|nursing|mba)"
        r"[- ](?:students? )?only",
        "limited to one student population",
    ),
    (
        r"(?:first[- ]year|freshman|sophomore|junior|senior)s? only",
        "limited to one class year",
    ),
    (r"(?:faculty|staff|alumni)[- ]only", "limited to faculty, staff, or alumni"),
    (
        r"(?:ticket|badge|registration) required to (?:enter|attend)",
        "entry requires a ticket or registration",
    ),
    (r"closed (?:event|to the public)", "listed as a closed event"),
    (
        r"(?:for|open to) (?:dues[- ]paying|registered) members",
        "limited to registered members",
    ),
    (r"must (?:be|have) (?:a )?(?:member|registered)", "requires membership"),
)

# Phrases that signal a capacity limit: not a hard restriction, but it changes
# whether arriving late is worth it, so it is reported rather than scored.
_CAPACITY_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"while supplies last", "food is served while supplies last"),
    (r"first[- ]come,?[- ]first[- ]served", "first come, first served"),
    (r"limited (?:seating|capacity|spots?|quantit)", "limited capacity"),
    (r"space is limited", "limited capacity"),
)

_WHITESPACE = re.compile(r"\s+")


class ParticipationLevel(StrEnum):
    """How open an event appears to be, based on explicit listed evidence."""

    OPEN = "open"
    RESTRICTED = "restricted"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class ParticipationAssessment:
    """The outcome of one assessment.

    ``level`` is the coarse classification. ``note`` is a single product-UI
    sentence. ``evidence`` lists the exact normalized phrases that were matched,
    so the inference can be checked against the listing. ``restrictions`` and
    ``capacity_notes`` are reader-facing warnings. ``certain`` is ``False``
    whenever the level rests on no evidence or on conflicting evidence, and the
    note then says so explicitly instead of overstating the inference.
    """

    level: ParticipationLevel
    note: str
    certain: bool
    evidence: tuple[str, ...] = ()
    restrictions: tuple[str, ...] = ()
    capacity_notes: tuple[str, ...] = ()
    convenience: float | None = None

    @property
    def warnings(self) -> tuple[str, ...]:
        """Reader-facing warnings: eligibility limits first, then capacity."""

        return (*self.restrictions, *self.capacity_notes)


def _normalize(text: str) -> str:
    """Lowercase and collapse whitespace so patterns match wrapped prose."""

    return _WHITESPACE.sub(" ", text.lower()).strip()


def _collect(
    haystack: str, patterns: tuple[tuple[str, str], ...]
) -> tuple[list[str], list[str]]:
    """Return (matched phrases, human labels) for ``patterns`` in ``haystack``."""

    phrases: list[str] = []
    labels: list[str] = []
    for pattern, label in patterns:
        match = re.search(pattern, haystack)
        if match is None:
            continue
        phrase = _WHITESPACE.sub(" ", match.group(0)).strip()
        if phrase not in phrases:
            phrases.append(phrase)
        if label not in labels:
            labels.append(label)
    return phrases, labels


@dataclass(frozen=True)
class ParticipationInput:
    """The listed text an assessment is allowed to read.

    Every field comes from data a source actually published. ``extra_texts``
    carries additional descriptions kept on the event's
    :class:`~vandy_food_radar.models.SourceRecord` rows so the assessment sees
    the full description rather than only the condensed food summary.
    """

    title: str | None = None
    description: str | None = None
    organizer: str | None = None
    extra_texts: tuple[str, ...] = field(default_factory=tuple)

    def combined_text(self) -> str:
        """Return the normalized concatenation of every supplied text."""

        parts = [self.title, self.description, self.organizer, *self.extra_texts]
        return _normalize(" \n ".join(part for part in parts if part))


def assess_participation(source: ParticipationInput) -> ParticipationAssessment:
    """Assess participation openness from explicit listed evidence only.

    Returns :attr:`ParticipationLevel.UNKNOWN` with ``certain=False`` when the
    text says nothing either way — the common case for a terse listing — rather
    than guessing. Conflicting evidence (an open invitation alongside an
    explicit limit) resolves to ``RESTRICTED`` and is reported as uncertain,
    because the restriction is the part a reader must not miss.
    """

    text = source.combined_text()
    if not text:
        return ParticipationAssessment(
            level=ParticipationLevel.UNKNOWN,
            note="Participation details are not described in the listing.",
            certain=False,
        )

    open_phrases, _open_labels = _collect(text, _OPEN_PATTERNS)
    restrict_phrases, restrict_labels = _collect(text, _RESTRICTION_PATTERNS)
    _capacity_phrases, capacity_labels = _collect(text, _CAPACITY_PATTERNS)

    restrictions = tuple(restrict_labels)
    capacity_notes = tuple(capacity_labels)

    if restrict_phrases and open_phrases:
        return ParticipationAssessment(
            level=ParticipationLevel.RESTRICTED,
            note=(
                "The listing both invites a general audience and states a "
                "limit, so eligibility is unclear — check the source."
            ),
            certain=False,
            evidence=tuple([*open_phrases, *restrict_phrases]),
            restrictions=restrictions,
            capacity_notes=capacity_notes,
        )

    if restrict_phrases:
        return ParticipationAssessment(
            level=ParticipationLevel.RESTRICTED,
            note=f"The listing states a limit on who can attend: {restrictions[0]}.",
            certain=True,
            evidence=tuple(restrict_phrases),
            restrictions=restrictions,
            capacity_notes=capacity_notes,
        )

    if open_phrases:
        return ParticipationAssessment(
            level=ParticipationLevel.OPEN,
            note=f"The listing says anyone can attend ({open_phrases[0]}).",
            certain=True,
            evidence=tuple(open_phrases),
            capacity_notes=capacity_notes,
        )

    # Format can suggest social friction without establishing eligibility.
    # Keep that inference distinct from the explicit restrictions above.
    formats = (
        (
            r"grab something to go|drop[- ](?:by|in)|tabling|cafe hours",
            0.85,
            "The drop-in format suggests a brief visit is comfortable.",
        ),
        (
            r"workshop|training session|bible|worship|general body meeting"
            r"|\bdiscussion\b",
            0.35,
            "The program suggests active participation or discussion.",
        ),
        (
            r"study break|hang(?:out|(?:ing)? out)|social gathering|casual space"
            r"|recharge",
            0.8,
            "The casual gathering suggests a relaxed visit and some conversation.",
        ),
        (
            r"house community|faculty head|fellow.{0,25}residents",
            0.5,
            "The gathering appears centered on a residential community.",
        ),
        (
            r"networking|research opportunities|career fair",
            0.55,
            "The format suggests conversations about the event's subject.",
        ),
    )
    for pattern, convenience, note in formats:
        match = re.search(pattern, text)
        if match:
            return ParticipationAssessment(
                level=ParticipationLevel.UNKNOWN,
                note=f"Inferred: {note}",
                certain=False,
                evidence=(match.group(0),),
                capacity_notes=capacity_notes,
                convenience=convenience,
            )
    return ParticipationAssessment(
        level=ParticipationLevel.UNKNOWN,
        note="The listing gives too little detail to assess the participation format.",
        certain=False,
        capacity_notes=capacity_notes,
    )


def participation_factor_value(
    assessment: ParticipationAssessment, *, unknown_value: float
) -> float:
    """Map an assessment to the ranking factor value in ``[0, 1]``.

    An explicitly open event scores ``1.0``; anything without explicit evidence
    uses ``unknown_value`` so a terse listing is neither rewarded nor punished.
    A stated restriction returns the same neutral value: the restriction is
    communicated as a warning, not as a quiet score penalty.
    """

    if assessment.level is ParticipationLevel.OPEN:
        return 1.0
    if assessment.convenience is not None:
        return min(1.0, max(0.0, assessment.convenience))
    return unknown_value


# Bound on how much listed text one assessment reads, so a pathological payload
# cannot turn a regex scan into a performance problem.
_MAX_TEXT_CHARS = 4000
_MAX_EXTRA_TEXTS = 8


def participation_input_for(
    event: Event,
    source_records: Sequence[SourceRecord] = (),
) -> ParticipationInput:
    """Build the assessment input for ``event`` from its own published text.

    Reads the canonical title/organizer/food summary plus the fuller
    descriptions retained on the event's source records, so the assessment sees
    what the listing actually said rather than only the condensed summary. The
    pipeline and the web layer both call this, so the score and the card note
    can never be derived from different text.
    """

    extras: list[str] = []

    def _add(value: object) -> None:
        if len(extras) >= _MAX_EXTRA_TEXTS:
            return
        if isinstance(value, str) and value.strip():
            trimmed = value.strip()[:_MAX_TEXT_CHARS]
            if trimmed not in extras:
                extras.append(trimmed)

    for record in source_records:
        fields = record.parsed_fields
        if isinstance(fields, dict):
            _add(fields.get("description"))
            _add(fields.get("food_description"))
        _add(_payload_description(record.raw_payload))

    return ParticipationInput(
        title=event.title or None,
        description=event.food_description,
        organizer=event.organizer,
        extra_texts=tuple(extras),
    )


def _payload_description(raw_payload: str | None) -> str | None:
    """Extract a ``description`` field from a JSON source payload, if present."""

    if not raw_payload or not raw_payload.lstrip().startswith("{"):
        return None
    try:
        payload = json.loads(raw_payload)
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    description = payload.get("description")
    return description if isinstance(description, str) else None


__all__ = [
    "ParticipationAssessment",
    "ParticipationInput",
    "ParticipationLevel",
    "assess_participation",
    "participation_factor_value",
    "participation_input_for",
]
