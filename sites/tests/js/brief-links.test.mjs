import assert from 'node:assert/strict';
import test from 'node:test';
import {BRIEF_COLUMNS,briefRows,eventAnchor,eventHref,generatedLabel,participationText,briefHighlights} from '../../public/static/js/brief.js';

test('brief links resolve to exactly one stable card ID and preserve the selected day',()=>{
 const identities=['source|anchorlink:123','A/B #?中文','event:other'];
 assert.equal(new Set(identities.map(eventAnchor)).size,identities.length);
 for (const identity of identities) {
  const url=new URL(eventHref(identity,'2026-10-04'),'https://example.com/?date=2026-10-03');
  assert.equal(url.searchParams.get('date'),'2026-10-04');
  assert.equal(decodeURIComponent(url.hash.slice(1)),eventAnchor(identity));
 }
});

test('table keeps published order and joins times to the correct event instead of array position',()=>{
 const brief={items:[
  {identity_key:'second',title:'Ranked first',food:'Pizza',walk:'~6 min straight-line estimate; actual pedestrian route/time unverified',reason:'Registration is required.'},
  {identity_key:'first',title:'Ranked second',location:'Library',reason:'Cancelled.'},
 ]};
 const events=[
  {identity_key:'first',start:null,end:null,time_label:'Time not listed',cancelled:true},
  {identity_key:'second',start:'23:30:00',end:'01:00:00'},
 ];
 assert.deepEqual(BRIEF_COLUMNS,['Rank','Event','Time','Food','Location','Walk','Notes']);
 const rows=briefRows(brief,events,'12');
 assert.equal(rows[0].rank,1);
 assert.equal(rows[0].time,'11:30 PM – 1 AM next day');
 assert.equal(rows[0].walk,'6 min');
 assert.match(rows[0].walk_detail,/straight-line estimate/);
 assert.equal(rows[0].food,'Pizza');
 assert.equal(rows[1].rank,2);
 assert.equal(rows[1].time,'Time Not Listed');
 assert.equal(rows[1].cancelled,true);
 assert.equal(rows[1].food,'Unspecified');
 assert.equal(rows[1].walk,'—');
 assert.equal(rows[0].location,'Location not listed');
 assert.equal(briefRows(brief,events,'24')[0].time,'23:30 – 01:00 next day');
 assert.deepEqual(briefRows(null,events),[]);
 assert.equal(generatedLabel({source:'rules'}),'Source Summary');
 assert.match(generatedLabel({source:'gemini',model:'gemini-3.5-flash-lite',generated_at:'2026-10-04T00:36:38Z'}),/by gemini-3.5-flash-lite/);
});
test('participation displays one supported explanation, falling back to source analysis',()=>{
 assert.equal(participationText({note:'Inferred: Discussion is expected.',ai_note:'RSVP is required; a brief visit may be impractical.'}),'RSVP is required; a brief visit may be impractical.');
 assert.equal(participationText({note:'Inferred: Discussion is expected.'}),'Discussion is expected.');
 assert.equal(participationText({note:'Eligibility is unspecified.'}),'Eligibility is unspecified.');
});

test('table rank follows full published scores even when brief rows arrived out of order',()=>{
 const events=[{identity_key:'low',score:.61,start:'12:00',title:'Low'},{identity_key:'high',score:.88,start:'18:00',title:'High'},{identity_key:'cancelled',score:1,start:'12:00',title:'Cancelled',cancelled:true}];
 const rows=briefRows({items:events.map(e=>({identity_key:e.identity_key,title:e.title}))},events);
 assert.deepEqual(rows.map(row=>row.identity_key),['high','low','cancelled']);assert.deepEqual(rows.map(row=>row.rank),[1,2,3]);
});

test('food highlights follow published priority and obtain times from their own event',()=>{
 const events=[{identity_key:'snacks',title:'Snack Hour',score:.5,start:'13:00',end:'14:00'},{identity_key:'meal',title:'Dinner Club',score:.9,start:'18:00',end:'19:00'},{identity_key:'cancelled',title:'Cancelled',score:1,cancelled:true}];
 const highlights=[{identityKey:'snacks',text:'Snack Hour has cookies.'},{identityKey:'cancelled',text:'Cancelled has food.'},{identityKey:'meal',text:'Dinner Club serves a meal.'}];
 const rows=briefHighlights('',events,'12',highlights);
 assert.deepEqual(rows.map(r=>r.identityKey),['meal','snacks']);
 assert.deepEqual(rows.map(r=>r.time),['6 PM – 7 PM','1 PM – 2 PM']);
 assert.equal(briefHighlights('',events,'24',highlights)[0].time,'18:00 – 19:00');
 assert.deepEqual(briefHighlights('Snack Hour has cookies.\nDinner Club serves a meal.',events,'12').map(r=>r.identityKey),['meal','snacks']);
 assert.equal(briefHighlights('A reception has cookies.',events,'12')[0].time,'');
});

test('cached highlights recover omitted punctuation or parenthetical titles without duplicate picks',()=>{
 const events=[{identity_key:'coffee',title:'Canterbury Cafe Hours!',score:.82,start:'13:00'},{identity_key:'dinner',title:"International 'Dores",score:.84,start:'19:00'},{identity_key:'books',title:'Silent Book Club (with the Graduate School!!)',score:.46,start:'15:00'}];
 const text="Canterbury Cafe Hours has coffee.\nInternational 'Dores provides dinner.\nSilent Book Club has snacks.";
 const structured=[{identityKey:'dinner',text:"International 'Dores provides dinner."}];
 const rows=briefHighlights(text,events,'12',structured);
 assert.deepEqual(rows.map(row=>row.identityKey),['dinner','coffee','books']);
 assert.deepEqual(rows.map(row=>row.time),['7 PM','1 PM','3 PM']);
});
