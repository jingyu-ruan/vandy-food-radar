import assert from 'node:assert/strict';
import test from 'node:test';
import {cameraChange, coordinateKey} from '../../public/static/js/map-camera.js';

test('renaming an endpoint and switching tabs preserve its camera identity', () => {
  const origin = {lat:36.15,lng:-86.8,label:'Coordinates'};
  assert.equal(coordinateKey(origin),coordinateKey({...origin,label:'Campus building'}));
  const before = {origin:coordinateKey(origin),destination:null,date:'2026-10-02',selected:null};
  assert.equal(cameraChange(before,{...before,view:'schedule',saved:true}),null);
});

test('endpoint changes take precedence over date framing and selected events retain focus', () => {
  const before = {origin:'36:-86',destination:null,date:'2026-10-02',selected:null};
  assert.equal(cameraChange(null,before),'initial');
  assert.equal(cameraChange(before,{...before,destination:'36.1:-86.1',date:'2026-10-03'}),'destination');
  assert.equal(cameraChange(before,{...before,origin:'36.2:-86.2'}),'origin');
  assert.equal(cameraChange(before,{...before,date:'2026-10-03'}),'date');
  assert.equal(cameraChange(before,{...before,date:'2026-10-03',selected:'selected-event'}),null);
});
