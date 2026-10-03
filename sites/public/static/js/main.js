/**
 * Entry point: wires the views together and owns navigation.
 *
 * The server already rendered the card view for the selected date, so startup
 * only attaches behavior. Changing the date fetches one day and re-renders;
 * switching views never refetches what is already loaded. The map and cards
 * share selection; the agenda opens event sources and walking directions.
 */

import { bindPreferences, displayText, formatTimesInText } from './preferences.js';
import { fetchDay, fetchWeek } from './api.js';
import { bindAgendaMenus, renderAgenda, setAgendaSelectHandler } from './agenda.js';
import { bindCardEvents, renderCards, syncCardChrome } from './cards.js';
import { all, one } from './dom.js';
import { slideViews } from './view-motion.js';
import { armPinMode, cancelPinMode, clearRoute, openTooltip, panTo, prepareMap, showMap, syncMarkers } from './map.js';
import { bindDirections, destinationFor, setDestination } from './directions.js';
import { refreshWalking } from './walking.js';
import { bindOrigin, coordinateLabel, labelForPoint, loadPlaces, originFromPin, refreshOriginStatus } from './origin.js';
import {
  emit,
  initState,
  shiftIso,
  state,
  subscribe,
  weekStartFor,
  clearSaved,
} from './state.js';

const VIEWS = new Set(['cards', 'schedule', 'map']);
const root = document;
let dayRequest = 0;
let weekRequest = 0;
let agendaSelectionRequest = 0;
const usesMap = () => ['map', 'schedule'].includes(state.view);

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
  if (label && state.origin) label.textContent = displayText(state.origin.label);
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
  emit('day');
  renderSavedCount();
  renderBrief();
  renderScope();
  renderCards(root);
  refreshWalking(root);
  if (usesMap()) syncMarkers(root, selectFromMap);

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
  if (state.brief) node.textContent = formatTimesInText(displayText(state.brief.text));
}

function renderScope() {
  if (!state.config) return;
  setScope();
  const today = one('[data-action="today"]', root);
  if (today) {
    today.setAttribute('aria-label', 'Go to today');
    if (state.selectedDate === state.config.today) today.setAttribute('aria-current', 'date');
    else today.removeAttribute('aria-current');
  }
  const label = one('[data-role="selected-date-label"]', root);
  if (label) {
    const date = new Date(`${state.selectedDate}T12:00:00Z`);
    label.textContent = new Intl.DateTimeFormat('en-US', {timeZone:'UTC', weekday:'long', month:'long', day:'numeric'}).format(date);
  }
}

async function loadWeek() {
  const generation = ++weekRequest;
  state.week = null;
  renderAgenda(root);
  try {
    const payload = await fetchWeek(state.weekStart);
    if (generation !== weekRequest) return;
    state.week = payload;
  } catch (error) {
    if (generation !== weekRequest) return;
    state.week = { days: [], error: error.message };
  }
  emit('week');
  renderAgenda(root);
  if (usesMap()) syncMarkers(root, selectFromMap);
}

function selectFromMap(identityKey) {
  const event = state.week?.days?.flatMap(day => day.events).find(item => item.identity_key === identityKey)
    || state.events.find(item => item.identity_key === identityKey);
  if (event) {setDestination(destinationFor(event));selectFromAgenda(event.date, identityKey);}
}

function selectEvent(identityKey) {
  state.selectedKey = state.selectedKey === identityKey ? null : identityKey;
  syncCardChrome(root);
  renderAgenda(root);
  if (usesMap()) {
    syncMarkers(root, selectFromMap);
    if (state.selectedKey) {
      panTo(state.selectedKey);
      // Open the tooltip so the location name is visible
      openTooltip(state.selectedKey);
    }
  }
}

/**
 * Handle agenda row selection. The week data already contains the event, so
 * we use it directly without a day load when the event's date differs from
 * the card view date — this avoids async races between day loads and
 * selection. The mobile Map view needs the selected day's event data.
 */
async function selectFromAgenda(date, identityKey) {
  const generation = ++agendaSelectionRequest;
  if (identityKey === null) {
    // Deselect
    state.selectedKey = null;
    syncCardChrome(root);
    renderAgenda(root);
    if (usesMap()) syncMarkers(root, selectFromMap);
    return;
  }

  // On narrow screens the schedule map host is hidden. Selecting an event
  // should switch to the Map view so the user can see the location.
  const isMobile = window.matchMedia('(max-width: 800px)').matches;
  if (isMobile && state.view === 'schedule') {
    const event = state.week?.days?.flatMap(day => day.events).find(item => item.identity_key === identityKey);
    if (!event?.place || event.cancelled) {
      state.selectedKey = identityKey;
      renderAgenda(root);
      return;
    }
    if (date !== state.selectedDate) await loadDay(date);
    if (generation !== agendaSelectionRequest || state.view !== 'schedule') return;
    setDestination(destinationFor(event));
    state.selectedKey = identityKey;
    setView('map');
    await showMap(root, {onSelect:selectFromMap, onPinned:handlePin});
    if (generation !== agendaSelectionRequest || state.view !== 'map') return;
    panTo(identityKey);
    openTooltip(identityKey);
    one('[data-view="map"]', root)?.focus({preventScroll:true});
    renderAgenda(root);
    return;
  }

  // Select within the week view — use week data directly
  state.selectedKey = identityKey;
  syncCardChrome(root);
  renderAgenda(root);
  if (usesMap()) {
    syncMarkers(root, selectFromMap);
    if (state.selectedKey) {
      panTo(state.selectedKey);
      openTooltip(state.selectedKey);
    }
  }
}

function setView(view) {
  if (!VIEWS.has(view) || view === state.view) return;
  const previousView = state.view;
  const previousPanel = one(`[data-view-panel="${previousView}"]`, root);
  const viewport = one('.event-content', root);
  const animate = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  cancelPinMode();
  state.view = view;
  clearRoute();
  const split = one('[data-role="map-split"]', root);
  const host = one(view === 'schedule' ? '[data-role="schedule-map-host"]' : '[data-role="map-home"]', root);
  // Keep the outgoing map visible while its live canvas moves to the next view.
  let snapshot = null;
  if (split && host && split.parentNode !== host) {
    host.querySelector('.map-transition-snapshot')?.remove();
    if (animate && split.closest('[data-view-panel]') === previousPanel) {
      snapshot = split.cloneNode(true);
      snapshot.classList.add('map-transition-snapshot');
      snapshot.setAttribute('aria-hidden', 'true');
      snapshot.inert = true;
      for (const node of [snapshot, ...snapshot.querySelectorAll('*')]) {
        node.removeAttribute('id');
        node.removeAttribute('data-role');
      }
      split.parentNode.append(snapshot);
    }
    host.append(split);
  }
  for (const panel of all('[data-view-panel]', root)) {
    const active = panel.dataset.viewPanel === view;
    panel.classList.toggle('is-active', active);
    if (active) panel.removeAttribute('hidden');
    else panel.setAttribute('hidden', '');
  }
  for (const button of all('[data-view]', root)) {
    const current = button.dataset.view === view;
    button.classList.toggle('is-current', current);
    button.setAttribute('aria-pressed', String(current));
  }
  if (view === 'schedule' && !state.week) loadWeek();
  // Resize the persistent map before motion begins; keep its camera unchanged.
  if (usesMap()) showMap(root, {onSelect:selectFromMap, onPinned:handlePin});
  slideViews(viewport, all('[data-view-panel]', root), view, previousView, () => snapshot?.remove());
}

function originChanged() {
  refreshOriginStatus(root);
  renderScope();
  refreshWalking(root);
  renderAgenda(root);
  if (usesMap()) syncMarkers(root, selectFromMap);
}
async function handlePin(point, mode) {
  if (mode !== 'destination') {originFromPin(root, point, originChanged);return;}
  const destination={...point,label:point.label || coordinateLabel(point)};
  setDestination(destination);
  syncMarkers(root, selectFromMap);
  if (point.label) return;
  const label=await labelForPoint(point);
  if (state.destination !== destination || !label) return;
  setDestination({...destination,label:`Near ${label}`});
  syncMarkers(root, selectFromMap);
}
function beginPicking(mode='origin') {
  setView('map');
  one('.sidebar',root).close();
  showMap(root,{onSelect:selectFromMap,onPinned:handlePin}).then(()=>{
    if (!armPinMode(mode)) one('[data-role="map-location-status"]',root).textContent='The map is unavailable. Search for a campus building in From or To.';
  });
  return true;
}

function bindNavigation() {
  one('[data-action="cancel-pin"]',root).addEventListener('click',cancelPinMode);
  const settings = one('.sidebar', root);
  for (const button of all('[data-action="toggle-sidebar"]', root)) {
    button.addEventListener('click', () => {
      if (settings.open) settings.close();
      else settings.showModal();
    });
  }
  one('[data-action="edit-origin"]', root).addEventListener('click', () => {
    settings.showModal();
    one('#origin-input', root).focus();
  });
  settings.addEventListener('click', event => {
    if (event.target !== settings) return;
    const box = settings.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) settings.close();
  });
  for (const button of all('[data-view]', root)) {
    button.addEventListener('click', () => setView(button.dataset.view));
  }

  const input = one('#date-input', root);
  if (input) {
    input.addEventListener('click', () => {
      try { input.showPicker?.(); } catch { /* The native input remains usable. */ }
    });
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
  node.textContent = `${total} saved. ${onDay} on this date.${suffix}`;
}

function start() {
  const config = readConfig();
  if (!config) return;
  initState(config);
  hydrateFromDom();
  bindPreferences(root, () => {
    renderBrief();
    renderCards(root);
    renderAgenda(root);
    refreshWalking(root);
    if (usesMap()) syncMarkers(root, selectFromMap);
  });
  bindNavigation();
  bindAgendaMenus(root);
  // Wire the agenda selection handler through the module API
  setAgendaSelectHandler(selectFromAgenda);
  bindCardEvents(root, { onSelect: selectEvent });
  bindOrigin(root, {
    onPinRequest: beginPicking,
    onChange: originChanged,
  });
  bindDirections(root,{onOriginChange:originChanged,onPinRequest:beginPicking,onDestinationChange:()=>{if(usesMap())syncMarkers(root,selectFromMap);}});
  refreshOriginStatus(root);
  setScope();
  renderScope();
  renderSavedCount();

  subscribe((_, reason) => {
    if(reason==='places' && usesMap()) syncMarkers(root,selectFromMap);
    if (reason === 'saved') {
      renderSavedCount();
      syncCardChrome(root);
      renderAgenda(root);
      if (usesMap()) syncMarkers(root, selectFromMap);
    }
  });

  loadPlaces();
  // Warm the small map library after the initial page becomes interactive.
  if ('requestIdleCallback' in window) window.requestIdleCallback(prepareMap, {timeout:2500});
  else window.setTimeout(prepareMap, 1200);
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
