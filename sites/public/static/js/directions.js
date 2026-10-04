/** Endpoint selection and Google's documented, cross-platform walking URL. */
import { one } from './dom.js';
import { cancelPinMode } from './map.js';
import { setOrigin, state, subscribe } from './state.js';
import { bindPlaceSearch, searchAddresses } from './place-search.js';
import { destinationFor, googleWalkingUrl } from './maps-links.js';
export { destinationFor, googleWalkingUrl, mapsEndpoint, validPoint } from './maps-links.js';

export function setDestination(point) {
  invalidateWalkingRoute();
  state.destination = point;
  renderDirections(document);
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
  const common={remote:searchAddresses,openOnFocus:true,alphabetical:true,onChoose:cancelPinMode,onCancel:cancelPinMode};
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
