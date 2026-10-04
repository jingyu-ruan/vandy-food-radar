import test from 'node:test';
import assert from 'node:assert/strict';
import {addressResults,lookupPlaces,searchQuery} from '../lib/vfr/address-search.ts';
const payload={features:[{geometry:{type:'Point',coordinates:[-86.8,36.14]},properties:{name:'Cafe',street:'Main Street',housenumber:'12',city:'Nashville',state:'Tennessee'}}]};
test('search input and provider coordinates are bounded; duplicates and broken features are excluded',()=>{
 assert.equal(searchQuery(' ab '),null);assert.equal(searchQuery('  Main   Street  '),'Main Street');assert.equal(searchQuery('a'.repeat(161)),null);
 const results=addressResults({features:[...payload.features,...payload.features,{geometry:{type:'Point',coordinates:[0,91]},properties:{name:'Broken'}},{geometry:{type:'LineString',coordinates:[0,0]},properties:{name:'Broken'}}]});
 assert.equal(results.length,1);assert.equal(results[0].lat,36.14);assert.equal(results[0].lng,-86.8);assert.equal(results[0].detail,'12 Main Street, Nashville, Tennessee');
});
test('address requests use a fixed endpoint and campus bias; cache avoids repeated upstream requests',async()=>{
 let calls=0;
 const fetcher=(async(url:URL)=>{calls++;assert.equal(url.origin,'https://photon.komoot.io');assert.equal(url.pathname,'/api');assert.equal(url.searchParams.get('q'),'Main Street');assert.equal(url.searchParams.get('limit'),'6');return new Response(JSON.stringify(payload));}) as typeof fetch;
 assert.equal((await lookupPlaces('Main Street',fetcher)).status,'ok');
 assert.equal((await lookupPlaces('main street',fetcher)).results.length,1);assert.equal(calls,1);
 assert.equal((await lookupPlaces('Other Street',fetcher)).status,'busy');assert.equal(calls,1);
});
