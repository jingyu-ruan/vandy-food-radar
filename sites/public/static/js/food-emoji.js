/** Small, source-backed food accents shared by the server and browser. */
const FOODS = [
  [/\bpizzas?\b/gi, '🍕'], [/\btacos?\b/gi, '🌮'], [/\bburritos?\b/gi, '🌯'],
  [/\b(?:hamburgers?|burgers?)\b/gi, '🍔'], [/\bsandwich(?:es)?\b/gi, '🥪'],
  [/\bsushi\b/gi, '🍣'], [/\b(?:doughnuts?|donuts?)\b/gi, '🍩'],
  [/\bcookies?\b/gi, '🍪'], [/\bice cream\b/gi, '🍦'], [/\bcupcakes?\b/gi, '🧁'],
  [/\bcakes?\b/gi, '🍰'], [/\b(?:pasta|spaghetti)\b/gi, '🍝'], [/\bramen\b/gi, '🍜'],
  [/\bfried chicken\b/gi, '🍗'], [/\bsalads?\b/gi, '🥗'], [/\bpopcorn\b/gi, '🍿'],
  [/\bpretzels?\b/gi, '🥨'], [/\b(?:french )?fries\b/gi, '🍟'], [/\bcoffee\b/gi, '☕'],
];
export function foodSourceText(events = []) {
  return events.filter(event => !event.cancelled && event.food_label === 'Food confirmed')
    .map(event => event.food_items?.length ? event.food_items.join(', ') : event.food_description || '')
    .filter(text => !/\b(?:no|not|without|won't|will not)\s+(?:free\s+)?(?:pizza|tacos?|burgers?|food|snacks?|dinner)\b/i.test(text)).join('\n');
}
/** An empty source string adds nothing; repeated calls preserve existing accents. */
export function foodEmojiText(text, source = '') {
  let result = String(text || '');
  for (const [pattern, emoji] of FOODS) {
    pattern.lastIndex = 0;
    if (!pattern.test(source)) continue;
    pattern.lastIndex = 0;
    result = result.replace(pattern, (word, offset, whole) =>
      whole.slice(offset + word.length).trimStart().startsWith(emoji) ? word : `${word} ${emoji}`);
  }
  return result;
}
