/** Labelled walking estimates, refreshed when the origin or date changes. */
import { fetchWalking } from './api.js';
import { state } from './state.js';
import { googleWalkingUrl } from './maps-links.js';

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
  for (const link of root.querySelectorAll('[data-role="place-directions"]')) {
    const card = link.closest('.card');
    const destination = card.dataset.lat !== undefined
      ? {lat:Number(card.dataset.lat),lng:Number(card.dataset.lng)}
      : {address:link.dataset.destinationAddress};
    const url = googleWalkingUrl(origin,destination);
    if (url) link.href=url;
    else link.removeAttribute('href');
  }
  const briefRows = new Map(Array.from(root.querySelectorAll('.brief-table tbody tr')).map(row => [row.dataset.identityKey, row]));
  const cards = Array.from(root.querySelectorAll('.card'));
  let cursor = 0;
  await Promise.all(Array.from({length:3},async()=> {
    while (cursor < cards.length) {
      const card = cards[cursor++];
      const event = state.events.find(item=>item.identity_key===card.dataset.identityKey);
      const node = card.querySelector('[data-role="walking"]');
      if (!node || !event?.place) continue;
      const briefNode = briefRows.get(event.identity_key)?.querySelector('[data-role="brief-walking"]');
      if (briefNode) {
        briefNode.textContent = `${estimateMinutes(origin,event.place)} min`;
        briefNode.title = 'Straight-line distance at 80 metres/minute; paths and entrances can add time.';
        briefNode.setAttribute('aria-label', `${briefNode.textContent} estimated from ${origin.label}. ${briefNode.title}`);
      }
      const result = await walkingLeg(origin,{lat:event.place.lat,lng:event.place.lng});
      if (current !== generation) return;
      node.textContent = result.mode === 'routed'
        ? `${result.minutes} min walk from ${origin.label}`
        : `${result.minutes} min estimate from ${origin.label}`;
      node.title = result.mode === 'routed' ? 'Pedestrian route' : 'Straight-line distance at 80 metres/minute; paths and entrances can add time.';
      if (briefNode) {
        briefNode.textContent = `${result.minutes} min`;
        briefNode.title = node.title;
        briefNode.setAttribute('aria-label', `${result.minutes} minutes ${result.mode === 'routed' ? 'walking' : 'estimated'} from ${origin.label}. ${node.title}`);
      }
    }
  }));
}
