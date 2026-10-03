import assert from 'node:assert/strict';
import test from 'node:test';
import { clockMinutes, displayText, eventTime, formatMinutes, formatTimesInText, loadPreferences, normalizePreferences, preferences } from '../../public/static/js/preferences.js';

test('formatting preserves midnight, noon and overnight meaning in both clocks', () => {
  assert.equal(formatTimesInText('Starts from 12 PM.', '24'), 'Starts from 12:00.');
  assert.equal(formatMinutes(0, '12'), '12:00 AM');
  assert.equal(formatMinutes(720, '12'), '12:00 PM');
  assert.equal(formatMinutes(1025, '24'), '17:05');
  assert.equal(eventTime({start:'23:30:00',end:'01:00:00'}, '24'), '23:30 – 01:00 next day');
  assert.equal(eventTime({start:'17:00:00',end:'18:15:00'}, '12'), '5:00 PM – 6:15 PM');
  assert.equal(eventTime({start:null,time_label:'Time not listed'}, '24'), 'Time not listed');
  assert.equal(eventTime({start:'17:00:00',end:null}, '24'), '17:00');
});

test('departure input converts a displayed clock to canonical minutes', () => {
  assert.equal(clockMinutes('12:00 AM'), 0);
  assert.equal(clockMinutes('12:00 pm'), 720);
  assert.equal(clockMinutes('5:30 PM'), 1050);
  assert.equal(clockMinutes('17:30'), 1050);
  for (const invalid of ['24:00', '0:30 AM', '13:00 PM', '17:60', 'garbage']) assert.equal(clockMinutes(invalid), null);
});

test('preferences survive valid storage and recover from corrupt or blocked storage', () => {
  assert.deepEqual(normalizePreferences({theme:'dark',clock:'24'}), {theme:'dark',clock:'24'});
  assert.deepEqual(normalizePreferences({theme:'invalid',clock:24}), {theme:'system',clock:'12'});
  loadPreferences({getItem:()=>'{"theme":"light","clock":"24"}'});
  assert.equal(preferences.clock, '24');
  loadPreferences({getItem:()=>'{bad'});
  assert.equal(preferences.theme, 'system');
  loadPreferences({getItem:()=>{throw new Error('blocked');}});
  assert.equal(preferences.clock, '12');
});

test('display copy removes separators without losing paragraph breaks', () => {
  assert.equal(displayText('Today · Kirkland\nFood · Snacks'), 'Today Kirkland\nFood Snacks');
});
