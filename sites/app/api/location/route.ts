import {originAllowed} from '@/lib/vfr/auth.ts';
import {lookupAddress,parseLocation} from '@/lib/vfr/geocoding.ts';
import {jsonResponse} from '@/lib/vfr/runtime.ts';
export const dynamic = 'force-dynamic';
export async function POST(request: Request): Promise<Response> {
  if (!originAllowed(request)) return jsonResponse({error:'cross-origin requests are not accepted'}, {status:403});
  const text = await request.text();
  if (text.length > 1024) return jsonResponse({error:'request body is too large'}, {status:413});
  let value;
  try {value=JSON.parse(text);} catch {return jsonResponse({error:'invalid location'}, {status:400});}
  const point = parseLocation(value);
  if (!point) return jsonResponse({error:'invalid location'}, {status:400});
  const label = await lookupAddress(point);
  return jsonResponse({label,approximate:true,attribution:'© OpenStreetMap contributors / Photon'});
}
