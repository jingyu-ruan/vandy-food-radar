/** Source-backed food accents shared by Daily Brief tables, highlights and cards.
 * Aliases share an emoji; dishes without a dedicated glyph use a close food family.
 * Keep full dish names here so ingredients do not split one food into many accents.
 */
const FOODS = [
  // Fruit, vegetables and pantry foods.
  [/grapes?/, '🍇'], [/melons?|cantaloupes?|honeydew/, '🍈'], [/watermelons?/, '🍉'],
  [/tangerines?|mandarins?|clementines?|oranges?/, '🍊'], [/lemons?|lemonade/, '🍋'], [/limes?/, '🍋‍🟩'],
  [/bananas?/, '🍌'], [/pineapples?/, '🍍'], [/mango(?:es|s)?/, '🥭'],
  [/green[ -]+apples?/, '🍏'], [/apples?|fruit(?:[ -]+(?:cups?|platters?|trays?))?/, '🍎'],
  [/pears?/, '🍐'], [/peach(?:es)?/, '🍑'], [/cherr(?:y|ies)/, '🍒'],
  [/strawberr(?:y|ies)/, '🍓'], [/blueberr(?:y|ies)/, '🫐'], [/kiwi(?:[ -]+fruit|fruits|s)?/, '🥝'],
  [/coconuts?/, '🥥'], [/tomato(?:es|s)?/, '🍅'], [/olives?/, '🫒'],
  [/avocados?|guacamole/, '🥑'], [/eggplants?|aubergines?/, '🍆'],
  [/(?:baked[ -]+)?sweet[ -]+potato(?:es|s)?|yams?/, '🍠'],
  [/(?:mashed[ -]+|baked[ -]+)?potato(?:es|s)?|(?:potato[ -]+|tortilla[ -]+)?chips|crisps/, '🥔'],
  [/carrots?/, '🥕'], [/radish(?:es)?|turnips?|beets?|beetroot/, '🫜'],
  [/(?:sweet[ -]+)?corn(?:[ -]+on[ -]+the[ -]+cob)?/, '🌽'],
  [/(?:hot[ -]+|chili[ -]+|chilli[ -]+)peppers?|jalape[ñn]os?/, '🌶️'],
  [/bell[ -]+peppers?/, '🫑'], [/cucumbers?|pickles?/, '🥒'],
  [/lettuce|spinach|kale|leafy[ -]+greens?|bok[ -]+choy/, '🥬'], [/broccoli/, '🥦'],
  [/garlic/, '🧄'], [/onions?/, '🧅'], [/mushrooms?/, '🍄‍🟫'],
  [/peanuts?/, '🥜'], [/almonds?|cashews?|walnuts?|pecans?|pistachios?|nuts?|trail[ -]+mix/, '🥜'],
  [/chestnuts?/, '🌰'], [/beans?|lentils?|chickpeas?|edamame/, '🫘'],
  [/peas?|pea[ -]+pods?/, '🫛'], [/ginger/, '🫚'],
  // Bread, breakfast and dairy.
  [/(?:banana[ -]+|corn[ -]*|garlic[ -]+)?bread|toast|dinner[ -]+rolls?|bread[ -]*rolls?|biscuits?|naan|pita/, '🍞'],
  [/croissants?|pastr(?:y|ies)|danish(?:es)?|scones?/, '🥐'], [/baguettes?/, '🥖'],
  [/flat[ -]*breads?|arepas?/, '🫓'], [/pretzels?/, '🥨'], [/bagels?/, '🥯'],
  [/(?:french[ -]+toast|pancakes?|cr[eê]pes?|flapjacks?)/, '🥞'], [/waffles?/, '🧇'],
  [/cheese(?:[ -]+(?:cubes?|platters?|boards?))?|mozzarella|cheddar/, '🧀'],
  [/(?:scrambled[ -]+|boiled[ -]+|deviled[ -]+|devilled[ -]+)?eggs?/, '🥚'],
  [/omelet(?:te)?s?|fried[ -]+eggs?/, '🍳'], [/butter/, '🧈'], [/milk|yogh?urt/, '🥛'],
  [/cereal|oatmeal|porridge|granola/, '🥣'],
  // Meals and dishes. Longer matches win over their component ingredients.
  [/(?:(?:cheese|pepperoni|veggie|margherita)[ -]+)?pizzas?/, '🍕'],
  [/(?:(?:chicken|beef|pork|fish|shrimp|veggie)[ -]+)?tacos?/, '🌮'],
  [/burrito[ -]+bowls?|burritos?|chipotle/, '🌯'],
  [/(?:(?:veggie|chicken|beef|turkey)[ -]+)?(?:hamburgers?|cheeseburgers?|burgers?)|sliders?/, '🍔'],
  [/(?:(?:fried[ -]+)?chicken[ -]+|grilled[ -]+cheese[ -]+|ice[ -]+cream[ -]+)?sandwich(?:es)?|panini|paninis|subs?|hoagies?|grilled[ -]+cheese/, '🥪'],
  [/hot[ -]+dogs?|corn[ -]+dogs?|bratwurst|sausages?/, '🌭'],
  [/(?:french[ -]+|sweet[ -]+potato[ -]+)?fries/, '🍟'],
  [/falafel|hummus/, '🧆'], [/gyros?|shawarma/, '🥙'], [/kebabs?|skewers?|satay|oden/, '🍢'],
  [/wraps?|quesadillas?|enchiladas?|fajitas?/, '🌯'], [/tamales?/, '🫔'],
  [/dumplings?|pot[ -]*stickers?|gyoza|momos?|pierogi|wontons?|bao(?:[ -]+buns?)?|samosas?/, '🥟'],
  [/sushi|sashimi|nigiri|maki/, '🍣'], [/bento(?:[ -]+boxes)?/, '🍱'],
  [/onigiri|rice[ -]+balls?/, '🍙'], [/rice[ -]+crackers?|senbei/, '🍘'],
  [/curr(?:y|ies)/, '🍛'], [/paella|bibimbap/, '🥘'],
  [/(?:(?:fried|brown|white|sticky|steamed)[ -]+)?rice|risotto/, '🍚'],
  [/ramen|pho|udon|soba|(?:rice[ -]+)?noodles?|lo[ -]+mein|chow[ -]+mein|pad[ -]+thai/, '🍜'],
  [/pasta|spaghetti|lasagn[ae]|ravioli|penne|fettuccine|macaroni(?:[ -]+and[ -]+cheese)?|mac[ -]*(?:and|&|n)[ -]*cheese/, '🍝'],
  [/soups?|chili|chilli|chowder/, '🥣'], [/stews?|gumbo|hot[ -]*pot/, '🍲'], [/fondue/, '🫕'],
  [/(?:fruit[ -]+|potato[ -]+|pasta[ -]+|chicken[ -]+|egg[ -]+)?salads?/, '🥗'],
  [/(?:fried[ -]+|grilled[ -]+|roast(?:ed)?[ -]+|bbq[ -]+|barbecue[ -]+|hot[ -]+)?chicken(?:[ -]+(?:nuggets?|wings?|tenders?|drumsticks?))?|wings?|turkey/, '🍗'],
  [/steaks?|beef|pork|brisket|pulled[ -]+pork|barbecue|bbq/, '🥩'],
  [/ribs?|lamb|mutton|meatballs?/, '🍖'], [/bacon/, '🥓'],
  [/shrimp|prawns?|tempura/, '🍤'], [/fish(?:[ -]+and[ -]+chips)?|salmon|tuna|tilapia|cod/, '🐟'],
  [/crabs?/, '🦀'], [/lobsters?/, '🦞'], [/squid|calamari/, '🦑'],
  [/octopus/, '🐙'], [/oysters?|clams?|mussels?|scallops?/, '🦪'],
  [/tofu|tempeh|soybeans?/, '🫘'], [/spring[ -]+rolls?|egg[ -]+rolls?/, '🥟'],
  [/chick[-\s]?fil[-\s]?a/, '🍔'],
  // Sweets and snacks.
  [/soft[ -]+serve|ice[ -]+cream(?:[ -]+cones?)?/, '🍦'],
  [/gelato|sorbet|sherbet|frozen[ -]+yogh?urt|froyo|sundaes?/, '🍨'],
  [/shaved[ -]+ice|snow[ -]+cones?/, '🍧'], [/popsicles?|ice[ -]+pops?/, '🍧'],
  [/doughnuts?|donuts?/, '🍩'],
  [/(?:(?:chocolate[ -]+chip|peanut[ -]+butter|sugar|oatmeal)[ -]+)?cookies?|biscuits[ -]+and[ -]+cookies/, '🍪'],
  [/cupcakes?|muffins?/, '🧁'], [/cheesecakes?|(?:chocolate[ -]+|carrot[ -]+)?cakes?|tiramisu/, '🍰'],
  [/(?:(?:apple|cherry|pumpkin|pecan)[ -]+)?pies?|tarts?|cobblers?/, '🥧'],
  [/chocolates?(?:[ -]+bars?)?|brownies?|fudge/, '🍫'],
  [/cand(?:y|ies)|gumm(?:y|ies)|marshmallows?/, '🍬'], [/lollipops?/, '🍭'],
  [/custard|pudding|flan/, '🍮'], [/honey/, '🍯'], [/popcorn/, '🍿'],
  [/dango|mochi/, '🍡'], [/moon[ -]*cakes?/, '🥮'], [/fortune[ -]+cookies?/, '🥠'],
  [/fish[ -]+cakes?|narutomaki/, '🍥'],
  [/churros?/, '🥨'], [/crackers?|nachos?|tortillas?/, '🥔'],
  [/salt/, '🧂'], [/ice[ -]+cubes?/, '🧊'],
  // Drinks, including common cafe drinks and spelling variants.
  [/boba|bubble[ -]+tea|(?:tapioca[ -]+)?milk[ -]+tea/, '🧋'],
  [/(?:iced[ -]+|green[ -]+|black[ -]+|herbal[ -]+)?tea|matcha|chai/, '🍵'],
  [/(?:(?:iced|hot)[ -]+)?coffee|(?:(?:matcha|chai|(?:green[ -]+)?tea)[ -]+)?lattes?|espresso|cappuccinos?|americanos?|mochas?|cold[ -]+brew/, '☕'],
  [/hot[ -]+chocolate|cocoa/, '☕'], [/milk[ -]*shakes?|smoothies?/, '🥤'],
  [/juice[ -]+boxes|(?:orange[ -]+|apple[ -]+|grape[ -]+|fruit[ -]+)?juice/, '🧃'],
  [/coconut[ -]+water|(?:bottled[ -]+|sparkling[ -]+)?water/, '💧'],
  [/soda|soft[ -]+drinks?|lemon[ -]+lime[ -]+soda|cokes?|cola|punch/, '🥤'],
  [/beer|ales?|lagers?|cider/, '🍺'], [/wine|sangria/, '🍷'],
  [/champagne|prosecco|sparkling[ -]+wine/, '🍾'],
  [/cocktails?|mocktails?|margaritas?|martinis?|mimosas?/, '🍹'],
  [/sake/, '🍶'], [/whisk(?:ey|y)|bourbon/, '🥃'],
  // Preserve the existing dietary accents; these do not imply a specific dish.
  [/vegetarian(?: options?)?/, '🥗'], [/vegan(?: options?)?/, '🌱'],
].map(([pattern, emoji]) => [
  // Unicode word boundaries also avoid partial matches in accented words.
  new RegExp(`(?<![\\p{L}\\p{N}_])(?:${pattern.source})(?![\\p{L}\\p{N}_])`, 'giu'), emoji,
]);
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
