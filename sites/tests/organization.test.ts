import assert from 'node:assert/strict';
import test from 'node:test';
import {eventHostProfile,organizationProfile} from '../lib/vfr/organization.ts';
test('host descriptions become plain text and source URLs use a validated organization slug',()=>{
  assert.deepEqual(organizationProfile({id:12,name:'Host',websiteKey:'host-club',description:'<p>Welcome &amp; learn</p><script>bad()</script>'}),{id:12,name:'Host',description:'Welcome & learn',url:'https://anchorlink.vanderbilt.edu/organization/host-club'});
  assert.equal(organizationProfile({id:12,name:'Host',websiteKey:'https://bad.test',description:null})?.url,null);
  assert.equal(organizationProfile({name:'Host'}),null);
});
test('event lookup follows the primary hosting organization and ignores invalid IDs',async()=>{
  const paths:string[]=[];
  const fetcher=(async(url:RequestInfo|URL)=>{paths.push(String(url));return new Response(JSON.stringify(paths.length===1?{organizationId:9876}:{id:9876,name:'Science Club',websiteKey:'science',description:'Study together'}));}) as typeof fetch;
  assert.equal((await eventHostProfile('77889900',fetcher))?.name,'Science Club');
  assert.deepEqual(paths,['https://anchorlink.vanderbilt.edu/api/discovery/event/77889900','https://anchorlink.vanderbilt.edu/api/discovery/organization/9876']);
  assert.equal(await eventHostProfile('../secret',fetcher),null);
  assert.equal(paths.length,2);
});
