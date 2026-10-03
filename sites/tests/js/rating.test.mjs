import assert from 'node:assert/strict';
import test from 'node:test';
import {ratingPresentation} from '../../public/static/js/rating.js';

test('rating displays stored weights and contributions without reconstructing them', () => {
  const event = {date:'2026-10-02',identity_key:'anchor:123',stars:3,score:0.61,
    score_components:[{factor:'walking',weight:0.095,rawValue:0.4,contribution:0.038,note:'Published origin estimate'}]};
  const result = ratingPresentation(event);
  assert.equal(result.total,'61/100');
  assert.equal(result.score,3);
  assert.deepEqual(result.rows,[{label:'Walking',weight:'9.5%',value:'0.4',points:'3.8',note:'Published origin estimate'}]);
  assert.match(result.context,/published snapshot/);
});
