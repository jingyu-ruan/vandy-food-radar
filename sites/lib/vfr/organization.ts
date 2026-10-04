import {htmlToPlainText} from './text.ts';
export type HostProfile={id:number;name:string;description:string|null;url:string|null};
export function organizationProfile(payload:unknown):HostProfile|null {
  if(!payload || typeof payload!=='object')return null;
  const row=payload as Record<string,unknown>;
  if(!Number.isSafeInteger(row.id) || Number(row.id)<=0 || typeof row.name!=='string' || !row.name.trim())return null;
  const slug=typeof row.websiteKey==='string' && /^[a-zA-Z0-9_-]+$/.test(row.websiteKey) ? row.websiteKey : null;
  return {id:Number(row.id),name:row.name.trim(),description:htmlToPlainText(row.description),url:slug ? `https://anchorlink.vanderbilt.edu/organization/${slug}` : null};
}
const cache=new Map<string,{expires:number;value:unknown}>();
const pending=new Map<string,Promise<unknown>>();
async function discovery(path:string,fetcher:typeof fetch) {
  const hit=cache.get(path);if(hit && hit.expires>Date.now())return hit.value;
  if(pending.has(path))return pending.get(path);
  const task=(async()=>{
    const response=await fetcher(`https://anchorlink.vanderbilt.edu/api/discovery/${path}`,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw new Error('Host profile unavailable');
    const value:unknown=await response.json();
    if(cache.size>=256)cache.delete(cache.keys().next().value!);
    cache.set(path,{expires:Date.now()+86400000,value});return value;
  })();
  pending.set(path,task);
  try{return await task;}finally{pending.delete(path);}
}
export async function eventHostProfile(eventId:string,fetcher:typeof fetch=fetch):Promise<HostProfile|null> {
  if(!/^[1-9][0-9]{0,11}$/.test(eventId))return null;
  const event=await discovery(`event/${eventId}`,fetcher) as {organizationId?:unknown};
  if(!Number.isSafeInteger(event?.organizationId) || Number(event.organizationId)<=0)return null;
  return organizationProfile(await discovery(`organization/${event.organizationId}`,fetcher));
}
