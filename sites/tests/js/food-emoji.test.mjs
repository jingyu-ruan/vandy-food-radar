import test from 'node:test';import assert from 'node:assert/strict';
import {foodEmojiText,foodSourceText,foodDescriptionText} from '../../public/static/js/food-emoji.js';
test('named food accents require source support and preserve existing emoji',()=>{
 const source=foodSourceText([{food_label:'Food confirmed',food_items:['pizza','cookies']}]);
 assert.equal(foodEmojiText('Pizza and cookies; dinner.',source),'Pizza 🍕 and cookies 🍪; dinner.');
 assert.equal(foodEmojiText('Pizza 🍕 and cookies 🍪',source),'Pizza 🍕 and cookies 🍪');
 assert.equal(foodEmojiText('Pizza with sushi.',source),'Pizza 🍕 with sushi.');
 assert.equal(foodEmojiText('Dinner and pizza.'),'Dinner and pizza.');
 assert.equal(foodEmojiText('pizzazz',source),'pizzazz');
 assert.equal(foodSourceText([{food_label:'Food disputed',food_items:['pizza']},{food_label:'Food confirmed',cancelled:true,food_items:['pizza']}]),'');
});

test('provider and dietary accents preserve source facts and surface options outside the excerpt',()=>{
 const chick={food_label:'Food confirmed',food_description:'Chick-fil-A',food_items:['Chick-fil-A']};
 assert.equal(foodEmojiText('Chick-fil-A',foodSourceText([chick])),'Chick-fil-A 🍔');
 const event={food_label:'Food confirmed',food_description:'Dinner is provided.',description:'Dinner is provided, always including vegetarian and halal options.'};
 assert.match(foodDescriptionText(event),/Vegetarian Options 🥗; Halal Options$/);
 assert.equal(foodDescriptionText({...event,food_label:'Food disputed'}),'Dinner is provided.');
});

test('specific foods get distinct accents while dietary conditions and generic meals stay plain',()=>{
 const source='Halal options, kosher food, falafel, dumplings, rice, curry, pancakes and chicken wings. Dinner included.';
 assert.equal(foodEmojiText('Halal Options 🍽️ and Kosher Options 🍽️. Dinner.',source),'Halal Options and Kosher Options. Dinner.');
 assert.equal(foodEmojiText('Falafel, dumplings, rice, curry, pancakes and chicken wings.',source),'Falafel 🧆, dumplings 🥟, rice 🍚, curry 🍛, pancakes 🥞 and chicken wings 🍗.');
});

test('multiword foods get a single matching emoji and remain stable on rerender',()=>{
 const text='Bubble tea, fried chicken and cheeseburgers.';
 const accented='Bubble tea 🧋, fried chicken 🍗 and cheeseburgers 🍔.';
 assert.equal(foodEmojiText(text,text),accented);
 assert.equal(foodEmojiText(accented,text),accented);
});

test('menus use distinct fruit, vegetable, breakfast and pantry emoji',()=>{
 const menus=[
  ['Grapes, melon, watermelon, oranges, lemon, lime, banana, pineapple, mango, green apples, pears, peaches, cherries, strawberries, blueberries, kiwi and coconut.',
   'Grapes 🍇, melon 🍈, watermelon 🍉, oranges 🍊, lemon 🍋, lime 🍋‍🟩, banana 🍌, pineapple 🍍, mango 🥭, green apples 🍏, pears 🍐, peaches 🍑, cherries 🍒, strawberries 🍓, blueberries 🫐, kiwi 🥝 and coconut 🥥.'],
  ['Tomatoes, olives, avocado, eggplant, sweet potatoes, carrots, corn, bell peppers, cucumbers, spinach, broccoli, garlic, onions, mushrooms, beans, peas and ginger.',
   'Tomatoes 🍅, olives 🫒, avocado 🥑, eggplant 🍆, sweet potatoes 🍠, carrots 🥕, corn 🌽, bell peppers 🫑, cucumbers 🥒, spinach 🥬, broccoli 🥦, garlic 🧄, onions 🧅, mushrooms 🍄‍🟫, beans 🫘, peas 🫛 and ginger 🫚.'],
  ['Baguettes, flatbread, pretzels, bagels, pancakes, waffles, scrambled eggs, omelettes, bacon, butter, yogurt, oatmeal, peanuts and chestnuts.',
   'Baguettes 🥖, flatbread 🫓, pretzels 🥨, bagels 🥯, pancakes 🥞, waffles 🧇, scrambled eggs 🥚, omelettes 🍳, bacon 🥓, butter 🧈, yogurt 🥛, oatmeal 🥣, peanuts 🥜 and chestnuts 🌰.'],
 ];
 for(const [text,expected] of menus) assert.equal(foodEmojiText(text,text),expected);
});

test('international dishes, desserts and drinks get specific or close-family accents',()=>{
 const menus=[
  ['Shawarma, samosas, bento boxes, onigiri, rice crackers, paella, pho, lasagna, tofu, brisket, ribs, salmon, crab, lobster, calamari and oysters.',
   'Shawarma 🥙, samosas 🥟, bento boxes 🍱, onigiri 🍙, rice crackers 🍘, paella 🥘, pho 🍜, lasagna 🍝, tofu 🫘, brisket 🥩, ribs 🍖, salmon 🐟, crab 🦀, lobster 🦞, calamari 🦑 and oysters 🦪.'],
  ['Gelato, shaved ice, donuts, cookies, cupcakes, cheesecake, apple pie, chocolate, candy, lollipops, pudding, honey, popcorn, dango, mooncakes and churros.',
   'Gelato 🍨, shaved ice 🍧, donuts 🍩, cookies 🍪, cupcakes 🧁, cheesecake 🍰, apple pie 🥧, chocolate 🍫, candy 🍬, lollipops 🍭, pudding 🍮, honey 🍯, popcorn 🍿, dango 🍡, mooncakes 🥮 and churros 🥨.'],
  ['Boba, green tea, cappuccino, hot chocolate, smoothies, juice, water, soda, beer, wine, champagne, mocktails, sake and bourbon.',
   'Boba 🧋, green tea 🍵, cappuccino ☕, hot chocolate ☕, smoothies 🥤, juice 🧃, water 💧, soda 🥤, beer 🍺, wine 🍷, champagne 🍾, mocktails 🍹, sake 🍶 and bourbon 🥃.'],
 ];
 for(const [text,expected] of menus) assert.equal(foodEmojiText(text,text),expected);
});

test('compound food names win over ingredients and stay stable with existing emoji',()=>{
 const text='Chocolate chip cookies, chicken sandwiches, grilled cheese, ice-cream sandwiches, banana bread, sweet potato fries, fruit salad, rice noodles, coconut water, milk tea and chai lattes.';
 const expected='Chocolate chip cookies 🍪, chicken sandwiches 🥪, grilled cheese 🥪, ice-cream sandwiches 🥪, banana bread 🍞, sweet potato fries 🍟, fruit salad 🥗, rice noodles 🍜, coconut water 💧, milk tea 🧋 and chai lattes ☕.';
 assert.equal(foodEmojiText(text,text),expected);
 assert.equal(foodEmojiText(expected,text),expected);
 const preAccented='Lime 🍋‍🟩, mushrooms 🍄‍🟫 and CHOCOLATE CHIP COOKIES 🍪.';
 assert.equal(foodEmojiText(preAccented,preAccented),preAccented);
 const dishes='Cheese pizza, chicken burgers, shrimp tacos, burrito bowls, fried eggs and fortune cookies.';
 assert.equal(foodEmojiText(dishes,dishes),'Cheese pizza 🍕, chicken burgers 🍔, shrimp tacos 🌮, burrito bowls 🌯, fried eggs 🍳 and fortune cookies 🥠.');
 const more='Radishes, kebabs, tamales, stew, fondue, mochi, fish cakes, salt and ice cubes.';
 assert.equal(foodEmojiText(more,more),'Radishes 🫜, kebabs 🍢, tamales 🫔, stew 🍲, fondue 🫕, mochi 🍡, fish cakes 🍥, salt 🧂 and ice cubes 🧊.');
});

test('aliases, plurals, punctuation and accented spellings work without partial word matches',()=>{
 assert.equal(foodEmojiText('Doughnuts; bubble tea; gyoza; crêpes; jalapeños; yoghurt.',
  'Donuts, boba, dumplings, crepes, jalapenos and yogurt.'),
  'Doughnuts 🍩; bubble tea 🧋; gyoza 🥟; crêpes 🥞; jalapeños 🌶️; yoghurt 🥛.');
 const text='APPLE, (kiwis), “muffins” and strawberry-flavored ice cream.';
 assert.equal(foodEmojiText(text,text),'APPLE 🍎, (kiwis 🥝), “muffins 🧁” and strawberry 🍓-flavored ice cream 🍦.');
 const nonFoods='Appleton, cornhole, eggplantation, pearlescent, hamburgerology, teaé, café, cooking and pizzazz.';
 assert.equal(foodEmojiText(nonFoods,'apple corn eggplant pear hamburger tea coffee pizza'),nonFoods);
});

test('expanded accents still require source support and exclude unconfirmed or cancelled listings',()=>{
 const event={food_label:'Food confirmed',food_items:['blueberries','muffins','lemonade']};
 const source=foodSourceText([event]);
 assert.equal(foodEmojiText('Blueberries, muffins, lemonade, sushi and dinner.',source),
  'Blueberries 🫐, muffins 🧁, lemonade 🍋, sushi and dinner.');
 for(const entry of [{...event,cancelled:true},{...event,food_label:'Food disputed'}]) {
  assert.equal(foodEmojiText('Blueberries and muffins.',foodSourceText([entry])),'Blueberries and muffins.');
 }
 assert.equal(foodEmojiText('Blueberries and muffins.'),'Blueberries and muffins.');
 assert.equal(foodEmojiText('Dinner, lunch, snacks and refreshments.','Dinner, lunch, snacks and refreshments.'),
  'Dinner, lunch, snacks and refreshments.');
});
