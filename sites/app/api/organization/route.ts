import {eventHostProfile} from '@/lib/vfr/organization.ts';
import {jsonResponse} from '@/lib/vfr/runtime.ts';
export const dynamic='force-dynamic';
export async function GET(request:Request):Promise<Response> {
  const id=new URL(request.url).searchParams.get('event');
  if(!id || !/^[1-9][0-9]{0,11}$/.test(id))return jsonResponse({error:'Invalid event ID'},{status:400});
  try {const profile=await eventHostProfile(id);return jsonResponse({profile},{status:profile?200:404});}
  catch {return jsonResponse({error:'Host introduction is temporarily unavailable'},{status:503});}
}
