import assert from 'node:assert/strict';
import test from 'node:test';
import {calendarDays,shiftCalendarDay,shiftCalendarMonth,upcomingDate} from '../../public/static/js/date-picker.js';

test('calendar covers six complete Sunday-first weeks across a year boundary',()=>{
  const days=calendarDays('2027-01-15');
  assert.equal(days.length,42);
  assert.equal(days[0],'2026-12-27');
  assert.equal(days.at(-1),'2027-02-06');
  assert.equal(new Set(days).size,42);
});
test('month navigation clamps long months and preserves leap-day correctness',()=>{
  assert.equal(shiftCalendarMonth('2028-01-31',1),'2028-02-29');
  assert.equal(shiftCalendarMonth('2027-03-31',-1),'2027-02-28');
  assert.equal(shiftCalendarMonth('2026-12-07',1),'2027-01-07');
  assert.equal(shiftCalendarDay('2028-02-28',1),'2028-02-29');
  assert.equal(shiftCalendarDay('2028-02-29',1),'2028-03-01');
});

test('browsing clamps past dates and impossible dates while preserving today and future dates',()=>{
  const today='2026-10-12';
  for(const value of ['2026-10-11','2025-12-31','2026-02-30','2026-13-01','',null]) assert.equal(upcomingDate(value,today),today);
  assert.equal(upcomingDate(today,today),today);
  assert.equal(upcomingDate('2027-01-01',today),'2027-01-01');
});
