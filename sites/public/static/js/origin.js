import { displayText } from './preferences.js';
/**
 * Walking Origin selection.
 *
 * Three ways to set where you are walking from, in order of how often they
 * are useful:
 *
 * 1. A combobox over the curated campus dataset. Filtering happens entirely
 *    in the browser against the already-downloaded JSON file — no keystroke
 *    hits a third-party geocoder, which keeps the feature off anyone's public
 *    autocomplete quota and keeps typing private.
 * 2. A map click, for a spot the dataset does not name.
 * 3. The browser's own geolocation, which is explicitly user-granted.
 *
 * Any coordinate that arrives from GPS or a map click is range-checked before
 * it is stored or sent anywhere.
 */

import { fetchPlaces } from './api.js';
import { all, el, one, replace } from './dom.js';
import { emit, setOrigin, state } from './state.js';
import { bindPlaceSearch } from './place-search.js';

const MAX_OPTIONS = 8;

let places = [];
let activeIndex = -1;

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function validPlace(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    typeof entry.name === 'string' &&
    entry.name.trim() &&
    Number.isFinite(entry.lat) &&
    Number.isFinite(entry.lng) &&
    entry.lat >= -90 &&
    entry.lat <= 90 &&
    entry.lng >= -180 &&
    entry.lng <= 180
  );
}

/** Load the campus dataset for the combobox; absence is not an error. */
export async function loadPlaces() {
  try {
    const payload = await fetchPlaces();
    places = Array.isArray(payload) ? payload.filter(validPlace) : [];
  } catch {
    places = [];
  }
  state.places = places;
  emit('places');
  return places;
}

function search(query) {
  const needle = normalize(query);
  if (!needle) return places.slice(0, MAX_OPTIONS);
  const starts = [];
  const contains = [];
  for (const place of places) {
    const haystacks = [place.name, ...(Array.isArray(place.aliases) ? place.aliases : [])];
    let matched = null;
    for (const candidate of haystacks) {
      const key = normalize(candidate);
      if (key.startsWith(needle)) {
        matched = 'start';
        break;
      }
      if (key.includes(needle)) matched = matched || 'contains';
    }
    if (matched === 'start') starts.push(place);
    else if (matched === 'contains') contains.push(place);
    if (starts.length >= MAX_OPTIONS) break;
  }
  return [...starts, ...contains].slice(0, MAX_OPTIONS);
}

function renderStatus(root) {
  const node = one('[data-role="origin-status"]', root);
  if (node && state.origin) {
    const suffix = state.origin.kind === 'default' ? ' (default)' : '';
    node.textContent = displayText(`Origin: ${state.origin.label}${suffix}`);
  }
  const label = one('[data-role="origin-label"]', root);
  if (label && state.origin) label.textContent = displayText(state.origin.label);
  const button = one('[data-action="edit-origin"]', root);
  if (button && state.origin) {
    button.title = `Change walking location: ${displayText(state.origin.label)}`;
    button.setAttribute('aria-label', button.title);
  }
}

function closeList(input, list) {
  list.setAttribute('hidden', '');
  input.setAttribute('aria-expanded', 'false');
  activeIndex = -1;
}

function openList(input, list, options, choose) {
  if (!options.length) {
    replace(list, el('li', { role: 'presentation', text: 'No matching campus place' }));
    list.removeAttribute('hidden');
    input.setAttribute('aria-expanded', 'true');
    return;
  }
  replace(
    list,
    options.map((place, index) => {
      const item = el('li', {
        role: 'option',
        id: `origin-option-${index}`,
        'aria-selected': String(index === activeIndex),
        text: place.name,
      });
      item.addEventListener('pointerdown', (domEvent) => {
        domEvent.preventDefault();
        choose(place);
      });
      return item;
    }),
  );
  list.removeAttribute('hidden');
  input.setAttribute('aria-expanded', 'true');
}

/** Wire the origin combobox, GPS button, pin button, and reset. */
export function bindOrigin(root, { onPinRequest, onChange }) {
  const container = one('[data-module="origin"]', root);
  if (!container) return;
  const input = one('#origin-input', container);
  const list = one('#origin-options', container);
  const status = one('[data-role="origin-status"]', container);
  if (!input || !list) return;

  const apply = (origin) => {
    setOrigin(origin);
    renderStatus(root);
    closeOriginPicker(root);
    if (onChange) onChange(origin);
  };

  const choose = (place) => {
    input.value = '';
    closeList(input, list);
    apply({ label: place.name, lat: place.lat, lng: place.lng, kind: 'place' });
  };

  input.addEventListener('input', () => {
    activeIndex = -1;
    openList(input, list, search(input.value), choose);
  });

  input.addEventListener('keydown', (domEvent) => {
    const options = search(input.value);
    if (domEvent.key === 'ArrowDown' || domEvent.key === 'ArrowUp') {
      domEvent.preventDefault();
      if (!options.length) return;
      const delta = domEvent.key === 'ArrowDown' ? 1 : -1;
      activeIndex = (activeIndex + delta + options.length) % options.length;
      openList(input, list, options, choose);
      input.setAttribute('aria-activedescendant', `origin-option-${activeIndex}`);
      return;
    }
    if (domEvent.key === 'Enter') {
      // Submission is explicit: a highlighted option, or the single unambiguous
      // match. Typing alone never changes the origin.
      domEvent.preventDefault();
      const pick = activeIndex >= 0 ? options[activeIndex] : options.length === 1 ? options[0] : null;
      if (pick) choose(pick);
      else if (status) status.textContent = 'Pick a campus place from the list to set the origin.';
      return;
    }
    if (domEvent.key === 'Escape') {
      closeList(input, list);
    }
  });

  input.addEventListener('blur', () => {
    window.setTimeout(() => closeList(input, list), 120);
  });

  let requestGeneration = 0;
  const locationStatus = (message) => {
    for (const node of all('[data-role="origin-status"], [data-role="map-location-status"], [data-role="header-origin-status"]',root)) node.textContent = displayText(message);
  };
  for (const gpsButton of all('[data-action="origin-gps"]',root)) {
    gpsButton.addEventListener('click', () => {
      const generation = ++requestGeneration;
      const startingOrigin=state.origin;
      if (!navigator.geolocation) { locationStatus('This browser does not offer location access.'); return; }
      for (const button of all('[data-action="origin-gps"]',root)) button.disabled = true;
      locationStatus('Finding your location…');
      const finish = () => {
        if (generation !== requestGeneration) return;
        for (const button of all('[data-action="origin-gps"]',root)) button.disabled = false;
      };
      navigator.geolocation.getCurrentPosition(async (position) => {
        if(generation!==requestGeneration || state.origin!==startingOrigin){finish();return;}
        const point = {lat:position.coords.latitude,lng:position.coords.longitude};
        if (!validPoint(point)) {locationStatus('The browser returned an unusable location.');finish();return;}
        const fallback = coordinateLabel(point);
        apply({...point,label:fallback,kind:'gps'});
        locationStatus('Finding the nearby address…');
        const label = await labelForPoint(point);
        if (generation !== requestGeneration || state.origin.kind !== 'gps' || state.origin.lat !== point.lat || state.origin.lng !== point.lng) {finish();return;}
        apply({...point,label:label ? `Near ${label}` : fallback,kind:'gps'});
        locationStatus('');
        finish();
      }, error => {if(generation===requestGeneration)locationStatus(`Location unavailable: ${error.message}`);finish();}, {enableHighAccuracy:true,timeout:10000,maximumAge:60000});
    });
  }
  for (const pinButton of all('[data-action="origin-pin"]',root)) {
    pinButton.addEventListener('click',()=>{
      ++requestGeneration;
      for (const button of all('[data-action="origin-gps"]',root)) button.disabled=false;
      if(onPinRequest)onPinRequest('origin');
    });
  }

  for (const resetButton of all('[data-action="origin-reset"]', root)) {
    resetButton.addEventListener('click', () => {
      const reference = state.config.reference;
      apply({
        label: reference.label,
        lat: reference.lat,
        lng: reference.lng,
        kind: 'default',
      });
    });
  }

  renderStatus(root);
  bindOriginPicker(root, apply);
}

export function closeOriginPicker(root, returnFocus = true) {
  const picker = one('#header-origin-picker', root);
  if (!picker || picker.hidden) return;
  picker.hidden = true;
  const trigger = one('[data-action="edit-origin"]', root);
  trigger?.setAttribute('aria-expanded', 'false');
  if (returnFocus) trigger?.focus({preventScroll:true});
}

function bindOriginPicker(root, apply) {
  const trigger = one('[data-action="edit-origin"]', root);
  const picker = one('#header-origin-picker', root);
  const input = one('#header-origin-input', root);
  if (!trigger || !picker || !input) return;
  bindPlaceSearch(input, one('#header-origin-options', root), {
    places: () => state.places,
    currentLabel: () => state.origin?.label || '',
    choose: place => {
      apply({label:place.name, lat:place.lat, lng:place.lng, kind:'place'});
      closeOriginPicker(root);
    },
  });
  trigger.addEventListener('click', () => {
    if (!picker.hidden) {closeOriginPicker(root); return;}
    picker.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    input.value = state.origin?.label || '';
    input.focus({preventScroll:true});
    input.select();
  });
  one('[data-action="close-origin"]', root).addEventListener('click', () => closeOriginPicker(root));
  root.addEventListener('pointerdown', event => {
    if (!picker.hidden && !event.target.closest('.origin-picker')) closeOriginPicker(root, false);
  });
  picker.addEventListener('keydown', event => {
    if (event.key === 'Escape' && input.getAttribute('aria-expanded') !== 'true') {
      event.preventDefault(); event.stopPropagation(); closeOriginPicker(root);
    }
  }, true);
  picker.addEventListener('focusout', () => {
    requestAnimationFrame(() => {
      if (!picker.hidden && !one('.origin-picker', root).contains(document.activeElement)) closeOriginPicker(root, false);
    });
  });
}

function validPoint(point) {
  return Number.isFinite(point?.lat) && Math.abs(point.lat) <= 90 && Number.isFinite(point?.lng) && Math.abs(point.lng) <= 180;
}
export function coordinateLabel(point) {
  return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
}
const labels = new Map();
export async function labelForPoint(point) {
  if (!validPoint(point)) return null;
  const key = `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
  if (!labels.has(key)) {
    const request=fetch('/api/location',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({lat:point.lat,lng:point.lng}),signal:AbortSignal.timeout(8000)})
      .then(response=>response.ok ? response.json() : null).then(value=>typeof value?.label==='string' ? value.label : null).catch(()=>null).then(label=>{if(!label)labels.delete(key);return label;});
    labels.set(key,request);
    if(labels.size>32)labels.delete(labels.keys().next().value);
  }
  return labels.get(key);
}

/** Accept a named building or a map point, retaining the exact selected coordinates. */
export async function originFromPin(root, point, onChange) {
  if (!validPoint(point)) return;
  const origin={lat:point.lat,lng:point.lng,label:point.label || coordinateLabel(point),kind:'pin'};
  setOrigin(origin);renderStatus(root);if(onChange)onChange(state.origin);
  if(point.label)return;
  const label=await labelForPoint(point);
  if(!label || state.origin.kind!=='pin' || state.origin.lat!==point.lat || state.origin.lng!==point.lng)return;
  setOrigin({...origin,label:`Near ${label}`});renderStatus(root);if(onChange)onChange(state.origin);
}

/** Re-render the origin status text. */
export function refreshOriginStatus(root) {
  renderStatus(root);
}
