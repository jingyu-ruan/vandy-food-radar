import { displayText, eventTime } from './preferences.js';
/**
 * Campus map, warmed after the first paint and initialised on first use.
 *
 * Leaflet is ~150 KB and most sessions never leave the card view, so the
 * library is warmed during idle time from a CDN with Subresource Integrity hashes.
 * If that fetch fails — offline, blocked CDN, integrity mismatch — the panel
 * states plainly that the map is unavailable and keeps the adjacent list of
 * mapped listings usable, rather than showing an empty grey rectangle.
 *
 * Markers are drawn only for events whose listed location matched the curated
 * campus dataset. An unmatched location gets no marker: a pin in roughly the
 * right place would be a fabricated claim about where to go.
 */

import { el, one, replace } from './dom.js';
import { isSaved, state } from './state.js';
import { cameraChange, coordinateKey } from './map-camera.js';

const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS_SRI = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
const LEAFLET_JS_SRI = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const FALLBACK_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';
const BASEMAP_ATTRIBUTION = '<a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://openmaptiles.org">OpenMapTiles</a> ' + OSM_ATTRIBUTION;

let leafletPromise = null;
let map = null;
let markerLayer = null;
const markers = new Map();
let lastCamera = null;
let lastFramedWeek = null;
let originKey = null;
let destinationKey = null;
let originMarker = null;
let destinationMarker = null;
let campusLayer = null;
let routeLine = null;
let routeGeneration = 0;
let autoRouteKey = null;
let autoRouteTimer = null;
let pinMode = null;
let onPin = null;

let vectorAssetsPromise = null;

function loadMapAsset(tag, url, integrity) {
  return new Promise((resolve, reject) => {
    const asset = el(tag, {
      ...(tag === 'link' ? {rel: 'stylesheet', href: url} : {src: url}),
      integrity, crossorigin: 'anonymous',
    });
    asset.addEventListener('load', resolve, {once: true});
    asset.addEventListener('error', () => reject(new Error('could not load the vector basemap')), {once: true});
    document.head.append(asset);
  });
}

function loadVectorAssets() {
  if (!vectorAssetsPromise) {
    vectorAssetsPromise = Promise.all([
      loadMapAsset('link', 'https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.css', 'sha256-eSrJl9z2rm9kPrTi3uRjDIXnBWUmvY+4X/6Dxn1sQbQ='),
      loadMapAsset('script', 'https://unpkg.com/maplibre-gl@5.6.1/dist/maplibre-gl.js', 'sha256-taNOaTD/k327ue7IiSz/uAukc8zoiuXKjEZUQy9fDrw='),
    ]).then(() => loadMapAsset('script', 'https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.4/leaflet-maplibre-gl.js', 'sha256-Hmz4yz61/ZCYeaob82o4P7UGyaWy27+rq85lopTdH8s='));
  }
  return vectorAssetsPromise;
}

async function addBasemap(L, canvas) {
  let vectorLayer;
  let fallbackActive = false;
  const fallback = () => {
    if (fallbackActive) return;
    fallbackActive = true;
    vectorLayer?.remove();
    map.attributionControl.removeAttribution(BASEMAP_ATTRIBUTION);
    L.tileLayer(FALLBACK_TILE_URL, {maxZoom: 19, attribution: OSM_ATTRIBUTION}).addTo(map);
    canvas.append(el('p', {class: 'map-basemap-notice', text: 'Simplified basemap unavailable. Showing the standard map.'}));
  };
  try {
    await loadVectorAssets();
    vectorLayer = L.maplibreGL({style: BASEMAP_STYLE, attribution: BASEMAP_ATTRIBUTION, attributionControl: false}).addTo(map);
    map.attributionControl.addAttribution(BASEMAP_ATTRIBUTION);
    const renderer = vectorLayer.getMaplibreMap();
    renderer.once('style.load', () => {
      // A flat, light campus background leaves activity markers prominent.
      renderer.setLayerZoomRange('building', 13, 24);
      renderer.setPaintProperty('background', 'background-color', '#fafbf9');
      renderer.setPaintProperty('landuse_residential', 'fill-color', '#f3f4f1');
      renderer.setPaintProperty('building', 'fill-color', '#e4e7e6');
      renderer.setPaintProperty('building', 'fill-outline-color', '#d9dde2');
      renderer.setPaintProperty('park', 'fill-color', '#cfe5c4');
      renderer.setPaintProperty('park', 'fill-opacity', 1);
      renderer.setPaintProperty('landcover_grass', 'fill-opacity', .55);
      renderer.setPaintProperty('park', 'fill-outline-color', '#cfe5c4');
      renderer.removeLayer('building-3d');
      for (const [id, zoom] of [['poi_r1', 17], ['poi_r7', 18], ['poi_r20', 19]]) {
        renderer.setLayerZoomRange(id, zoom, 24);
      }
    });
    // Recover from blocked style/tile requests instead of leaving a blank map.
    renderer.once('error', fallback);
  } catch {
    fallback();
  }
}

function loadStylesheet() {
  if (document.querySelector('link[data-leaflet]')) return;
  const link = el('link', {
    rel: 'stylesheet',
    href: LEAFLET_CSS,
    integrity: LEAFLET_CSS_SRI,
    crossorigin: 'anonymous',
    'data-leaflet': 'css',
  });
  document.head.append(link);
}

/** Load Leaflet once; the returned promise rejects if the CDN fetch fails. */
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    loadStylesheet();
    const script = el('script', {
      src: LEAFLET_JS,
      integrity: LEAFLET_JS_SRI,
      crossorigin: 'anonymous',
      'data-leaflet': 'js',
    });
    script.addEventListener('load', () => {
      if (window.L) resolve(window.L);
      else reject(new Error('Leaflet loaded but did not initialise'));
    });
    script.addEventListener('error', () => reject(new Error('could not load the map library')));
    document.head.append(script);
  });
  return leafletPromise;
}

/** Fetch shared assets during idle time; the visible panel handles failures. */
export function prepareMap() {
  loadLeaflet().catch(() => {});
}

function status(root, message) {
  const canvas = one('[data-role="map"]', root);
  if (!canvas) return;
  replace(canvas, el('p', { class: 'map-placeholder', dataset: { role: 'map-status' }, text: message }));
}

function mappable() {
  const events = state.view === 'schedule' && state.week?.days
    ? state.week.days.filter(day => day.date >= state.config.today).flatMap(day => day.events) : state.events;
  return events.filter((event) => event.place && !event.cancelled && (state.view !== 'itinerary' || isSaved(event.date,event.identity_key)));
}

function markerFor(L, event) {
  const saved = isSaved(event.date, event.identity_key);
  const icon = L.divIcon({
    className: 'vfr-pin-wrap',
    html: `<span class="vfr-pin${saved ? ' is-saved' : ''}${state.selectedKey === event.identity_key ? ' is-selected' : ''}"></span>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
  const marker = L.marker([event.place.lat, event.place.lng], {
    icon,
    keyboard: true,
    title: event.title,
    alt: event.title,
  });
  // Leaflet interprets string tooltip content as HTML, so use a text node.
  marker.bindTooltip(el('span', { text: `${event.title}. ${event.place.name}${event.place.detail ? ', ' + event.place.detail : ''}. ${eventTime(event)}` }), {direction:'top', offset:[0,-10]});
  marker.on('add', () => marker.getElement()?.setAttribute('aria-label', `${event.title}, ${event.date}, ${eventTime(event)}`));
  if (state.selectedKey === event.identity_key) marker.setZIndexOffset(1000);
  return marker;
}

/** Render the list beside the map; it works even when the map cannot load. */
function renderList(root, onSelect) {
  const list = one('[data-role="map-list"]', root);
  if (!list) return;
  const scope = state.view === 'schedule' ? state.weekStart : state.selectedDate;
  const scroll = list.dataset.scope === scope ? list.scrollTop : 0;
  const focused = list.contains(document.activeElement) ? document.activeElement.closest('button')?.dataset.identityKey : null;
  list.dataset.scope = scope;
  const events = (state.view === 'schedule' ? state.week?.days?.filter(day=>day.date>=state.config.today).flatMap(day=>day.events) || [] : state.events).filter(event=>!event.cancelled);
  const count = one('[data-role="map-event-count"]', root);
  if (count) count.textContent=String(events.length);
  const selected = events.find(event=>event.identity_key===state.selectedKey);
  const selection = one('[data-role="map-selection"]', root);
  if (selection) {
    selection.textContent = displayText(selected
      ? `${selected.title} — ${selected.date}, ${eventTime(selected)}. ${selected.place?.name || selected.location_listed || 'Location not listed'}${selected.place?.detail ? ', '+selected.place.detail : ''}`
      : 'Choose a map marker to see its location. Saved events have gold markers.');
  }
  if (!events.length) {
    replace(
      list,
      el('li', {}, [
        el('span', {
          class: 'map-list-sub',
          text: 'No events are listed for this date.',
        }),
      ]),
    );
    return;
  }
  replace(
    list,
    events.map((event) => {
      const button = el('button', {
        type: 'button',
        class: state.selectedKey === event.identity_key ? 'is-selected' : '',
        'aria-pressed':String(state.selectedKey === event.identity_key),
        dataset: { identityKey: event.identity_key },
      }, [
        el('span', { text: event.title }),
        el('span', { class: 'map-list-sub', text: `${eventTime(event)}  ${event.place?.name || event.location_listed || 'Location not listed'}${event.place ? '' : ' (Not Mapped)'}` }),
      ]);
      button.addEventListener('click', () => {if(pinMode && event.place)pickPoint({lat:event.place.lat,lng:event.place.lng,label:event.place.name});else onSelect(event.identity_key);});
      return el('li', {}, button);
    }),
  );
  list.scrollTop = scroll;
  if (focused) [...list.querySelectorAll('button')].find(button => button.dataset.identityKey === focused)?.focus({preventScroll:true});
}

/** Open the map view, loading Leaflet on first use. */
export async function showMap(root, { onSelect, onPinned }) {
  onPin = onPinned;
  renderList(root, onSelect);
  const canvas = one('[data-role="map"]', root);
  if (!canvas) return;

  if (map) {
    map.invalidateSize({pan:false, animate:false, debounceMoveend:true});
    syncMarkers(root, onSelect);
    return;
  }

  status(root, 'Loading map\u2026');
  let L;
  try {
    L = await loadLeaflet();
  } catch (error) {
    status(
      root,
      `The map could not be loaded (${error.message}). The list beside it still shows every listing with a resolved building.`,
    );
    return;
  }

  if (map) {
    map.invalidateSize({pan:false, animate:false, debounceMoveend:true});
    syncMarkers(root, onSelect);
    return;
  }

  replace(canvas, []);
  const reference = state.origin || state.config.reference;
  map = L.map(canvas, { zoomControl: true, attributionControl: true, minZoom: 2, maxZoom: 20 }).setView(
    [reference.lat, reference.lng],
    16,
  );
  await addBasemap(L, canvas);
  markerLayer = L.layerGroup().addTo(map);
  map.on('click', (clickEvent) => {
    if (!pinMode || !onPin) return;
    pickPoint({lat:clickEvent.latlng.lat,lng:clickEvent.latlng.lng});
  });
  syncMarkers(root, onSelect);
}

/** Redraw markers for the loaded day and the current origin. */
export function syncMarkers(root, onSelect) {
  renderList(root, onSelect);
  if (!map || !window.L || !markerLayer) return;
  const L = window.L;
  const events = mappable();
  const activeKeys = new Set();
  for (const event of events) {
    const key = `${event.date}:${event.identity_key}`;
    activeKeys.add(key);
    const signature = JSON.stringify([event.place.lat, event.place.lng, event.title, eventTime(event), isSaved(event.date, event.identity_key), state.selectedKey === event.identity_key]);
    const previous = markers.get(key);
    if (previous?.signature === signature) continue;
    if (previous) markerLayer.removeLayer(previous.marker);
    const marker = markerFor(L, event);
    marker.on('click', () => {if(pinMode)pickPoint({lat:event.place.lat,lng:event.place.lng,label:event.place.name});else onSelect(event.identity_key);});
    marker.addTo(markerLayer);
    markers.set(key, {marker, signature});
  }
  for (const [key, entry] of markers) {
    if (!activeKeys.has(key)) {markerLayer.removeLayer(entry.marker); markers.delete(key);}
  }

  const origin = state.origin;
  const nextOriginKey = JSON.stringify(origin);
  if (nextOriginKey !== originKey) {
    originMarker?.remove();
    originMarker = null;
    originKey = nextOriginKey;
  }
  if (origin && !originMarker) {
    originMarker = L.marker([origin.lat, origin.lng], {
      icon: L.divIcon({
        className: 'vfr-pin-wrap',
        html: '<span class="vfr-pin is-origin"></span>',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
      }),
      title: origin.label,
      alt: origin.label,
    });
    originMarker.bindTooltip(el('span', { text: origin.label }));
    originMarker.addTo(map);
  }

  const destination=state.destination;
  const nextDestinationKey = JSON.stringify(destination);
  if (nextDestinationKey !== destinationKey) {
    destinationMarker?.remove();
    destinationMarker = null;
    destinationKey = nextDestinationKey;
  }
  if(!destinationMarker && Number.isFinite(destination?.lat) && Number.isFinite(destination?.lng)) {
    destinationMarker=L.marker([destination.lat,destination.lng],{icon:L.divIcon({className:'vfr-pin-wrap',html:'<span class="vfr-pin is-destination"></span>',iconSize:[16,16],iconAnchor:[8,8]}),title:`Destination: ${destination.label}`,alt:`Destination: ${destination.label}`}).addTo(map);
    destinationMarker.bindTooltip(el('span',{text:`Destination: ${destination.label}`}));
  }
  if(pinMode) drawCampusChoices();

  // A mobile agenda hides the canvas. Fitting a zero-sized map would choose
  // a world-level zoom; fit only once the map panel has a measurable size.
  const canvas = map.getContainer();
  // A tab switch changes the canvas size, not the visitor's chosen camera.
  const nextCamera = {date:state.selectedDate, origin:coordinateKey(origin), destination:coordinateKey(destination), selected:state.selectedKey};
  const change = cameraChange(lastCamera, nextCamera);
  const needsWeekFrame = state.view === 'schedule' && state.week?.days?.length && lastFramedWeek !== state.weekStart;
  if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
    lastCamera = nextCamera;
    if (needsWeekFrame) lastFramedWeek = state.weekStart;
    if (change === 'destination' && destination.eventKey !== state.selectedKey) {
      moveCamera([destination.lat, destination.lng]);
    } else if (change === 'origin') {
      moveCamera([origin.lat, origin.lng]);
    } else if ((change === 'initial' || change === 'date' || needsWeekFrame) && events.length && !state.selectedKey) {
      const bounds = L.latLngBounds(events.map((event) => [event.place.lat, event.place.lng]));
      if (origin && Math.abs(origin.lat-events[0].place.lat)<0.1 && Math.abs(origin.lng-events[0].place.lng)<0.1) bounds.extend([origin.lat, origin.lng]);
      if(destinationMarker && Math.abs(destination.lat-events[0].place.lat)<0.1 && Math.abs(destination.lng-events[0].place.lng)<0.1) bounds.extend([destination.lat,destination.lng]);
      map.stop();
      map.fitBounds(bounds.pad(0.25), { animate: change !== 'initial' && !prefersReducedMotion(), duration:0.55, maxZoom:17 });
    }
  }
  syncWalkingRoute(root);
}

function moveCamera(point) {
  map.stop();
  map.panTo(point, {animate:!prefersReducedMotion(), duration:0.55});
}

/** Pan to a selected event, if it has a resolved building. */
export function panTo(identityKey) {
  if (!map) return;
  const event = mappable().find((item) => item.identity_key === identityKey);
  if (!event || !event.place) return;
  moveCamera([event.place.lat, event.place.lng]);
}

/** Open the tooltip on a marker so the location name is visible after panning. */
export function openTooltip(identityKey) {
  if (!map || !markerLayer) return;
  for (const entry of markers.values()) {
    entry.marker.closeTooltip();
  }
  for (const [key, entry] of markers) {
    if (key.endsWith(`:${identityKey}`)) {
      entry.marker.openTooltip();
      return;
    }
  }
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function clearRoute() {
  window.clearTimeout(autoRouteTimer);
  autoRouteTimer = null;
  autoRouteKey = null;
  routeGeneration += 1;
  if (routeLine) { routeLine.remove(); routeLine = null; }
}

/** Road geometry when supplied; dashed links always denote estimates. */
export async function drawPlan(points) {
  clearRoute();
  const generation = routeGeneration;
  if (!map || points.length < 2) return;
  let geometry = points.map(point=>[point.lat,point.lng]);
  let estimated = true;
  if (state.config.routing_available && points.length <= state.config.max_waypoints) {
    try {
      const {fetchWalking} = await import('./api.js');
      const route = await fetchWalking(points);
      if (route.mode==='routed' && route.geometry?.length > 1) {
        geometry = route.geometry;
        estimated = false;
      }
    } catch { /* Retain explicitly dashed links. */ }
  }
  if (state.view !== 'itinerary' || generation !== routeGeneration) return;
  routeLine = window.L.polyline(geometry,{color:'#8f7d31',weight:3,dashArray:estimated?'6 8':null}).addTo(map);
  const label = one('[data-role="map-selection"]');
  if (label) label.textContent = estimated
    ? 'Dashed connections show the planned order. Walking times use straight-line estimates.'
    : 'Walking route from OpenRouteService.';
}

function pickPoint(point) {
  if(!pinMode || !onPin)return;
  const mode=pinMode;
  cancelPinMode();
  onPin(point,mode);
}
function drawCampusChoices() {
  if(!map || !window.L)return;
  if(!campusLayer)campusLayer=window.L.layerGroup().addTo(map);
  campusLayer.clearLayers();
  for(const place of state.places || []) {
    const label=`Choose ${place.name} as ${pinMode==='origin' ? 'starting point' : 'destination'}`;
    const marker=window.L.marker([place.lat,place.lng],{keyboard:true,title:label,alt:label,icon:window.L.divIcon({className:'vfr-campus-wrap',html:'<span class="vfr-campus-pin"></span>',iconSize:[24,24],iconAnchor:[12,12]})});
    marker.bindTooltip(el('span',{text:place.name}));
    marker.on('add',()=>{
      const element=marker.getElement();
      element?.setAttribute('aria-label',label);
      element?.addEventListener('keydown',event=>{
        if(event.key==='Enter' || event.key===' ') {event.preventDefault();event.stopPropagation();pickPoint({lat:place.lat,lng:place.lng,label:place.name});}
      });
    });
    marker.on('click',()=>pickPoint({lat:place.lat,lng:place.lng,label:place.name}));
    marker.addTo(campusLayer);
  }
}
/** Named campus markers and arbitrary map coordinates use the same selection flow. */
export function armPinMode(mode='origin') {
  if(!map)return false;
  pinMode=mode==='destination' ? 'destination' : 'origin';
  one('[data-role="map-instructions"]').hidden=false;
  one('[data-role="pin-instructions"]').textContent=`Choose your ${pinMode==='origin' ? 'starting point' : 'destination'}: select a campus marker or click anywhere on the map.`;
  map.getContainer().classList.add('is-picking');
  drawCampusChoices();
  if(state.places?.length) map.fitBounds(window.L.latLngBounds(state.places.map(place=>[place.lat,place.lng])).pad(.12),{animate:false,maxZoom:16});
  map.getContainer().scrollIntoView({block:'nearest',behavior:'instant'});
  return true;
}
export function cancelPinMode() {
  pinMode=null;
  const instructions=one('[data-role="map-instructions"]');
  if(instructions)instructions.hidden=true;
  if(map)map.getContainer().classList.remove('is-picking');
  if(campusLayer)campusLayer.clearLayers();
}

/** Whether the map instance exists (i.e. Leaflet loaded successfully). */
export function mapReady() {
  return Boolean(map);
}

/** Coalesce endpoint changes and draw each coordinate pair once in Map. */
export function syncWalkingRoute(root) {
  if (!map || state.view !== 'map') return;
  const origin=state.origin, destination=state.destination;
  const label=one('[data-role="walking-route-status"]',root);
  if (!Number.isFinite(origin?.lat) || !Number.isFinite(origin?.lng) || !Number.isFinite(destination?.lat) || !Number.isFinite(destination?.lng)) {
    clearRoute();
    if (label) label.textContent=destination ? 'This destination has no verified map coordinates. Open Google Maps to check walking directions.' : '';
    return;
  }
  const key=JSON.stringify([origin.lat,origin.lng,destination.lat,destination.lng]);
  if (key===autoRouteKey) return;
  clearRoute();
  autoRouteKey=key;
  if (label) label.textContent='Finding a walking route…';
  autoRouteTimer=window.setTimeout(()=>{autoRouteTimer=null;showWalkingRoute(root);},180);
}

/** Draw a selected two-point pedestrian route; stale requests never replace a new selection. */
export async function showWalkingRoute(root) {
  clearRoute();
  const generation = routeGeneration;
  const origin = state.origin, destination = state.destination;
  autoRouteKey=JSON.stringify([origin?.lat,origin?.lng,destination?.lat,destination?.lng]);
  const label = one('[data-role="walking-route-status"]', root);
  if (!map || !Number.isFinite(origin?.lat) || !Number.isFinite(destination?.lat)) {
    if (label) label.textContent='Choose mapped From and To locations to draw a walking route.';
    return;
  }
  if (label) label.textContent='Finding a walking route…';
  try {
    const {fetchWalking} = await import('./api.js');
    const route = await fetchWalking([origin,destination]);
    if (generation !== routeGeneration || origin !== state.origin || destination !== state.destination || state.view !== 'map') return;
    const estimated = route.mode !== 'routed' || route.geometry?.length < 2;
    const geometry = estimated ? [[origin.lat,origin.lng],[destination.lat,destination.lng]] : route.geometry;
    routeLine = window.L.polyline(geometry,{color:'#007aff',weight:4,opacity:0.85,dashArray:estimated?'6 8':null}).addTo(map);
    map.fitBounds(routeLine.getBounds().pad(0.18),{animate:!prefersReducedMotion(),maxZoom:18});
    if (label) label.textContent=estimated ? `~${route.minutes} min straight-line estimate; actual walking route unverified.` : `${route.minutes} min walking · ${(route.distance_m/1000).toFixed(2)} km`;
  } catch {
    if (generation === routeGeneration && label) label.textContent='Walking route unavailable. Try again or open Google Maps.';
  }
}
