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
 assert.match(foodDescriptionText(event),/Vegetarian Options 🥗; Halal Options 🍽️/);
 assert.equal(foodDescriptionText({...event,food_label:'Food disputed'}),'Dinner is provided.');
});
