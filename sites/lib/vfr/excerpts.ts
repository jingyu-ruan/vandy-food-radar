/**
 * Short, verbatim food excerpts for cards; the full listing stays in details.
 *
 * Ported from the Python reference (`vandy_food_radar/web/excerpts.py`). Only
 * sentences the source published are used, unchanged apart from whitespace.
 */

const FOOD_WORDS =
  /\b(?:food|dinner|lunch|breakfast|brunch|pizza|tacos?|buffet|meal|coffee|matcha|tea|snacks?|cookies|refreshments|baked goods|treats?|boba|donuts?|doughnuts?|bagels?|sandwich(?:es)?|burgers?|pastries|cupcakes?|ice cream|pasta|sushi|barbecue|bbq|catering|catered)\b/i;

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

/** Source-only fallback for named food; generic meal/refreshment words stay unspecified. */
export function namedFoodItems(description:string|null):string[] {
  if (!description) return [];
  const matches:string[]=[];
  for (const sentence of description.replace(/\s+/g," ").split(SENTENCE_BREAK)) {
    if (/\b(?:no|not|without|won't|will not)\b/i.test(sentence)) continue;
    const named=sentence.match(/\b(?:pizza|tacos?|coffee|matcha|tea|cookies?|baked goods|boba|donuts?|doughnuts?|bagels?|sandwich(?:es)?|burgers?|pastries|cupcakes?|ice cream|pasta|sushi|barbecue|bbq|lemonade|(?:dirty )?sodas?)\b/gi) || [];
    matches.push(...named);
  }
  return [...new Set(matches)].slice(0,8);
}
