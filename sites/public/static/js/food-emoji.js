/** Small, source-backed food accents shared by the server and browser. */
const FOODS = [
  [/\b(?:matcha|tea|chai)\b/gi, '🍵'], [/\blattes?\b/gi, '☕'],
  [/\b(?:pastries|croissants?)\b/gi, '🥐'], [/\bbrownies?\b/gi, '🍫'],
  [/\b(?:fruit|apples?)\b/gi, '🍎'],
  [/\b(?:soup|chili)\b/gi, '🥣'], [/\b(?:bread|toast)\b/gi, '🍞'],
  [/\bcheese\b/gi, '🧀'], [/\bchips\b/gi, '🥔'],
  [/\bchick[-\s]?fil[-\s]?a\b/gi, '🍔'], [/\b(?:chipotle|burrito bowls?)\b/gi, '🌯'],
  [/\bvegetarian(?: options?)?\b/gi, '🥗'], [/\bvegan(?: options?)?\b/gi, '🌱'],
  [/\b(?:boba|bubble tea)\b/gi, '🧋'], [/\bdumplings?\b/gi, '🥟'], [/\bfalafel\b/gi, '🧆'],
  [/\bcurry\b/gi, '🍛'], [/\brice\b/gi, '🍚'],
  [/\bpizzas?\b/gi, '🍕'], [/\btacos?\b/gi, '🌮'], [/\bburritos?\b/gi, '🌯'],
  [/\b(?:hamburgers?|cheeseburgers?|burgers?)\b/gi, '🍔'], [/\bsandwich(?:es)?\b/gi, '🥪'],
  [/\bsushi\b/gi, '🍣'], [/\b(?:doughnuts?|donuts?)\b/gi, '🍩'],
  [/\bcookies?\b/gi, '🍪'], [/\bice cream\b/gi, '🍦'], [/\bcupcakes?\b/gi, '🧁'],
  [/\bcakes?\b/gi, '🍰'], [/\b(?:pasta|spaghetti)\b/gi, '🍝'], [/\bramen\b/gi, '🍜'],
  [/\bsalads?\b/gi, '🥗'], [/\bpopcorn\b/gi, '🍿'],
  [/\b(?:fried chicken|chicken nuggets?|chicken wings?|chicken)\b/gi, '🍗'],
  [/\b(?:bagels?)\b/gi, '🥯'], [/\bpancakes?\b/gi, '🥞'], [/\bwaffles?\b/gi, '🧇'],
  [/\b(?:hot dogs?)\b/gi, '🌭'], [/\bsteaks?\b/gi, '🥩'], [/\b(?:shrimp|prawns?)\b/gi, '🍤'],
  [/\b(?:grapes?)\b/gi, '🍇'], [/\b(?:strawberr(?:y|ies))\b/gi, '🍓'], [/\bbananas?\b/gi, '🍌'],
  [/\bpretzels?\b/gi, '🥨'], [/\b(?:french )?fries\b/gi, '🍟'], [/\bcoffee\b/gi, '☕'],
];
export function foodSourceText(events = []) {
  return events.filter(event => !event.cancelled && event.food_label === 'Food confirmed')
    .map(event => [...(event.food_items || []),event.food_description || '',event.description || ''].join(' '))
    .filter(text => !/\b(?:no|not|without|won't|will not)\s+(?:free\s+)?(?:pizza|tacos?|burgers?|food|snacks?|dinner)\b/i.test(text)).join('\n');
}
/** An empty source string adds nothing; repeated calls preserve existing accents. */
export function foodEmojiText(text, source = '') {
  let result = String(text || '').replace(/(\b(?:halal|kosher)(?: options?)?)\s*🍽️/gi,'$1');
  const matches=[];
  for (const [pattern, emoji] of FOODS) {
    pattern.lastIndex=0;
    if (!pattern.test(source)) continue;
    pattern.lastIndex=0;
    for (const match of result.matchAll(pattern)) matches.push({start:match.index,end:match.index+match[0].length,emoji});
  }
  // A full phrase such as bubble tea wins over tea; each food gets one accent.
  matches.sort((a,b)=>a.start-b.start || b.end-a.end);
  let output='', cursor=0;
  for (const match of matches) {
    if (match.start<cursor) continue;
    const alreadyAccented=/^\p{Extended_Pictographic}/u.test(result.slice(match.end).trimStart());
    output+=result.slice(cursor,match.end)+(alreadyAccented ? '' : ` ${match.emoji}`);
    cursor=match.end;
  }
  result=output+result.slice(cursor);
  return result;
}

/** Dietary labels require an explicit food/options phrase in the original listing. */
export function dietaryOptions(event) {
  if(event.food_label!=='Food confirmed' || event.cancelled) return [];
  const source=[event.description,event.food_description,...(event.food_items || [])].filter(Boolean).join(' ');
  const phrases=source.match(/\b(?:vegetarian|vegan|halal|kosher|gluten[- ]free)(?:\s+(?:and|or)\s+(?:vegetarian|vegan|halal|kosher|gluten[- ]free))?\s+(?:options?|meals?|food)\b/gi) || [];
  return [...new Set(phrases.flatMap(phrase=>(phrase.match(/vegetarian|vegan|halal|kosher|gluten[- ]free/gi) || []).map(word=>`${word[0].toUpperCase()}${word.slice(1).toLowerCase()} Options`)))];
}
/** Include options outside the short source excerpt without duplicating existing ones. */
export function foodDescriptionText(event) {
  const text=event.food_description || '';
  const extras=dietaryOptions(event).filter(option=>!text.toLowerCase().includes(option.replace(' Options','').toLowerCase()));
  return foodEmojiText([text,...extras].filter(Boolean).join('; '),foodSourceText([event]));
}
