import {lookupPlaces,searchQuery} from '@/lib/vfr/address-search.ts';
import {jsonResponse} from '@/lib/vfr/runtime.ts';
export const dynamic='force-dynamic';
export async function GET(request:Request):Promise<Response> {
  const query=searchQuery(new URL(request.url).searchParams.get('q'));
  if (!query) return jsonResponse({error:'Enter between 3 and 160 characters.'},{status:400});
  const response=await lookupPlaces(query);
  return jsonResponse({...response,attribution:'© OpenStreetMap contributors / Photon'});
}
