/** Endpoint selection and Google's documented, cross-platform walking URL. */
import { one } from './dom.js';
import { cancelPinMode } from './map.js';
import { setOrigin, state, subscribe } from './state.js';
import { bindPlaceSearch, searchAddresses } from './place-search.js';

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
  invalidateWalkingRoute();
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
  const start=one('#map-origin',root), search=one('#map-place-search',root);
  if (!start || !search) return;
  if (document.activeElement!==start) start.value=state.origin?.label || '';
  if (document.activeElement!==search) search.value=state.destination?.label || '';
  const destination = state.destination;
  const link=one('[data-role="google-directions"]',root);
  const url=googleWalkingUrl(state.origin,destination);
  if (url) {link.href=url;link.removeAttribute('aria-disabled');link.removeAttribute('tabindex');}
  else {link.removeAttribute('href');link.setAttribute('aria-disabled','true');link.setAttribute('tabindex','-1');}
}
export function invalidateWalkingRoute() {
  const label=one('[data-role="walking-route-status"]');
  if (label) label.textContent='';
  import('./map.js').then(module=>{module.clearRoute();module.syncWalkingRoute(document);});
}
export function bindDirections(root,{onOriginChange,onPinRequest,onDestinationChange}) {
  const campus=()=>state.places.map(place=>({...place,kind:'campus'}));
  const common={remote:searchAddresses,openOnFocus:true,onChoose:cancelPinMode,onCancel:cancelPinMode};
  bindPlaceSearch(one('#map-origin',root),one('#map-origin-options',root),{
    ...common,places:campus,currentLabel:()=>state.origin?.label || '',onFocus:()=>onPinRequest('origin',true),
    choose:place=>{setOrigin({label:place.kind==='address' && place.detail ? `${place.name}, ${place.detail}` : place.name,lat:place.lat,lng:place.lng,kind:'place'});onOriginChange();},
  });
  bindPlaceSearch(one('#map-place-search',root),one('#map-place-options',root),{
    ...common, currentLabel:()=>state.destination?.label || '',onFocus:()=>onPinRequest('destination',true),
    places:()=>[...eventChoices().filter(event=>!event.cancelled && (event.place || event.location_listed) && event.date>=state.config.today)
      .map(event=>({id:`event:${event.identity_key}`,name:event.title,aliases:[event.place?.name,event.location_listed].filter(Boolean),detail:`${event.date} / ${event.place?.name || event.location_listed}`,kind:'event',event})),...campus()],
    choose:place=>{
      setDestination(place.kind==='event' ? destinationFor(place.event) : {label:place.detail ? `${place.name}, ${place.detail}` : place.name,lat:place.lat,lng:place.lng,placeId:place.id});
      onDestinationChange?.();
    },
  });
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
