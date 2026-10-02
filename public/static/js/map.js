/**
 * Campus map, loaded only when the map view is first opened.
 *
 * Leaflet is ~150 KB and most sessions never leave the card view, so the
 * library is fetched on demand from a CDN with Subresource Integrity hashes.
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

const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CSS_SRI = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
const LEAFLET_JS_SRI = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';

let leafletPromise = null;
let map = null;
let markerLayer = null;
let originMarker = null;
let routeLine = null;
let routeGeneration = 0;
let pinMode = false;
let onPin = null;

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

function status(root, message) {
  const canvas = one('[data-role="map"]', root);
  if (!canvas) return;
  replace(canvas, el('p', { class: 'map-placeholder', dataset: { role: 'map-status' }, text: message }));
}

function mappable() {
  const events = state.view === 'schedule' && state.week?.days
    ? state.week.days.flatMap(day => day.events) : state.events;
  return events.filter((event) => event.place && !event.cancelled && (state.view !== 'itinerary' || isSaved(event.date,event.identity_key)));
}

function markerFor(L, event) {
  const saved = isSaved(event.date, event.identity_key);
  const icon = L.divIcon({
    className: 'vfr-pin-wrap',
    html: `<span class="vfr-pin${saved ? ' is-saved' : ''}${state.selectedKey === event.identity_key ? ' is-selected' : ''}"></span>`,
    iconSize: [11, 11],
    iconAnchor: [6, 6],
  });
  const marker = L.marker([event.place.lat, event.place.lng], {
    icon,
    keyboard: true,
    title: event.title,
    alt: event.title,
  });
  // Leaflet interprets string tooltip content as HTML, so use a text node.
  marker.bindTooltip(el('span', { text: `${event.title} \u00b7 ${event.time_label}` }));
  marker.on('add', () => marker.getElement()?.setAttribute('aria-label', `${event.title}, ${event.date}, ${event.time_label}`));
  if (state.selectedKey === event.identity_key) marker.setZIndexOffset(1000);
  return marker;
}

/** Render the list beside the map; it works even when the map cannot load. */
function renderList(root, onSelect) {
  const list = one('[data-role="map-list"]', root);
  if (!list) return;
  const events = mappable();
  const selected = events.find(event=>event.identity_key===state.selectedKey);
  const selection = one('[data-role="map-selection"]', root);
  if (selection) {
    selection.textContent = selected
      ? `${selected.title} — ${selected.date}, ${selected.time_label}. ${selected.place.name}${selected.place.detail ? ', '+selected.place.detail : ''}`
      : 'Select an event to find its location. Saved events have gold markers.';
  }
  if (!events.length) {
    replace(
      list,
      el('li', {}, [
        el('span', {
          class: 'map-list-sub',
          text: 'No listing for this date resolved to a campus building.',
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
        dataset: { identityKey: event.identity_key },
      }, [
        el('span', { text: event.title }),
        el('span', { class: 'map-list-sub', text: `${event.time_label} \u00b7 ${event.place.name}` }),
      ]);
      button.addEventListener('click', () => onSelect(event.identity_key));
      return el('li', {}, button);
    }),
  );
}

/** Open the map view, loading Leaflet on first use. */
export async function showMap(root, { onSelect, onPinned }) {
  onPin = onPinned;
  renderList(root, onSelect);
  const canvas = one('[data-role="map"]', root);
  if (!canvas) return;

  if (map) {
    map.invalidateSize();
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
    map.invalidateSize();
    syncMarkers(root, onSelect);
    return;
  }

  replace(canvas, []);
  const reference = state.origin || state.config.reference;
  map = L.map(canvas, { zoomControl: true, attributionControl: true }).setView(
    [reference.lat, reference.lng],
    16,
  );
  L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
  map.on('click', (clickEvent) => {
    if (!pinMode || !onPin) return;
    pinMode = false;
    onPin({ lat: clickEvent.latlng.lat, lng: clickEvent.latlng.lng });
  });
  syncMarkers(root, onSelect);
}

/** Redraw markers for the loaded day and the current origin. */
export function syncMarkers(root, onSelect) {
  renderList(root, onSelect);
  if (!map || !window.L || !markerLayer) return;
  const L = window.L;
  markerLayer.clearLayers();

  const events = mappable();
  for (const event of events) {
    const marker = markerFor(L, event);
    marker.on('click', () => onSelect(event.identity_key));
    marker.addTo(markerLayer);
  }

  if (originMarker) {
    originMarker.remove();
    originMarker = null;
  }
  const origin = state.origin;
  if (origin) {
    originMarker = L.marker([origin.lat, origin.lng], {
      icon: L.divIcon({
        className: 'vfr-pin-wrap',
        html: '<span class="vfr-pin is-origin"></span>',
        iconSize: [11, 11],
        iconAnchor: [6, 6],
      }),
      title: origin.label,
      alt: origin.label,
    });
    originMarker.bindTooltip(el('span', { text: origin.label }));
    originMarker.addTo(map);
  }

  // A mobile agenda hides the canvas. Fitting a zero-sized map would choose
  // a world-level zoom; fit only once the map panel has a measurable size.
  const canvas = map.getContainer();
  if (events.length && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
    const bounds = L.latLngBounds(events.map((event) => [event.place.lat, event.place.lng]));
    if (origin) bounds.extend([origin.lat, origin.lng]);
    map.fitBounds(bounds.pad(0.25), { animate: false, maxZoom: 17 });
    if (state.selectedKey) panTo(state.selectedKey);
  }
}

/** Pan to a selected event, if it has a resolved building. */
export function panTo(identityKey) {
  if (!map) return;
  const event = mappable().find((item) => item.identity_key === identityKey);
  if (!event || !event.place) return;
  map.panTo([event.place.lat, event.place.lng], { animate: !prefersReducedMotion() });
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function clearRoute() {
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

/** Arm map-click origin selection; the next map click reports a coordinate. */
export function armPinMode() {
  pinMode = true;
  return Boolean(map);
}

/** Whether the map instance exists (i.e. Leaflet loaded successfully). */
export function mapReady() {
  return Boolean(map);
}
