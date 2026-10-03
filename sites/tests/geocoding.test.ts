import assert from 'node:assert/strict';
import test from 'node:test';
import {addressLabel,lookupAddress,parseLocation} from '../lib/vfr/geocoding.ts';

test('locations reject malformed and out-of-range coordinates',()=>{
 assert.deepEqual(parseLocation({lat:36.148,lng:-86.803}),{lat:36.148,lng:-86.803});
 for(const value of [null,{}, {lat:'36',lng:0},{lat:NaN,lng:0},{lat:91,lng:0},{lat:0,lng:-181}])assert.equal(parseLocation(value),null);
});
test('nearest address labels use streets with city context and safe bounded text',()=>{
 assert.equal(addressLabel({features:[{properties:{housenumber:'2201',street:'West End Avenue',city:'Nashville',state:'Tennessee'}}]}),'2201 West End Avenue, Nashville, Tennessee');
 assert.equal(addressLabel({features:[{properties:{name:'A · B',city:'Nashville'}}]}),'A   B, Nashville');
 assert.equal(addressLabel({features:[{properties:{city:'Nashville'}}]}),null);
 assert.equal(addressLabel({features:[]}),null);
 assert.equal(addressLabel({features:[{properties:{name:'a'.repeat(500),city:'b'.repeat(500),state:'c'.repeat(500)}}]})?.length,150);
});
test('lookup uses a fixed bounded endpoint and concurrent requests degrade safely',async()=>{
 let release: (value: Response)=>void=()=>{};
 let url:URL|undefined;
 const fetcher:typeof fetch=async(input,init)=>{
  url=new URL(String(input));
  assert.equal(init?.redirect,'manual');
  assert.ok(init?.signal);
  return new Promise<Response>(resolve=>{release=resolve;});
 };
 const pending=lookupAddress({lat:36.148271,lng:-86.803471},fetcher);
 assert.equal(await lookupAddress({lat:0,lng:0},fetcher),null);
 release(new Response(JSON.stringify({features:[{properties:{street:'West End Avenue',city:'Nashville'}}]})));
 assert.equal(await pending,'West End Avenue, Nashville');
 assert.equal(url?.origin,'https://photon.komoot.io');
 assert.equal(url?.pathname,'/reverse');
 assert.equal(url?.searchParams.get('lat'),'36.148271');
 assert.equal(url?.searchParams.get('lon'),'-86.803471');
 assert.equal(url?.searchParams.get('limit'),'1');
 assert.equal(url?.searchParams.get('radius'),'0.1');
});
