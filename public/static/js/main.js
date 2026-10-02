/**
 * Entry point: wires the views together and owns navigation.
 *
 * The server already rendered the card view for the selected date, so startup
 * only attaches behavior. Changing the date fetches one day and re-renders;
 * switching views never refetches what is already loaded. Selection is shared,
 * so highlighting an event in the agenda, the map list, or a card is one state
 * change that every view observes.
 */

import { fetchDay, fetchWeek } from './api.js';
import { renderAgenda } from './agenda.js';
import { bindCardEvents, renderCards, syncCardChrome } from './cards.js';
import { all, one } from './dom.js';
import { optimizeItinerary, renderItinerary } from './itinerary.js';
import { armPinMode, clearRoute, panTo, showMap, syncMarkers } from './map.js';
import { refreshWalking } from './walking.js';
import { bindOrigin, loadPlaces, originFromPin, refreshOriginStatus } from './origin.js';
import {
  emit,
  initState,
  setItinerary,
  shiftIso,
  state,
  subscribe,
  toggleSaved,
  weekStartFor,
  clearSaved,
} from './state.js';

const VIEWS = new Set(['cards', 'schedule', 'map', 'itinerary']);
const root = document;
let dayRequest = 0;
let weekRequest = 0;
const usesMap = () => ['map', 'schedule', 'itinerary'].includes(state.view);

function readConfig() {
  const node = document.getElementById('vfr-config');
  if (!node) return null;
  try {
    return JSON.parse(node.textContent);
  } catch {
    return null;
  }
}

function hydrateFromDom() {
  // The first paint is server-rendered; adopt its cards so a visitor who never
  // changes the date pays for no extra request.
  const cards = all('.card', root);
  state.events = [];
  return cards.length;
}

function setScope() {
  const label = one('[data-role="origin-label"]', root);
  if (label && state.origin) label.textContent = state.origin.label;
}

async function loadDay(isoDate, { pushHistory = true } = {}) {
  const generation = ++dayRequest;
  state.selectedDate = isoDate;
  const input = one('#date-input', root);
  if (input && input.value !== isoDate) input.value = isoDate;
  if (pushHistory) {
    const url = new URL(window.location.href);
    url.searchParams.set('date', isoDate);
    window.history.replaceState({}, '', url);
  }

  const grid = one('[data-role="card-grid"]', root);
  if (grid) grid.setAttribute('aria-busy', 'true');
  try {
    const payload = await fetchDay(isoDate);
    if (generation !== dayRequest) return;
    state.events = payload.events || [];
    state.brief = payload.brief || null;
    state.error = null;
  } catch (error) {
    if (generation !== dayRequest) return;
    state.events = [];
    state.brief = null;
    state.error = error.message;
  } finally {
    if (grid && generation === dayRequest) grid.removeAttribute('aria-busy');
  }

  state.selectedKey = null;
  renderBrief();
  renderScope();
  renderCards(root);
  refreshWalking(root);
  if (usesMap()) syncMarkers(root, selectFromMap);
  if (state.view === 'itinerary') renderItinerary(root);

  const newWeek = weekStartFor(isoDate);
  if (newWeek !== state.weekStart) {
    state.weekStart = newWeek;
    state.week = null;
    if (state.view === 'schedule') loadWeek();
  }
}

function renderBrief() {
  const node = one('[data-role="brief-text"]', root);
  if (!node) return;
  if (state.error) {
    node.textContent = `The feed could not be loaded: ${state.error}`;
    return;
  }
  if (state.brief) node.textContent = state.brief.text;
}

function renderScope() {
  const node = one('[data-role="scope"]', root);
  if (!node || !state.config) return;
  const date = new Date(`${state.selectedDate}T00:00:00`);
  const label = Number.isNaN(date.getTime())
    ? state.selectedDate
    : new Intl.DateTimeFormat(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      }).format(date);
  const today = state.selectedDate === state.config.today ? ' \u00b7 today' : '';
  const originLabel = state.origin ? state.origin.label : state.config.reference.label;
  node.textContent = `${label}${today} \u00b7 walking from ${originLabel}`;
}

async function loadWeek() {
  const generation = ++weekRequest;
  state.week = null;
  renderAgenda(root, { onSelect: selectFromAgenda });
  try {
    const payload = await fetchWeek(state.weekStart);
    if (generation !== weekRequest) return;
    state.week = payload;
  } catch (error) {
    if (generation !== weekRequest) return;
    state.week = { days: [], error: error.message };
  }
  renderAgenda(root, { onSelect: selectFromAgenda });
  if (usesMap()) syncMarkers(root, selectFromMap);
}

function selectFromMap(identityKey) {
  const event = state.week?.days?.flatMap(day => day.events).find(item => item.identity_key === identityKey)
    || state.events.find(item => item.identity_key === identityKey);
  if (event) selectFromAgenda(event.date, identityKey);
}

function selectEvent(identityKey) {
  state.selectedKey = state.selectedKey === identityKey ? null : identityKey;
  syncCardChrome(root);
  renderAgenda(root, { onSelect: selectFromAgenda });
  if (usesMap()) {
    syncMarkers(root, selectFromMap);
    if (state.selectedKey) panTo(state.selectedKey);
  }
}

async function selectFromAgenda(date, identityKey) {
  if (date !== state.selectedDate) {
    await loadDay(date);
  }
  selectEvent(identityKey);
}

function setView(view) {
  if (!VIEWS.has(view)) return;
  state.view = view;
  if (view !== 'itinerary') clearRoute();
  const split = one('[data-role="map-split"]', root);
  const host = one(view === 'schedule' ? '[data-role="schedule-map-host"]' : view === 'itinerary' ? '[data-role="plan-map-host"]' : '[data-role="map-home"]', root);
  if (split && host && split.parentNode !== host) host.append(split);
  const brief = one('[data-role="brief"]', root);
  if (brief) brief.hidden = view !== 'cards';
  for (const panel of all('[data-view-panel]', root)) {
    const active = panel.dataset.viewPanel === view;
    panel.classList.toggle('is-active', active);
    if (active) panel.removeAttribute('hidden');
    else panel.setAttribute('hidden', '');
  }
  for (const button of all('[data-view]', root)) {
    const current = button.dataset.view === view;
    button.classList.toggle('is-current', current);
    if (button.classList.contains('nav-item')) {
      if (current) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  }
  if (view === 'schedule' && !state.week) loadWeek();
  if (usesMap()) showMap(root, { onSelect: selectFromMap, onPinned: handlePin }).then(() => {
    if (state.view === 'itinerary') renderItinerary(root);
  });
}

function handlePin(point) {
  originFromPin(root, point, () => {
    renderScope();
    refreshWalking(root);
    if (usesMap()) syncMarkers(root, selectFromMap);
  });
}

function bindNavigation() {
  for (const button of all('[data-schedule-mode]', root)) {
    button.addEventListener('click', () => {
      setScheduleMode(button.dataset.scheduleMode);
      if (usesMap()) showMap(root, { onSelect: selectFromMap, onPinned: handlePin });
    });
  }
  for (const button of all('[data-action="toggle-sidebar"]', root)) {
    button.addEventListener('click', () => {
      const open = one('.sidebar', root).classList.toggle('is-open');
      one('.mobile-settings', root)?.setAttribute('aria-expanded', String(open));
      if (open) one('#origin-input', root)?.focus();
      else one('.mobile-settings', root)?.focus();
    });
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      one('.sidebar', root).classList.remove('is-open');
      one('.mobile-settings', root)?.setAttribute('aria-expanded', 'false');
    }
  });
  for (const button of all('[data-view]', root)) {
    button.addEventListener('click', () => setView(button.dataset.view));
  }

  const input = one('#date-input', root);
  if (input) {
    input.addEventListener('change', () => {
      if (input.value) loadDay(input.value);
    });
  }
  const prev = one('[data-action="prev-day"]', root);
  if (prev) prev.addEventListener('click', () => loadDay(shiftIso(state.selectedDate, -1)));
  const next = one('[data-action="next-day"]', root);
  if (next) next.addEventListener('click', () => loadDay(shiftIso(state.selectedDate, 1)));
  const today = one('[data-action="today"]', root);
  if (today) today.addEventListener('click', () => loadDay(state.config.today));

  const clear = one('[data-action="clear-saved"]', root);
  if (clear) clear.addEventListener('click', () => clearSaved());

  const dwell = one('[data-role="dwell"]', root);
  if (dwell) {
    dwell.value = String(state.itinerary.dwell ?? state.config.dwell_minutes);
    dwell.addEventListener('change', () => {
      const value = Number(dwell.value);
      if (!Number.isFinite(value) || value < 0 || value > 240) {
        dwell.value = String(state.itinerary.dwell ?? state.config.dwell_minutes);
        return;
      }
      setItinerary({ ...state.itinerary, dwell: value });
      if (state.view === 'itinerary') renderItinerary(root);
    });
  }

  const depart = one('[data-role="depart-at"]', root);
  if (depart) {
    if (state.itinerary.departAt) depart.value = state.itinerary.departAt;
    else state.itinerary.departAt = depart.value;
    depart.addEventListener('change', () => {
      setItinerary({ ...state.itinerary, departAt: depart.value });
      if (state.view === 'itinerary') renderItinerary(root);
    });
  }

  const optimize = one('[data-action="optimize"]', root);
  if (optimize) optimize.addEventListener('click', () => optimizeItinerary(root));
}

function setScheduleMode(mode) {
  one('.schedule-layout', root).dataset.scheduleDisplay = mode;
  for (const button of all('[data-schedule-mode]', root)) {
    const active = button.dataset.scheduleMode === mode;
    button.classList.toggle('is-current', active);
    button.setAttribute('aria-pressed', String(active));
  }
}

function renderSavedCount() {
  const node = one('[data-role="saved-count"]', root);
  if (!node) return;
  const total = state.saved.length;
  const onDay = state.saved.filter((entry) => entry.date === state.selectedDate).length;
  if (!total) {
    node.textContent = state.storageWarning || 'None saved';
    return;
  }
  const suffix = state.storageWarning ? ` ${state.storageWarning}` : '';
  node.textContent = `${total} saved \u00b7 ${onDay} on this date.${suffix}`;
}

function start() {
  const config = readConfig();
  if (!config) return;
  initState(config);
  hydrateFromDom();
  bindNavigation();
  bindCardEvents(root, { onSelect: selectEvent });
  bindOrigin(root, {
    onPinRequest: () => {
      setView('schedule');
      setScheduleMode('map');
      one('.sidebar', root).classList.remove('is-open');
      one('.mobile-settings', root)?.setAttribute('aria-expanded', 'false');
      showMap(root, {onSelect: selectFromMap, onPinned: handlePin}).then(() => armPinMode());
      return true;
    },
    onChange: () => {
      renderScope();
      refreshWalking(root);
      if (usesMap()) syncMarkers(root, selectFromMap);
      if (state.view === 'itinerary') renderItinerary(root);
    },
  });
  refreshOriginStatus(root);
  setScope();
  renderScope();
  renderSavedCount();

  subscribe((_, reason) => {
    if (reason === 'saved') {
      renderSavedCount();
      syncCardChrome(root);
      renderAgenda(root, { onSelect: selectFromAgenda });
      if (usesMap()) syncMarkers(root, selectFromMap);
      if (state.view === 'itinerary') renderItinerary(root);
    }
  });

  loadPlaces();
  // Load the selected day's JSON so client-side views have structured data to
  // work with, replacing the server-rendered cards with identical markup.
  loadDay(state.selectedDate, { pushHistory: false });
  emit('ready');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
