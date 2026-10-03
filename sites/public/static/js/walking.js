/** Labelled walking estimates, refreshed when the origin or date changes. */
import { fetchWalking } from './api.js';
import { state } from './state.js';

let generation = 0;
const routeCache = new Map();

export function estimateMinutes(from, to) {
  const radians = value => value * Math.PI / 180;
  const lat1 = radians(from.lat), lat2 = radians(to.lat);
  const a = Math.sin((lat2-lat1)/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(radians(to.lng-from.lng)/2)**2;
  return Math.max(1, Math.ceil(6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) / 80));
}

export async function walkingLeg(from, to) {
  if (!state.config.card_routing_available) return {minutes:estimateMinutes(from,to),mode:'estimate'};
  const key = [from.lat,from.lng,to.lat,to.lng].map(value=>value.toFixed(5)).join(',');
  if (!routeCache.has(key)) {
    const promise = fetchWalking([from,to]).catch(() => ({minutes:estimateMinutes(from,to),mode:'estimate'}));
    routeCache.set(key,promise);
    if (routeCache.size > 512) routeCache.delete(routeCache.keys().next().value);
  }
  return routeCache.get(key);
}

export async function refreshWalking(root) {
  const current = ++generation;
  const origin = {...state.origin};
  const cards = Array.from(root.querySelectorAll('.card'));
  let cursor = 0;
  await Promise.all(Array.from({length:3},async()=> {
    while (cursor < cards.length) {
      const card = cards[cursor++];
      const event = state.events.find(item=>item.identity_key===card.dataset.identityKey);
      const node = card.querySelector('[data-role="walking"]');
      if (!node || !event?.place) continue;
      const result = await walkingLeg(origin,{lat:event.place.lat,lng:event.place.lng});
      if (current !== generation) return;
      node.textContent = result.mode === 'routed'
        ? `${result.minutes} min walk from ${origin.label}`
        : `~${result.minutes} min estimate from ${origin.label}`;
      node.title = result.mode === 'routed' ? 'Pedestrian route' : 'Straight-line distance at 80 metres/minute; paths and entrances can add time.';
    }
  }));
}
