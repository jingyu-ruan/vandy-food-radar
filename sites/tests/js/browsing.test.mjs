import assert from 'node:assert/strict';
import test from 'node:test';
import {futureWeekDays} from '../../public/static/js/agenda.js';
import {searchPlaces} from '../../public/static/js/place-search.js';

test('week keeps today and future dates across month and year boundaries', () => {
  const days = ['2026-12-30','2026-12-31','2027-01-01','2027-01-02'].map(date => ({date,events:[]}));
  assert.deepEqual(futureWeekDays(days,'2026-12-31'), days.slice(1));
  assert.deepEqual(futureWeekDays(days,'2027-01-03'), []);
  assert.equal(futureWeekDays(days,'2026-12-01').length,4);
});

test('campus search recognizes aliases and prioritizes prefixes without inventing places', () => {
  const places = [
    {id:'one',name:'Old Rand Annex',aliases:[]},
    {id:'two',name:'Rand Hall',aliases:['Rand Dining']},
    {id:'three',name:'Stevenson Mathematics',aliases:['SC Math']},
  ];
  assert.deepEqual(searchPlaces('rand',places).map(p=>p.id),['two','one']);
  assert.deepEqual(searchPlaces('SC-Math',places),[places[2]]);
  assert.deepEqual(searchPlaces('unknown',places),[]);
  assert.deepEqual(searchPlaces('',places,2),places.slice(0,2));
  assert.deepEqual(searchPlaces('rand',null),[]);
});
