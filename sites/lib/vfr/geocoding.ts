/** User-triggered, bounded address lookup. Exact input coordinates stay unchanged. */
export type LocationPoint = {lat: number; lng: number};
export function parseLocation(value: unknown): LocationPoint | null {
  if (!value || typeof value !== 'object') return null;
  const {lat,lng} = value as Record<string, unknown>;
  return typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90
    && typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180 ? {lat,lng} : null;
}
export function addressLabel(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const features = (payload as {features?: unknown}).features;
  if (!Array.isArray(features)) return null;
  for (const feature of features.slice(0, 3)) {
    const p = feature?.properties;
    if (!p || typeof p !== 'object') continue;
    const text = (value: unknown) => typeof value === 'string' ? value.trim().replaceAll('\u00b7', ' ').slice(0,100) : '';
    const street = [text(p.housenumber),text(p.street)].filter(Boolean).join(' ');
    const city = text(p.city) || text(p.district);
    const primary = street || text(p.name);
    if (!primary) continue;
    return [...new Set([primary,city,text(p.state)].filter(Boolean))].join(', ').slice(0,150);
  }
  return null;
}
let pending = false;
let lastRequest = 0;
/** No autocomplete or background queries; one explicit point per request. */
export async function lookupAddress(point: LocationPoint, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (pending || Date.now() - lastRequest < 1100) return null;
  pending = true;
  lastRequest = Date.now();
  try {
    const url = new URL('https://photon.komoot.io/reverse');
    url.search = new URLSearchParams({lat:String(point.lat),lon:String(point.lng),limit:'1',lang:'en',radius:'0.1'}).toString();
    const response = await fetcher(url, {headers:{Accept:'application/json','User-Agent':'VandyFoodRadar/1.0'},signal:AbortSignal.timeout(6000),redirect:'manual'});
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > 65536) return null;
    return addressLabel(JSON.parse(text));
  } catch { return null; }
  finally { pending = false; }
}
