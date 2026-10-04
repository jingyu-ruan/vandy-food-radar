/**
 * Deterministic participation assessment from listed event text.
 *
 * Ported from the Python reference (`vandy_food_radar/participation.py`). It
 * answers one practical question — can I just show up? — from the title, the
 * full source description, and the organizer. Explicit access and eligibility
 * statements take priority. Familiar activity formats also yield small,
 * labelled inferences; missing evidence stays neutral. No model is consulted,
 * and the matching phrases are retained so an inference can be checked.
 *
 * Explicit eligibility limits ("members only", "graduate students only") are
 * reader-facing warnings. They are deliberately *not* folded into ranking: an
 * event closed to someone is a caveat to read, not a slightly worse event. The
 * participation assessment stays separate from the five food-focused ranking factors.
 *
 * Pure: no I/O, no clock, no randomness.
 */

import type { Event, SourceRecord } from "./models.ts";
import { htmlToPlainText } from "./text.ts";

type Pattern = readonly [RegExp, string];

/** Phrases that explicitly invite anyone to attend. */
const OPEN_PATTERNS: readonly Pattern[] = [
  [/open to (?:the )?(?:all|everyone|public|any(?:one)?)/, "open to everyone"],
  [/(?:all|any) (?:are |is )?welcome/, "all welcome"],
  [/free (?:and )?open to the public/, "free and open to the public"],
  [
    /no (?:rsvp|registration|sign[- ]?up|ticket)s? (?:is |are )?(?:required|needed)/,
    "no registration required",
  ],
  [/(?:drop|walk)[- ]ins? welcome/, "drop-ins welcome"],
  [/for all (?:vanderbilt )?students/, "for all students"],
  [/all (?:vanderbilt )?students (?:are )?(?:welcome|invited)/, "all students welcome"],
  [/everyone (?:is )?welcome/, "everyone welcome"],
  [/(?:absolutely )?everyone (?:can (?:join|attend)|is invited)/, "everyone invited"],
  [/who can join[: ]+absolutely everyone/, "everyone invited"],
];

/** Phrases that explicitly restrict who may attend. These become warnings. */
const RESTRICTION_PATTERNS: readonly Pattern[] = [
  [/members? only/, "listed as members only"],
  [/(?:by )?invit(?:ation|e)[- ]only/, "listed as invitation only"],
  [
    /(?:must be|only for|restricted to|limited to) (?:current )?(?:members|affiliates)/,
    "limited to members",
  ],
  [
    /(graduate|grad|undergraduate|undergrad|doctoral|phd|law|medical|nursing|mba)[- ](?:students? )?only/,
    "limited to one student population",
  ],
  [/(?:first[- ]year|freshman|sophomore|junior|senior)s? only/, "limited to one class year"],
  [/(?:faculty|staff|alumni)[- ]only/, "limited to faculty, staff, or alumni"],
  [
    /(?:ticket|badge|registration) required to (?:enter|attend)/,
    "entry requires a ticket or registration",
  ],
  [/closed (?:event|to the public)/, "listed as a closed event"],
  [/(?:for|open to) (?:dues[- ]paying|registered) members/, "limited to registered members"],
  [/must (?:be|have) (?:a )?(?:member|registered)/, "requires membership"],
];

/** Capacity limits: not a restriction, but worth knowing before arriving late. */
const CAPACITY_PATTERNS: readonly Pattern[] = [
  [/while supplies last/, "food is served while supplies last"],
  [/first[- ]come,?[- ]first[- ]served/, "first come, first served"],
  [/limited (?:seating|capacity|spots?|quantit)/, "limited capacity"],
  [/space is limited/, "limited capacity"],
];

/** Familiar formats: a labelled inference, never an eligibility claim. */
const FORMAT_PATTERNS: readonly (readonly [RegExp, number, string])[] = [
  [
    /grab something to go|drop[- ](?:by|in)|tabling|cafe hours/,
    0.85,
    "The drop-in format suggests a brief visit is comfortable.",
  ],
  [
    /workshop|training session|bible|worship|general body meeting|\bdiscussion\b/,
    0.35,
    "The program suggests active participation or discussion.",
  ],
  [
    /study break|hang(?:out|(?:ing)? out)|social gathering|casual space|recharge/,
    0.8,
    "The casual gathering suggests a relaxed visit and some conversation.",
  ],
  [
    /house community|faculty head|fellow.{0,25}residents/,
    0.5,
    "The gathering appears centered on a residential community.",
  ],
  [
    /networking|research opportunities|career fair/,
    0.55,
    "The format suggests conversations about the event's subject.",
  ],
];

export const ParticipationLevel = {
  OPEN: "open",
  RESTRICTED: "restricted",
  UNKNOWN: "unknown",
} as const;
export type ParticipationLevel = (typeof ParticipationLevel)[keyof typeof ParticipationLevel];

export type ParticipationAssessment = {
  level: ParticipationLevel;
  /** One product-UI sentence. */
  note: string;
  /** False whenever the level rests on no evidence or conflicting evidence. */
  certain: boolean;
  /** Exact normalized phrases that matched. */
  evidence: string[];
  restrictions: string[];
  capacityNotes: string[];
  convenience: number | null;
};

export type ParticipationInput = {
  title: string | null;
  description: string | null;
  organizer: string | null;
  extraTexts: string[];
};

const WHITESPACE = /\s+/g;

function normalizeText(text: string): string {
  return text.toLowerCase().replace(WHITESPACE, " ").trim();
}

function collect(haystack: string, patterns: readonly Pattern[]): [string[], string[]] {
  const phrases: string[] = [];
  const labels: string[] = [];
  for (const [pattern, label] of patterns) {
    const match = pattern.exec(haystack);
    if (!match) continue;
    const phrase = match[0].replace(WHITESPACE, " ").trim();
    if (!phrases.includes(phrase)) phrases.push(phrase);
    if (!labels.includes(label)) labels.push(label);
  }
  return [phrases, labels];
}

/** Reader-facing warnings: eligibility limits first, then capacity. */
export function participationWarnings(assessment: ParticipationAssessment): string[] {
  return [...assessment.restrictions, ...assessment.capacityNotes];
}

function combinedText(input: ParticipationInput): string {
  const parts = [input.title, input.description, input.organizer, ...input.extraTexts];
  return normalizeText(parts.filter((part): part is string => Boolean(part)).join(" \n "));
}

/** Assess openness from explicit listed evidence only. */
export function assessParticipation(input: ParticipationInput): ParticipationAssessment {
  const text = combinedText(input);
  const base = { evidence: [], restrictions: [], capacityNotes: [], convenience: null };
  if (!text) {
    return {
      ...base,
      level: ParticipationLevel.UNKNOWN,
      note: "Participation details are not described in the listing.",
      certain: false,
    };
  }

  const [openPhrases] = collect(text, OPEN_PATTERNS);
  const [restrictPhrases, restrictions] = collect(text, RESTRICTION_PATTERNS);
  const [, capacityNotes] = collect(text, CAPACITY_PATTERNS);

  if (restrictPhrases.length && openPhrases.length) {
    return {
      ...base,
      level: ParticipationLevel.RESTRICTED,
      note:
        "The listing both invites a general audience and states a limit, so " +
        "eligibility is unclear \u2014 check the source.",
      certain: false,
      evidence: [...openPhrases, ...restrictPhrases],
      restrictions,
      capacityNotes,
    };
  }
  if (restrictPhrases.length) {
    return {
      ...base,
      level: ParticipationLevel.RESTRICTED,
      note: `The listing states a limit on who can attend: ${restrictions[0]}.`,
      certain: true,
      evidence: restrictPhrases,
      restrictions,
      capacityNotes,
    };
  }
  if (openPhrases.length) {
    return {
      ...base,
      level: ParticipationLevel.OPEN,
      note: `The listing says anyone can attend (${openPhrases[0]}).`,
      certain: true,
      evidence: openPhrases,
      capacityNotes,
    };
  }
  for (const [pattern, convenience, note] of FORMAT_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return {
        ...base,
        level: ParticipationLevel.UNKNOWN,
        note: `Inferred: ${note}`,
        certain: false,
        evidence: [match[0]],
        capacityNotes,
        convenience,
      };
    }
  }
  return {
    ...base,
    level: ParticipationLevel.UNKNOWN,
    note: "The listing gives too little detail to assess the participation format.",
    certain: false,
    capacityNotes,
  };
}

/**
 * The ranking factor value in [0, 1]. Open scores 1.0; a format inference
 * uses its convenience; everything else, including a stated restriction,
 * stays at the neutral value so a restriction is never a quiet penalty.
 */
export function participationFactorValue(
  assessment: ParticipationAssessment,
  unknownValue: number,
): number {
  if (assessment.level === ParticipationLevel.OPEN) return 1;
  if (assessment.convenience !== null) return Math.min(1, Math.max(0, assessment.convenience));
  return unknownValue;
}

/** Bounds so a pathological payload cannot turn a regex scan into a problem. */
const MAX_TEXT_CHARS = 4000;
const MAX_EXTRA_TEXTS = 8;

function payloadDescription(rawPayload: string | null): string | null {
  if (!rawPayload || !rawPayload.trimStart().startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(rawPayload);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    // AnchorLink descriptions are HTML; read them as plain text only.
    return htmlToPlainText((parsed as Record<string, unknown>).description);
  } catch {
    return null;
  }
}

type SourceText = Pick<SourceRecord, "parsedFields" | "rawPayload">;

/**
 * Build the assessment input from the event's own published text.
 *
 * The pipeline (for the score) and the read model (for the card note) both
 * call this, so the score and the note are never derived from different text.
 */
export function participationInputFor(
  event: Pick<Event, "title" | "foodDescription" | "organizer">,
  sources: readonly SourceText[] = [],
): ParticipationInput {
  const extras: string[] = [];
  const add = (value: unknown) => {
    if (extras.length >= MAX_EXTRA_TEXTS) return;
    if (typeof value === "string" && value.trim()) {
      const trimmed = value.trim().slice(0, MAX_TEXT_CHARS);
      if (!extras.includes(trimmed)) extras.push(trimmed);
    }
  };
  for (const source of sources) {
    const fields = source.parsedFields;
    if (fields && typeof fields === "object") {
      add(fields.description);
      add(fields.food_description);
    }
    add(payloadDescription(source.rawPayload));
  }
  return {
    title: event.title || null,
    description: event.foodDescription,
    organizer: event.organizer,
    extraTexts: extras,
  };
}
