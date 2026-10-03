import assert from "node:assert/strict";
import test from "node:test";
import {parseFootRoute, WalkingRouter} from "../lib/vfr/routing.ts";
import {defaultConfig} from "../lib/vfr/config.ts";
const points=[{lat:36.14869,lng:-86.80508},{lat:36.1487,lng:-86.8027}];
const payload={code:"Ok",routes:[{distance:327.8,duration:262.4,legs:[{distance:327.8,duration:262.4}],geometry:{type:"LineString",coordinates:points.map(p=>[p.lng,p.lat])}}]};
test("foot routes retain pedestrian duration and reject unusable geometry/legs",()=>{
 const route=parseFootRoute(payload,1)!;
 assert.equal(route.mode,"routed");assert.equal(route.minutes,5);assert.deepEqual(route.geometry,points);
 assert.match(route.detail,/FOSSGIS/);
 assert.equal(parseFootRoute({...payload,code:"NoRoute"},1),null);
 assert.equal(parseFootRoute(payload,2),null);
 assert.equal(parseFootRoute({...payload,routes:[{...payload.routes[0],duration:-1}]},1),null);
});
test("free foot routing is cached; unavailable service falls back to marked estimates",async()=>{
 let calls=0;
 const config=defaultConfig();
 const router=new WalkingRouter(config,{async postJson(){throw new Error("ORS requires a key");},async getFoot(){calls++;return parseFootRoute(payload,1);}});
 assert.equal(router.routingAvailable,true);
 assert.equal((await router.route(points)).mode,"routed");await router.route(points);assert.equal(calls,1);
 const fallback=new WalkingRouter(config,{async postJson(){return null;},async getFoot(){return null;}});
 const result=await fallback.route(points);
 assert.equal(result.mode,"estimate");assert.match(result.detail,/unverified/);
});
