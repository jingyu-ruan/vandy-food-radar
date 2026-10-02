/**
 * Short, verbatim food excerpts for cards; the full listing stays in details.
 *
 * Ported from the Python reference (`vandy_food_radar/web/excerpts.py`). Only
 * sentences the source published are used, unchanged apart from whitespace.
 */

const FOOD_WORDS =
  /\b(?:food|dinner|lunch|breakfast|brunch|pizza|tacos?|buffet|meal|coffee|matcha|tea|snacks?|cookies|refreshments|baked goods|treats?)\b/i;

// Split after sentence punctuation, but not after common abbreviations.
const SENTENCE_BREAK =
  /(?<!\bSt\.)(?<!\bDr\.)(?<!\bProf\.)(?<!\bMr\.)(?<!\bMs\.)(?<!\bMrs\.)(?<!\ba\.m\.)(?<!\bp\.m\.)(?<=[.!?])\s+/i;

/** Up to two published sentences that mention food, bounded to `limit`. */
export function foodExcerpt(description: string | null, limit = 180): string | null {
  if (!description) return null;
  const text = description.replace(/\s+/g, " ").trim();
  const matches = text.split(SENTENCE_BREAK).filter((sentence) => FOOD_WORDS.test(sentence));
  if (matches.length === 0) return null;
  const excerpt = matches.slice(0, 2).join(" ");
  if (excerpt.length <= limit) return excerpt;
  const cut = excerpt.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  const head = space >= 0 ? cut.slice(0, space) : cut;
  return `${head.replace(/[.,;:]+$/, "")}\u2026`;
}
