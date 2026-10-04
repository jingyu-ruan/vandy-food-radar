import assert from "node:assert/strict";
import test from "node:test";
import { configFromEnv, defaultConfig } from "../lib/vfr/config.ts";
import { AI_VERSION, validateIntelligence, generateIntelligence } from "../lib/vfr/intelligence.ts";
import { runRefresh } from "../lib/vfr/pipeline.ts";
import { Repository } from "../lib/vfr/repository.ts";
import { loadDayFeed } from "../lib/vfr/workspace.ts";
import { freshDatabase, SqliteD1 } from "./sqlite-d1.ts";
import { anchorRow, searchPage } from "./helpers.ts";
import type { AiInput } from "../lib/vfr/intelligence.ts";

const date = "2026-10-03";
const nowMs = Date.parse("2026-10-03T18:00:00Z");
const input: AiInput = {identityKey:"event:1",title:"Lunch",start:"13:00",end:"14:00",location:"Rand Hall",
  organizer:"Host",description:"Drop in anytime for snacks and conversation.",food:"snacks",foodCategory:"snacks_or_refreshments",status:"verified",rsvp:null};

test("output rejects invented times and unsupported participation quotations",()=>{
  assert.throws(()=>validateIntelligence({brief:"Lunch starts at 7 PM.",traits:[]},[input]));
  const output = validateIntelligence({brief:"Lunch starts at 1 PM.",traits:[
    {identityKey:input.identityKey,level:"drop_in",note:"A short visit may suit this format.",evidence:"Drop in anytime"},
    {identityKey:"event:2",level:"restricted",note:"Members only.",evidence:"Members only"},
    {identityKey:input.identityKey,level:"drop_in",note:"No attendance required.",evidence:"Fabricated source"},
  ]},[input]);
  assert.equal(output.traits.length,1);
  assert.equal(output.traits[0].evidence,"Drop in anytime");
});

test("Gemini uses a fixed server endpoint, key header, bounded structured response and sanitized errors",async()=>{
  const config = configFromEnv({GEMINI_API_KEY:"test-key",VFR_GEMINI_MODEL:"../../unsafe"});
  assert.equal(config.gemini.model,"gemini-3.5-flash-lite");
  await assert.rejects(generateIntelligence(config,date,[input],"hash",new Date(nowMs).toISOString(),async(url,options)=>{
    assert.equal(String(url),"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    assert.equal(new Headers(options?.headers).get("x-goog-api-key"),"test-key");
    assert.ok(!String(url).includes("test-key"));
    const body=JSON.parse(String(options?.body));
    assert.equal(body.generationConfig.responseMimeType,"application/json");
    assert.match(body.systemInstruction.parts[0].text,/Ranking, Activity, Time, Food, Location, Walk, Notes/);
    assert.match(body.systemInstruction.parts[0].text,/exactly one concise English opening sentence/);
    assert.match(body.generationConfig.responseSchema.properties.recommendations.items.properties.reason.description,/Notes sentence/);
    return new Response("secret provider message",{status:429});
  }),/Gemini request failed \(429\)/);
});

test("table copy rejects model-generated markup and keeps valid event Notes by identity",()=>{
 for (const brief of ['Opening.\n| Ranking | Activity |','```json','<table>Events</table>','1. First event',Array(41).fill('word').join(' ')]) {
  assert.throws(()=>validateIntelligence({brief,traits:[]},[input]));
 }
 const output=validateIntelligence({brief:'The selected day offers a casual snack event.',traits:[],recommendations:[
  {identityKey:input.identityKey,reason:'| 1 | Lunch |',evidence:'Drop in anytime'},
  {identityKey:'unknown:event',reason:'A short visit suits this format.',evidence:'Drop in anytime'},
  {identityKey:input.identityKey,reason:Array(31).fill('word').join(' '),evidence:'Drop in anytime'},
  {identityKey:input.identityKey,reason:'A brief visit fits the advertised drop-in format.',evidence:'Drop in anytime'},
 ]},[input]);
 assert.deepEqual(output.recommendations,[{identityKey:input.identityKey,reason:'A brief visit fits the advertised drop-in format.',evidence:'Drop in anytime'}]);
});

function setup() {
  const db = freshDatabase();
  const config = defaultConfig(); config.gemini.apiKey = "test-key";
  const repository = new Repository(new SqliteD1(db),config);
  let title = "Campus lunch";
  const fetcher = {async get(){return {ok:true,status:200,text:JSON.stringify(searchPage([
    anchorRow({id:123,name:title,startsOn:`${date}T18:00:00Z`,endsOn:`${date}T19:00:00Z`,description:"Drop in anytime for snacks and conversation."}),
  ])),error:null};}};
  return {db,config,repository,fetcher,changeTitle:()=>{title="Changed lunch";}};
}

test("enrichment survives repository recreation, GETs never infer, changed source invalidates old AI text",async()=>{
  const s=setup(); let calls=0;
  const geminiFetcher: typeof fetch = async(_url,options)=>{
    calls++;
    const event = JSON.parse(JSON.parse(String(options?.body)).contents[0].parts[0].text).events[0];
    return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({brief:"A campus lunch is listed for today.",traits:[
      {identityKey:event.identityKey,level:"drop_in",note:"A brief visit may suit the advertised drop-in format.",evidence:"Drop in anytime"},
    ]})}]}}]});
  };
  assert.equal((await runRefresh({...s,trigger:"test",nowMs,geminiFetcher})).ok,true);
  const recreated = new Repository(new SqliteD1(s.db),s.config);
  const feed=await loadDayFeed(recreated,s.config,date,nowMs);
  assert.equal(feed.brief.source,"gemini"); assert.ok(feed.events[0].participation.ai_note);
  await loadDayFeed(recreated,s.config,date,nowMs);
  await runRefresh({...s,repository:recreated,trigger:"test",nowMs:nowMs+3600000,geminiFetcher});
  assert.equal(calls,1);
  s.changeTitle();
  await runRefresh({...s,trigger:"test",nowMs:nowMs+3600001,geminiFetcher:async()=>new Response("quota exhausted",{status:429})});
  assert.equal((await loadDayFeed(recreated,s.config,date,nowMs)).brief.source,undefined);
  s.db.close();
});

test("quota failures keep publishing and durable retries stop after three attempts",async()=>{
  const s=setup(); let calls=0;
  const geminiFetcher: typeof fetch = async()=>{calls++;return new Response("quota exhausted",{status:429});};
  for (let hour=0;hour<5;hour++) {
    assert.equal((await runRefresh({...s,trigger:"test",nowMs:nowMs+hour*3600000,geminiFetcher})).ok,true);
  }
  assert.equal(calls,3);
  assert.equal((await s.repository.readFeed(date))?.events.length,1);
  assert.equal((await s.repository.readAiState(date))?.attempts,3);
  await assert.rejects(s.repository.saveAiState(date,{attemptDate:date,attempts:1,attemptedAt:new Date(nowMs).toISOString(),result:null},"superseded-holder"));
  assert.equal((await s.repository.readAiState(date))?.attempts,3);
  s.db.close();
});

test("a prompt upgrade refreshes an exhausted old cache but still bounds failed retries",async()=>{
 const s=setup();
 await runRefresh({...s,trigger:"test",nowMs,geminiFetcher:async()=>Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({brief:"The listed event offers snacks.",traits:[]})}]}}]})});
 const previous=(await s.repository.readAiState(date))!;
 previous.attempts=3;
 previous.attemptVersion="old-prompt";
 previous.result!.version="old-prompt";
 previous.result!.hash="old-hash";
 await s.repository.claimLease("upgrade-fixture",nowMs);
 await s.repository.saveAiState(date,previous,"upgrade-fixture");
 await s.repository.releaseLease("upgrade-fixture");
 let calls=0;
 const geminiFetcher:typeof fetch=async()=>{calls++;return new Response("quota exhausted",{status:429});};
 await runRefresh({...s,trigger:"test",nowMs:nowMs+1,geminiFetcher});
 await runRefresh({...s,trigger:"test",nowMs:nowMs+2,geminiFetcher});
 assert.equal(calls,1);
 for (let hour=1;hour<5;hour++) await runRefresh({...s,trigger:"test",nowMs:nowMs+hour*3600000+1,geminiFetcher});
 assert.equal(calls,3);
 assert.equal((await s.repository.readAiState(date))?.attemptVersion,AI_VERSION);
 s.db.close();
});

test("food extraction accepts exact menu evidence and drops invented/negated food",()=>{
 const menu={...input,description:"We will provide pizza and boba. No sushi will be served."};
 const result=validateIntelligence({brief:"今天提供披萨与奶茶。",traits:[],foods:[
  {identityKey:menu.identityKey,items:["pizza","boba","lobster","food","dinner"],evidence:"We will provide pizza and boba."},
  {identityKey:"missing",items:["sushi"],evidence:"No sushi will be served."}],
 recommendations:[{identityKey:menu.identityKey,reason:"菜单具体，餐食价值可结合现场供应量判断。",evidence:"We will provide pizza and boba."},
 {identityKey:menu.identityKey,reason:"免费无限量。",evidence:"Unlimited food for all students"}]},[menu]);
 assert.deepEqual(result.foods[0].items,["pizza","boba"]);
 assert.equal(result.recommendations.length,1);
 assert.deepEqual(validateIntelligence({brief:"菜单未核实。",traits:[],foods:[{identityKey:menu.identityKey,items:["sushi"],evidence:"No sushi will be served."}]},[menu]).foods,[]);
});

test("English brief report retains every event and exposes provenance/model",async()=>{
 const s=setup();
 await runRefresh({...s,trigger:"test",nowMs,geminiFetcher:async(_url,options)=>{
  const event=JSON.parse(JSON.parse(String(options?.body)).contents[0].parts[0].text).events[0];
  return Response.json({candidates:[{finishReason:"STOP",content:{parts:[{text:JSON.stringify({brief:"当天列有免费零食活动，报名与资格仍需核实。",traits:[],foods:[],recommendations:[]})}]}}]});
 }});
 const feed=await loadDayFeed(s.repository,s.config,date,nowMs);
 assert.equal(feed.brief.model,s.config.gemini.model);
 assert.equal(feed.brief.items?.length,feed.events.length);
 assert.equal(feed.brief.origin,"2320 West End Avenue");
 assert.match(feed.brief.items![0].sources,/Second-Source Match Unverified/);
 assert.match(feed.brief.items![0].sources,/Personal calendar is not connected/);
 assert.match(feed.brief.items![0].address,/Unverified/);
 for (const item of feed.brief.items || []) assert.doesNotMatch([item.walk,item.rsvp,item.sources,item.conflicts,item.reason,item.address].join(" "),/[\u4e00-\u9fff]/);
 s.db.close();
});

test("generic meal labels never become a specific menu",()=>{
 const generic={...input,description:"We provide dinner and food for registered students."};
 const result=validateIntelligence({brief:"菜单未注明。",traits:[],foods:[{identityKey:generic.identityKey,items:["dinner","food"],evidence:generic.description}]},[generic]);
 assert.deepEqual(result.foods,[]);
});
