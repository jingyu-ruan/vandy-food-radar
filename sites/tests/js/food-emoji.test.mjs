import test from 'node:test';import assert from 'node:assert/strict';
import {foodEmojiText,foodSourceText} from '../../public/static/js/food-emoji.js';
test('named food accents require source support and preserve existing emoji',()=>{
 const source=foodSourceText([{food_label:'Food confirmed',food_items:['pizza','cookies']}]);
 assert.equal(foodEmojiText('Pizza and cookies; dinner.',source),'Pizza 🍕 and cookies 🍪; dinner.');
 assert.equal(foodEmojiText('Pizza 🍕 and cookies 🍪',source),'Pizza 🍕 and cookies 🍪');
 assert.equal(foodEmojiText('Pizza with sushi.',source),'Pizza 🍕 with sushi.');
 assert.equal(foodEmojiText('Dinner and pizza.'),'Dinner and pizza.');
 assert.equal(foodEmojiText('pizzazz',source),'pizzazz');
 assert.equal(foodSourceText([{food_label:'Food disputed',food_items:['pizza']},{food_label:'Food confirmed',cancelled:true,food_items:['pizza']}]),'');
});
