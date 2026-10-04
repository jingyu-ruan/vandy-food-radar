/** Recognize menu evidence, never arbitrary description length. */
const DISH=/\b(?:pizza|salad|soup|chili|chicken|beef|pork|fish|shrimp|tofu|broccoli|beans|lentils|bread|cheese|chips|brownies|matcha|latte|chai|samosas?|tacos?|burritos?|burgers?|hamburgers?|sandwich(?:es)?|sushi|pasta|spaghetti|ramen|noodles?|rice|curry|fried chicken|chicken nuggets?|barbecue|bbq|bagels?|cookies?|donuts?|doughnuts?|ice cream|cakes?|cupcakes?|popcorn|pretzels?|fries|coffee|tea|boba|lemonade|fruit|pastries|dumplings?|falafel|hummus|pancakes?|waffles?|eggs?|yogurt|oatmeal)\b/i;
const PROVIDER=/\b(?:chick[-\s]?fil[-\s]?a|chipotle|panera|panda express|hyderabad house|cava|raising cane['’]?s?|domino['’]?s?|papa john['’]?s?)\b/i;
const DIET=/\b(?:vegetarian|vegan|halal|kosher|gluten[- ]free)(?:\s+(?:and|or)\s+(?:vegetarian|vegan|halal|kosher|gluten[- ]free))?\s+(?:options?|meals?|food)\b/i;
export function menuSpecificity(description:string|null):{value:number;note:string} {
  const text=description || '';
  const denied=new RegExp(`\\b(?:no|without|not serving|will not (?:serve|provide))\\s+(?:free\\s+)?(?:food|${DISH.source}|${PROVIDER.source})`, 'i');
  const positive=text.split(/[.;\n]/).filter(clause=>!denied.test(clause)).join(' ');
  if (DISH.test(positive)) return {value:1,note:'A specific food or drink is named in the listing.'};
  if (PROVIDER.test(positive)) return {value:0.75,note:'A food provider is named; the exact order is unspecified.'};
  if (DIET.test(positive)) return {value:0.4,note:'Dietary options are listed; specific dishes are unspecified.'};
  return {value:0,note:'Menu Unspecified'};
}
