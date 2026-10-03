/**
 * Shared application state.
 *
 * A single observable record keeps the cards, schedule, map, and itinerary in
 * agreement: selecting an event in the agenda is the same state change as
 * clicking its marker, so neither view needs to know about the other.
 *
 * The selected date is the one invariant worth stating plainly: `events`
 * always holds the feed for `selectedDate` and nothing else, so no view can
 * accidentally render a mixture of days.
 */

import { loadItinerary, loadOrigin, loadSaved, saveItinerary, saveOrigin, saveSaved } from './storage.js';

const listeners = new Set();

export const state = {
  config: null,
  selectedDate: null,
  view: 'cards',
  events: [],
  brief: null,
  week: null,
  weekStart: null,
  selectedKey: null,
  saved: [],
  origin: null,
  destination: null,
  itinerary: { date: null, keys: [], dwell: null, departAt: null },
  places: null,
  storageWarning: null,
  error: null,
};

/** Subscribe to state changes; returns an unsubscribe function. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Notify subscribers of a change, tagged with what changed. */
export function emit(reason) {
  for (const listener of listeners) {
    listener(state, reason);
  }
}

/** Initialise state from the server config and validated local storage. */
export function initState(config) {
  state.config = config;
  state.selectedDate = config.selected_date || config.today;
  state.weekStart = weekStartFor(state.selectedDate);
  state.saved = loadSaved();
  state.origin =
    loadOrigin() || {
      label: config.reference.label,
      lat: config.reference.lat,
      lng: config.reference.lng,
      kind: 'default',
    };
  const stored = loadItinerary();
  state.itinerary = stored || {
    date: state.selectedDate,
    keys: [],
    dwell: config.dwell_minutes,
    departAt: null,
  };
  if (state.itinerary.dwell === null || state.itinerary.dwell === undefined) {
    state.itinerary.dwell = config.dwell_minutes;
  }
}

/** Monday-anchored week start for an ISO date. */
export function weekStartFor(isoDate) {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  const weekday = (date.getDay() + 6) % 7; // 0 = Monday
  date.setDate(date.getDate() - weekday);
  return toIso(date);
}

/** Format a `Date` as `YYYY-MM-DD` in local calendar terms. */
export function toIso(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Shift an ISO date by whole days. */
export function shiftIso(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  date.setDate(date.getDate() + days);
  return toIso(date);
}

/** Whether an event is saved on a given date. */
export function isSaved(date, identityKey) {
  return state.saved.some(
    (entry) => entry.date === date && entry.identity_key === identityKey,
  );
}

/** Toggle an event's saved status and persist the result. */
export function toggleSaved(date, identityKey) {
  const existing = state.saved.findIndex(
    (entry) => entry.date === date && entry.identity_key === identityKey,
  );
  if (existing >= 0) {
    state.saved.splice(existing, 1);
  } else {
    state.saved.push({ date, identity_key: identityKey });
  }
  if (!saveSaved(state.saved)) {
    state.storageWarning = 'Saved items are kept for this session only; storage is blocked.';
  }
  emit('saved');
  return existing < 0;
}

/** Remove every saved reference. */
export function clearSaved() {
  state.saved = [];
  saveSaved(state.saved);
  emit('saved');
}

/** Replace the walking origin and persist it. */
export function setOrigin(origin) {
  state.origin = origin;
  if (!saveOrigin(origin)) {
    state.storageWarning = 'Origin is kept for this session only; storage is blocked.';
  }
  emit('origin');
}

/** Replace the itinerary and persist it. */
export function setItinerary(itinerary) {
  state.itinerary = itinerary;
  if (!saveItinerary(itinerary)) {
    state.storageWarning = 'Itinerary is kept for this session only; storage is blocked.';
  }
  emit('itinerary');
}

/** Find the loaded event for an identity key on the selected date. */
export function findEvent(identityKey) {
  return state.events.find((event) => event.identity_key === identityKey) || null;
}
