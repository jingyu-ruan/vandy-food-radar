import assert from 'node:assert/strict';
import test from 'node:test';
import {ratingPresentation,compactRatingNote} from '../../public/static/js/rating.js';

test('rating displays stored weights and contributions without reconstructing them', () => {
  const event = {date:'2026-10-02',identity_key:'anchor:123',stars:3,score:0.61,
    score_components:[{factor:'walking',weight:0.095,rawValue:0.4,contribution:0.038,note:'Published origin estimate'}]};
  const result = ratingPresentation(event);
  assert.equal(result.total,'61 / 100');
  assert.equal(result.score,'3.1');
  assert.deepEqual(result.rows,[{label:'Walking',weight:'9.5%',value:'0.4',points:'3.8',note:'Published origin estimate'}]);
  assert.match(result.context,/published snapshot/);
});

test('five-point ratings retain one decimal, including full marks and legacy snapshots',()=>{
 assert.equal(ratingPresentation({date:'d',identity_key:'full',stars:5,score:1}).score,'5.0');
 assert.equal(ratingPresentation({date:'d',identity_key:'fraction',stars:4,score:0.84}).score,'4.2');
 assert.equal(ratingPresentation({date:'d',identity_key:'old',stars:3,score:null}).score,'3.0');
});
test('score notes omit meal-window boilerplate and trailing punctuation',()=>{
 assert.equal(compactRatingNote({factor:'timing',note:'Starts at 19:30; breakfast 7–10 AM, lunch 11 AM–2 PM, dinner 5–8 PM.'}),'Starts at 7:30 PM');
 assert.equal(compactRatingNote({factor:'walking',note:'about a 4 min walk.'}),'4 min walk');
 assert.equal(compactRatingNote({factor:'food_specificity',rawValue:0.75}),'Named food provider');
});
