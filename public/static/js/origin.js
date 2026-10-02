/**
 * Walking origin selection.
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
import { el, one, replace } from './dom.js';
import { setOrigin, state } from './state.js';

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
    node.textContent = `Origin: ${state.origin.label}${suffix}`;
  }
  const label = one('[data-role="origin-label"]', root);
  if (label && state.origin) label.textContent = state.origin.label;
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

  const gpsButton = one('[data-action="origin-gps"]', container);
  if (gpsButton) {
    gpsButton.addEventListener('click', () => {
      if (!navigator.geolocation) {
        if (status) status.textContent = 'This browser does not offer location access.';
        return;
      }
      if (status) status.textContent = 'Requesting your location\u2026';
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            if (status) status.textContent = 'Your browser returned an unusable location.';
            return;
          }
          apply({
            label: 'My location',
            lat: latitude,
            lng: longitude,
            kind: 'gps',
          });
        },
        (error) => {
          if (status) status.textContent = `Location unavailable: ${error.message}`;
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
      );
    });
  }

  const pinButton = one('[data-action="origin-pin"]', container);
  if (pinButton && onPinRequest) {
    pinButton.addEventListener('click', () => {
      const armed = onPinRequest();
      if (status) {
        status.textContent = armed
          ? 'Click the map to place your origin.'
          : 'Open the Map view first, then pick a point.';
      }
    });
  }

  const resetButton = one('[data-action="origin-reset"]', container);
  if (resetButton) {
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
}

/** Accept a coordinate picked on the map as the new origin. */
export function originFromPin(root, point, onChange) {
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
  if (point.lat < -90 || point.lat > 90 || point.lng < -180 || point.lng > 180) return;
  const label = `Pinned point (${point.lat.toFixed(4)}, ${point.lng.toFixed(4)})`;
  setOrigin({ label, lat: point.lat, lng: point.lng, kind: 'pin' });
  renderStatus(root);
  if (onChange) onChange(state.origin);
}

/** Re-render the origin status text. */
export function refreshOriginStatus(root) {
  renderStatus(root);
}
