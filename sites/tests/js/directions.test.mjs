import assert from 'node:assert/strict';
import test from 'node:test';
import {destinationFor,googleWalkingUrl,mapsEndpoint} from '../../public/static/js/directions.js';
import {foodPresentation} from '../../public/static/js/food-presentation.js';
import {coordinateLabel} from '../../public/static/js/origin.js';

test('Google walking links retain exact coordinates and encode both endpoints',()=>{
 const start={lat:36.148271,lng:-86.803471},end={lat:36.144722,lng:-86.801215};
 const link=new URL(googleWalkingUrl(start,end));
 assert.equal(link.origin,'https://www.google.com');
 assert.equal(link.pathname,'/maps/dir/');
 assert.equal(link.searchParams.get('api'),'1');
 assert.equal(link.searchParams.get('origin'),'36.148271,-86.803471');
 assert.equal(link.searchParams.get('destination'),'36.144722,-86.801215');
 assert.equal(link.searchParams.get('travelmode'),'walking');
 assert.equal(googleWalkingUrl(start,null),null);
 assert.equal(mapsEndpoint({lat:91,lng:0}),null);
 assert.equal(mapsEndpoint({lat:0,lng:Infinity}),null);
 assert.equal(mapsEndpoint({address:' R & D Hall, Nashville '}),'R & D Hall, Nashville');
});
test('unresolved event locations remain address queries instead of fabricated pins',()=>{
 const event={identity_key:'e',date:'2026-10-02',location_listed:'R & D Hall'};
 const destination=destinationFor(event);
 assert.equal(destination.address,'R & D Hall, Vanderbilt University, Nashville, TN');
 assert.equal(destination.lat,undefined);
 assert.equal(new URL(googleWalkingUrl({lat:0,lng:0},destination)).searchParams.get('destination'),destination.address);
 assert.equal(destinationFor({...event,location_listed:null}),null);
 assert.equal(coordinateLabel({lat:36.148271,lng:-86.803471}),'36.14827, -86.80347');
});
test('certainty takes precedence and unknown food type never implies a meal',()=>{
 assert.deepEqual(foodPresentation({food_label:'Food confirmed',food_category:'Unspecified'}),{label:'Free Food',tone:'teal',detail:'Food type not listed'});
 assert.equal(foodPresentation({food_label:'Food confirmed',food_category:'Full meal'}).label,'Meal');
 assert.equal(foodPresentation({food_label:'Food confirmed',food_category:'Snacks'}).tone,'blue');
 assert.deepEqual(foodPresentation({food_label:'Food disputed',food_category:'Snacks'}),{label:'Food Disputed',tone:'red',detail:'Snacks listed'});
 assert.deepEqual(foodPresentation({food_label:'Food unconfirmed',food_category:'Unspecified'}),{label:'Food Unconfirmed',tone:'amber',detail:''});
});
