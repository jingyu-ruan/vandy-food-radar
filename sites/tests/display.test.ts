import assert from 'node:assert/strict';
import test from 'node:test';
import { displayFields } from '../lib/vfr/display.ts';

test('presentation cleanup preserves source identifiers and hyperlink targets', () => {
  const source = {
    title: 'Food · Tonight', identity_key: 'source·123',
    description: 'Dinner · Snacks\nRoom 2',
    sources: [{label:'Anchor · Link',url:'https://example.com/event·123'}],
    calendar: {google:'https://calendar.google.com/?text=Food·Tonight',ics:'/api/calendar/123'},
  };
  const view = displayFields(source);
  assert.equal(view.title, 'Food Tonight');
  assert.equal(view.description, 'Dinner Snacks\nRoom 2');
  assert.equal(view.sources[0].label, 'Anchor Link');
  assert.equal(view.identity_key, source.identity_key);
  assert.equal(view.sources[0].url, source.sources[0].url);
  assert.deepEqual(view.calendar, source.calendar);
  assert.equal(source.title, 'Food · Tonight');
});
