/** Endpoint selection and Google's documented, cross-platform walking URL. */
import { el, one, replace } from './dom.js';
import { setOrigin, state, subscribe } from './state.js';
import { bindPlaceSearch } from './place-search.js';

export function validPoint(point) {
  return Number.isFinite(point?.lat) && Math.abs(point.lat) <= 90 && Number.isFinite(point?.lng) && Math.abs(point.lng) <= 180;
}
export function mapsEndpoint(point) {
  if (validPoint(point)) return `${point.lat},${point.lng}`;
  return typeof point?.address === 'string' && point.address.trim() ? point.address.trim().slice(0,300) : null;
}
export function googleWalkingUrl(origin, destination) {
  const start = mapsEndpoint(origin), end = mapsEndpoint(destination);
  if (!start || !end) return null;
  const params = new URLSearchParams({api:'1',origin:start,destination:end,travelmode:'walking'});
  return `https://www.google.com/maps/dir/?${params}`;
}
export function setDestination(point) {
  state.destination = point;
  renderDirections(document);
}
export function destinationFor(event) {
  if (event.place) return {label:event.place.name,lat:event.place.lat,lng:event.place.lng,eventKey:event.identity_key,date:event.date};
  if (event.location_listed) return {label:event.location_listed,address:`${event.location_listed}, Vanderbilt University, Nashville, TN`,eventKey:event.identity_key,date:event.date};
  return null;
}
function eventChoices() {
  return [...new Map([...state.events,...(state.week?.days?.flatMap(day=>day.events) || [])].map(event=>[event.identity_key,event])).values()];
}
export function renderDirections(root) {
  const start = one('#map-origin', root), end = one('#map-destination',root);
  if (!start || !end) return;
  if (document.activeElement !== start) start.value = state.origin?.label || '';
  const search = one('#map-place-search', root);
  if (document.activeElement !== search) search.value = state.destination?.label || '';
  const events = eventChoices().filter(event => (event.place || event.location_listed) && event.date >= state.config.today);
  const chosen = state.destination;
  const selection = chosen?.eventKey ? `event:${chosen.eventKey}` : '';
  const extra = chosen?.eventKey && !events.some(event => event.identity_key === chosen.eventKey)
    ? [el('option', {value:selection, text:chosen.label})] : [];
  replace(end, [el('option', {value:'', text:'Choose an event'}), ...extra, ...events.map(event => el('option', {value:`event:${event.identity_key}`, text:event.title}))]);
  end.value = selection;
  const destination = state.destination;
  const link=one('[data-role="google-directions"]',root);
  const url=googleWalkingUrl(state.origin,destination);
  if (url) {link.href=url;link.removeAttribute('aria-disabled');link.removeAttribute('tabindex');}
  else {link.removeAttribute('href');link.setAttribute('aria-disabled','true');link.setAttribute('tabindex','-1');}
}
export function bindDirections(root,{onOriginChange,onPinRequest,onDestinationChange}) {
  bindPlaceSearch(one('#map-origin', root), one('#map-origin-options', root), {
    places: () => state.places,
    currentLabel: () => state.origin?.label || '',
    choose: place => {
      setOrigin({label:place.name, lat:place.lat, lng:place.lng, kind:'place'});
      onOriginChange();
    },
  });
  bindPlaceSearch(one('#map-place-search', root), one('#map-place-options', root), {
    places: () => state.places,
    currentLabel: () => state.destination?.label || '',
    choose: place => {
      setDestination({label:place.name, lat:place.lat, lng:place.lng, placeId:place.id});
      if (onDestinationChange) onDestinationChange();
    },
  });
  one('#map-destination', root).addEventListener('change', event => {
    const item = eventChoices().find(item => `event:${item.identity_key}` === event.target.value);
    setDestination(item ? destinationFor(item) : null);
    if (onDestinationChange) onDestinationChange();
  });
  one('[data-action="pin-destination"]',root).addEventListener('click',()=>onPinRequest('destination'));
  one('[data-role="google-directions"]',root).addEventListener('click',event=>{
    if (event.currentTarget.getAttribute('aria-disabled')==='true') event.preventDefault();
  });
  subscribe(()=>renderDirections(root));
  renderDirections(root);
  const controls = one('.directions-controls', root);
  if (controls && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      controls.parentElement.style.setProperty('--map-controls-bottom', `${controls.getBoundingClientRect().height + 24}px`);
    }).observe(controls);
  }
}
