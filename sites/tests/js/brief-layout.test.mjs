import assert from 'node:assert/strict';
import test from 'node:test';
import {briefColumnWidths} from '../../public/static/js/brief-layout.js';

test('desktop spare space prioritizes Notes and keeps event titles within a narrower cap',()=>{
 const short = [35,420,155,220,240,43,200];
 const small = briefColumnWidths(1000,short);
 const wide = briefColumnWidths(1280,short);
 assert.equal(wide.tableWidth,1280);
 for (const column of [1,3,4,6]) assert.ok(wide.widths[column] > small.widths[column]);
 assert.ok(wide.widths[6] > wide.widths[1]);
 assert.ok(wide.widths[1] <= 300);
 assert.equal(wide.widths[2],187);
});

test('each date responds to its menu and Notes, with long outliers bounded',()=>{
 const plain = briefColumnWidths(1000,[30,300,130,80,120,40,100]);
 const rich = briefColumnWidths(1000,[30,300,130,380,120,40,420]);
 assert.ok(rich.widths[3] > plain.widths[3]);
 assert.ok(rich.widths[6] > plain.widths[6]);
 const outlier = briefColumnWidths(1280,Array(7).fill(5000));
 assert.equal(outlier.widths[6],340);
 assert.ok(outlier.widths[1] <= 300);
 assert.equal(outlier.widths[0],52);
});

test('compact sizing follows container width, keeps all columns and limits horizontal travel',()=>{
 const result = briefColumnWidths(354,[30,420,155,220,240,43,200],75);
 assert.equal(result.compact,true);
 assert.equal(result.widths.length,7);
 assert.ok(result.tableWidth >= 772 && result.tableWidth < 900);
 assert.equal(result.widths[2],110);
 assert.ok(result.widths[1] <= 180);
 assert.ok(result.widths[6] > result.widths[1] && result.widths[6] <= 230);
 assert.equal(briefColumnWidths(661,[]).compact,true);
 assert.equal(briefColumnWidths(900,[]).compact,false);
});
