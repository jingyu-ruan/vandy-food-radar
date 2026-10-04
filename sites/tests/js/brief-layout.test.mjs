import assert from 'node:assert/strict';
import test from 'node:test';
import {briefColumnWidths} from '../../public/static/js/brief-layout.js';

test('desktop spare space goes to titles, food and locations while short Notes remain bounded',()=>{
 const short = [35,420,155,220,240,43,200];
 const small = briefColumnWidths(1000,short);
 const wide = briefColumnWidths(1280,short);
 assert.equal(wide.tableWidth,1280);
 for (const column of [1,3,4]) assert.ok(wide.widths[column] > small.widths[column]);
 assert.equal(wide.widths[6],small.widths[6]);
 assert.ok(wide.widths[1] > wide.widths[6]);
 assert.equal(wide.widths[2],187);
});

test('each date responds to its menu and Notes, with long outliers bounded',()=>{
 const plain = briefColumnWidths(1000,[30,300,130,80,120,40,100]);
 const rich = briefColumnWidths(1000,[30,300,130,380,120,40,420]);
 assert.ok(rich.widths[3] > plain.widths[3]);
 assert.ok(rich.widths[6] > plain.widths[6]);
 const outlier = briefColumnWidths(1280,Array(7).fill(5000));
 assert.equal(outlier.widths[6],240);
 assert.ok(outlier.widths[1] <= 440);
 assert.equal(outlier.widths[0],52);
});

test('compact sizing follows container width, keeps all columns and limits horizontal travel',()=>{
 const result = briefColumnWidths(354,[30,420,155,220,240,43,200],75);
 assert.equal(result.compact,true);
 assert.equal(result.widths.length,7);
 assert.ok(result.tableWidth >= 762 && result.tableWidth < 850);
 assert.equal(result.widths[2],110);
 assert.ok(result.widths[6] <= 180);
 assert.equal(briefColumnWidths(661,[]).compact,true);
 assert.equal(briefColumnWidths(900,[]).compact,false);
});
