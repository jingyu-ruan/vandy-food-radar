import assert from 'node:assert/strict';
import test from 'node:test';
import {BRIEF_COLUMNS,briefContext,briefRows,eventAnchor,eventHref,participationText} from '../../public/static/js/brief.js';

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
 assert.deepEqual(BRIEF_COLUMNS,['Ranking','Activity','Time','Food','Location','Walk','Notes']);
 const rows=briefRows(brief,events,'12');
 assert.equal(rows[0].rank,1);
 assert.equal(rows[0].time,'11:30 PM – 1 AM next day');
 assert.equal(rows[0].walk,'~6 min estimate');
 assert.equal(rows[0].food,'Pizza');
 assert.equal(rows[1].rank,2);
 assert.equal(rows[1].time,'Time not listed');
 assert.equal(rows[1].cancelled,true);
 assert.equal(rows[1].food,'Menu not specified');
 assert.equal(rows[0].location,'Location not listed');
 assert.equal(briefRows(brief,events,'24')[0].time,'23:30 – 01:00 next day');
 assert.deepEqual(briefRows(null,events),[]);
 assert.match(briefContext('Rand Hall'),/Walking from Rand Hall/);
});
test('participation displays one supported explanation, falling back to source analysis',()=>{
 assert.equal(participationText({note:'Inferred: Discussion is expected.',ai_note:'RSVP is required; a brief visit may be impractical.'}),'RSVP is required; a brief visit may be impractical.');
 assert.equal(participationText({note:'Inferred: Discussion is expected.'}),'Discussion is expected.');
 assert.equal(participationText({note:'Eligibility is unspecified.'}),'Eligibility is unspecified.');
});
