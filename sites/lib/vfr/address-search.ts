/** Bounded Photon autocomplete with a fixed campus bias, cache and upstream pacing. */
import {parseLocation} from './geocoding.ts';
export type AddressResult = {id:string; name:string; detail:string; kind:'address'; lat:number; lng:number};
export function searchQuery(value:unknown):string|null {
  if (typeof value !== 'string') return null;
  const query=value.trim().replace(/\s+/g,' ');
  return query.length>=3 && query.length<=160 && !/[\u0000-\u001f]/.test(query) ? query : null;
}
export function addressResults(payload:unknown):AddressResult[] {
  const features=(payload as {features?:unknown})?.features;
  if (!Array.isArray(features)) return [];
  const results:AddressResult[]=[];
  const clean=(value:unknown)=>typeof value==='string' ? value.trim().replaceAll('\u00b7',' ').slice(0,120) : '';
  for (const feature of features.slice(0,12)) {
    const coordinates=feature?.geometry?.coordinates, properties=feature?.properties;
    if (feature?.geometry?.type!=='Point' || !Array.isArray(coordinates) || !properties || typeof properties!=='object') continue;
    const point=parseLocation({lat:coordinates[1],lng:coordinates[0]});
    if (!point) continue;
    const street=[clean(properties.housenumber),clean(properties.street)].filter(Boolean).join(' ');
    const name=clean(properties.name) || street;
    if (!name) continue;
    const detail=[...new Set([street,clean(properties.city)||clean(properties.district),clean(properties.state),clean(properties.country)].filter(value=>value && value!==name))].join(', ').slice(0,220);
    const id=`address:${point.lat},${point.lng}:${name}`;
    if (!results.some(result=>result.id===id)) results.push({id,name,detail,kind:'address',...point});
    if (results.length===6) break;
  }
  return results;
}
type SearchResponse={results:AddressResult[]; status:'ok'|'busy'|'unavailable'};
const cache=new Map<string,{expires:number; results:AddressResult[]}>();
let pending=false, lastRequest=0;
export async function lookupPlaces(query:string, fetcher:typeof fetch=fetch):Promise<SearchResponse> {
  const valid=searchQuery(query);
  if (!valid) return {results:[],status:'ok'};
  const key=valid.toLowerCase(), hit=cache.get(key);
  if (hit && hit.expires>Date.now()) return {results:hit.results,status:'ok'};
  if (pending || Date.now()-lastRequest<1100) return {results:[],status:'busy'};
  pending=true; lastRequest=Date.now();
  try {
    const url=new URL('https://photon.komoot.io/api');
    url.search=new URLSearchParams({q:valid,limit:'6',lang:'en',lat:'36.1447',lon:'-86.8027',location_bias_scale:'0.2'}).toString();
    const response=await fetcher(url,{headers:{Accept:'application/json','User-Agent':'VandyFoodRadar/1.0'},signal:AbortSignal.timeout(6000),redirect:'manual'});
    if (!response.ok) return {results:[],status:'unavailable'};
    const text=await response.text();
    if (text.length>65536) return {results:[],status:'unavailable'};
    const results=addressResults(JSON.parse(text));
    cache.delete(key);cache.set(key,{expires:Date.now()+300000,results});
    if (cache.size>128) cache.delete(cache.keys().next().value!);
    return {results,status:'ok'};
  } catch {return {results:[],status:'unavailable'};}
  finally {pending=false;}
}
