/**
 * Text handling for untrusted source content.
 *
 * Source descriptions arrive as HTML from a third party. They are reduced to
 * plain text here and are never treated as markup anywhere downstream: the UI
 * renders them as React text nodes, so no `dangerouslySetInnerHTML` and no
 * embedded script, style, iframe, or event handler can survive the round trip.
 */

/** Named entities worth decoding once tags are gone. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
      // Lone surrogates are not valid scalar values.
      if (code >= 0xd800 && code <= 0xdfff) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/**
 * Reduce an HTML fragment to a single-line plain-text string.
 *
 * Script and style bodies are dropped entirely rather than being flattened
 * into the visible text. Returns `null` for absent or whitespace-only input so
 * a missing description stays missing instead of becoming an empty string.
 */
export function htmlToPlainText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const withoutHiddenBodies = value
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withoutTags = withoutHiddenBodies.replace(/<[^>]*>/g, " ");
  const decoded = decodeEntities(withoutTags);
  const collapsed = decoded.replace(/\s+/g, " ").trim();
  return collapsed || null;
}

/** Return a trimmed string for non-empty text, otherwise `null`. */
export function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Return a tri-state boolean: `null` when the source did not specify one. */
export function asBool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
