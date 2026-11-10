import assert from 'node:assert/strict';
import test from 'node:test';
import {briefRows, briefHighlights} from '../../public/static/js/brief.js';

const events=[
 {identity_key:'morning',title:'Morning Social',start:'09:00',food_label:'Food confirmed',
  food_items:['blueberries','muffins','chai latte']},
 {identity_key:'evening',title:'Evening Social',start:'18:00',food_label:'Food confirmed',
  food_items:['shawarma','hummus','lemonade']},
];

test('Daily Brief tables and bullet highlights share expanded accents for every named food',()=>{
 const menus=['Blueberries, muffins and chai lattes','Shawarma, hummus and lemonade'];
 const expected=['Blueberries 🫐, muffins 🧁 and chai lattes ☕','Shawarma 🥙, hummus 🧆 and lemonade 🍋'];
 const brief={items:events.map((event,i)=>({...event,food:menus[i]}))};
 const table=new Map(briefRows(brief,events,'12').map(row=>[row.identity_key,row.food]));
 const highlights=events.map((event,i)=>({identityKey:event.identity_key,text:`${event.title}: ${menus[i]}.`}));
 const bullets=new Map(briefHighlights('',events,'12',highlights).map(row=>[row.identityKey,row.text]));
 for (const [i,event] of events.entries()) {
  assert.equal(table.get(event.identity_key),expected[i]);
  assert.equal(bullets.get(event.identity_key),`${event.title}: ${expected[i]}.`);
 }
 // Cached plain-text briefs use the same matcher as structured highlights.
 assert.deepEqual(briefHighlights(highlights.map(row=>row.text).join('\n'),events,'12')
  .map(row=>row.text),[...bullets.values()]);
});

test('Daily Brief food support stays tied to its event across tables and highlights',()=>{
 const brief={items:[{identity_key:'morning',food:'Muffins, shawarma and lunch'}]};
 assert.equal(briefRows(brief,events,'12')[0].food,'Muffins 🧁, shawarma and lunch');
 const highlights=[{identityKey:'morning',text:'Morning Social: muffins and shawarma.'}];
 assert.equal(briefHighlights('',events,'12',highlights)[0].text,'Morning Social: muffins 🧁 and shawarma.');
});
