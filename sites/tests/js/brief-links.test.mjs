import assert from 'node:assert/strict';
import test from 'node:test';
import {eventAnchor,eventHref,participationText} from '../../public/static/js/brief.js';

test('brief links resolve to exactly one stable card ID and preserve the selected day',()=>{
 const identities=['source|anchorlink:123','A/B #?中文','event:other'];
 assert.equal(new Set(identities.map(eventAnchor)).size,identities.length);
 for (const identity of identities) {
  const url=new URL(eventHref(identity,'2026-10-04'),'https://example.com/?date=2026-10-03');
  assert.equal(url.searchParams.get('date'),'2026-10-04');
  assert.equal(decodeURIComponent(url.hash.slice(1)),eventAnchor(identity));
 }
});
test('participation displays one supported explanation, falling back to source analysis',()=>{
 assert.equal(participationText({note:'Inferred: Discussion is expected.',ai_note:'RSVP is required; a brief visit may be impractical.'}),'RSVP is required; a brief visit may be impractical.');
 assert.equal(participationText({note:'Inferred: Discussion is expected.'}),'Discussion is expected.');
 assert.equal(participationText({note:'Eligibility is unspecified.'}),'Eligibility is unspecified.');
});
