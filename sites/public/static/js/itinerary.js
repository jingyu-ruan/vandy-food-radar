/**
 * Itinerary planning for saved events on one date.
 *
 * The planner answers a scheduling question, not a routing one: given a
 * departure time, how long you want to stay at each stop, and the walking time
 * between stops, which saved events can you actually reach while they are
 * still running?
 *
 * Feasibility uses each event's own start/end window. Arriving before the
 * start means waiting; arriving after the end means the stop is marked
 * infeasible and is reported rather than silently dropped. Events without a
 * resolved building are excluded, because a walking leg to an unknown point
 * cannot be computed, and cancelled events are excluded outright.
 *
 * Ordering: with few enough stops the planner evaluates every permutation and
 * keeps the best feasible one. Above that threshold it uses a greedy
 * earliest-feasible heuristic. The heuristic result is labelled as a good
 * order, never as the optimal one, because it is not proven to be.
 */

import { walkingLeg } from './walking.js';
import { el, one, replace } from './dom.js';
import { setItinerary, state } from './state.js';
import { drawPlan } from './map.js';

const MINUTES_PER_DAY = 24 * 60;
let planGeneration = 0;

function parseClock(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatClock(minutes) {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hour24 = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  const hour = hour24 % 12 || 12;
  const suffix = hour24 < 12 ? 'AM' : 'PM';
  return `${hour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/** Saved, plannable events for the selected date. */
export function plannableEvents() {
  const saved = new Set(
    state.saved
      .filter((entry) => entry.date === state.selectedDate)
      .map((entry) => entry.identity_key),
  );
  return state.events.filter(
    (event) => saved.has(event.identity_key) && !event.cancelled && event.place,
  );
}

/** Saved events for the date that cannot be planned, with the reason why. */
export function excludedEvents() {
  const saved = new Set(
    state.saved
      .filter((entry) => entry.date === state.selectedDate)
      .map((entry) => entry.identity_key),
  );
  return state.events
    .filter((event) => saved.has(event.identity_key) && (event.cancelled || !event.place))
    .map((event) => ({
      event,
      reason: event.cancelled
        ? 'cancelled'
        : 'its listed location did not match a campus building',
    }));
}

function eventWindow(event) {
  const start = parseClock(event.start);
  let end = parseClock(event.end);
  if (start === null) return { start: null, end: null };
  if (end === null) end = start + 60;
  // A listed end at or before the start means the event runs past midnight.
  if (end <= start) end += MINUTES_PER_DAY;
  return { start, end };
}

/** Request walking minutes between two events (or the origin and an event). */
async function legMinutes(from, to, cache) {
  const key = `${from.lat.toFixed(5)},${from.lng.toFixed(5)}->${to.lat.toFixed(5)},${to.lng.toFixed(5)}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const result = await walkingLeg(from, to);
    const leg = { minutes: result.minutes, mode: result.mode, detail: result.detail };
    cache.set(key, leg);
    return leg;
  } catch (error) {
    const leg = { minutes: null, mode: 'unknown', detail: error.message };
    cache.set(key, leg);
    return leg;
  }
}

function pointOf(event) {
  return { lat: event.place.lat, lng: event.place.lng };
}

/** Build the full walking matrix once, so ordering never re-requests legs. */
async function buildMatrix(origin, events) {
  const cache = new Map();
  const matrix = new Map();
  const nodes = [{ id: '@origin', point: origin }, ...events.map((event) => ({ id: event.identity_key, point: pointOf(event) }))];
  for (const from of nodes) {
    for (const to of nodes) {
      if (from.id === to.id) continue;
      if (from.id !== '@origin' && to.id === '@origin') continue;
      // eslint-disable-next-line no-await-in-loop -- sequential keeps the
      // request count visible and respects the server-side route cache.
      const leg = await legMinutes(from.point, to.point, cache);
      matrix.set(`${from.id}|${to.id}`, leg);
    }
  }
  return matrix;
}

function legFor(matrix, fromId, toId) {
  return matrix.get(`${fromId}|${toId}`) || { minutes: null, mode: 'unknown', detail: '' };
}

/** Simulate one ordering and return its stops, legs, and feasibility count. */
export function simulate(order, { matrix, departAt, dwell }) {
  let clock = departAt;
  let previousId = '@origin';
  const stops = [];
  let feasible = 0;

  for (const event of order) {
    const leg = legFor(matrix, previousId, event.identity_key);
    const walkMinutes = leg.minutes;
    const window = eventWindow(event);
    const arrival = walkMinutes === null ? null : clock + walkMinutes;
    if (arrival !== null) clock = arrival;

    let note = '';
    let ok = false;
    if (arrival === null) {
      note = 'Walking time is unknown, so arrival cannot be checked.';
    } else if (window.start === null) {
      note = 'No start time is listed, so this stop cannot be scheduled.';
    } else if (arrival > window.end) {
      note = `Arrives ${formatClock(arrival)}, after the listed end ${formatClock(window.end)}.`;
    } else {
      const begin = Math.max(arrival, window.start);
      const stay = Math.min(dwell, Math.max(0, window.end - begin));
      ok = stay >= dwell;
      note =
        arrival < window.start
          ? `Arrive ${formatClock(arrival)}, wait until ${formatClock(window.start)}.`
          : `Arrive ${formatClock(arrival)}.`;
      if (stay < dwell) {
        note += ` Only ${stay} min before it ends.`;
      }
      clock = begin + stay;
      if (ok) feasible += 1;
      if (!event.end) note += ' End time is unlisted; a 60-minute window is assumed.';
    }

    stops.push({
      event,
      leg,
      arrival,
      feasible: ok,
      note,
      depart: ok ? clock : null,
    });
    previousId = event.identity_key;
  }

  return { stops, feasible, finish: clock };
}

function permutations(items) {
  if (items.length <= 1) return [items];
  const result = [];
  for (let index = 0; index < items.length; index += 1) {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) {
      result.push([items[index], ...tail]);
    }
  }
  return result;
}

/**
 * Choose an order. Returns the plan plus whether it was exhaustively searched.
 *
 * Exhaustive search is capped by `max_exact_stops` because permutations grow
 * factorially; above the cap a greedy earliest-feasible pass is used and the
 * caller is told the result is heuristic.
 */
export function planOrder(events, options) {
  const limit = (state.config && state.config.max_exact_stops) || 7;
  if (events.length <= 1) {
    return { plan: simulate(events, options), exhaustive: true };
  }
  if (events.length <= limit) {
    let best = null;
    for (const order of permutations(events)) {
      const plan = simulate(order, options);
      if (
        best === null ||
        plan.feasible > best.plan.feasible ||
        (plan.feasible === best.plan.feasible && plan.finish < best.plan.finish)
      ) {
        best = { plan, exhaustive: true };
      }
    }
    return best;
  }

  // Greedy: repeatedly take the stop that can be reached soonest and still
  // attended. Fast and usually good; not claimed to be optimal.
  const remaining = [...events];
  const order = [];
  while (remaining.length) {
    let bestIndex = 0;
    let bestPlan = null;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = [...order, remaining[index]];
      const plan = simulate(candidate, options);
      if (bestPlan === null || plan.feasible > bestPlan.feasible || (plan.feasible === bestPlan.feasible && plan.finish < bestPlan.finish)) {
        bestPlan = plan;
        bestIndex = index;
      }
    }
    order.push(remaining.splice(bestIndex, 1)[0]);
  }
  return { plan: simulate(order, options), exhaustive: false };
}

function renderPlan(root, plan, { exhaustive, dwell, onMove }) {
  drawPlan([state.origin,...plan.stops.map(stop=>pointOf(stop.event))]);
  const list = one('[data-role="itinerary"]', root);
  if (!list) return;
  const nodes = [];
  plan.stops.forEach((stop, index) => {
    if (stop.leg && stop.leg.minutes !== null) {
      const modeLabel = stop.leg.mode === 'routed' ? 'walking route' : 'straight-line estimate';
      nodes.push(
        el('li', {
          class: 'itinerary-leg',
          text: `${stop.leg.minutes} min walk (${modeLabel})`,
        }),
      );
    } else {
      nodes.push(
        el('li', { class: 'itinerary-leg', text: 'Walking time unavailable for this leg' }),
      );
    }

    const actions = el('div', { class: 'itinerary-actions' }, [
      el('button', {
        type: 'button',
        class: 'control-button',
        'data-action': 'move-up',
        'aria-label': `Move ${stop.event.title} earlier`,
        text: '\u2191',
        disabled: index === 0 ? true : null,
      }),
      el('button', {
        type: 'button',
        class: 'control-button',
        'data-action': 'move-down',
        'aria-label': `Move ${stop.event.title} later`,
        text: '\u2193',
        disabled: index === plan.stops.length - 1 ? true : null,
      }),
    ]);
    for (const button of actions.children) {
      button.addEventListener('click', () => {
        onMove(stop.event.identity_key, button.dataset.action === 'move-up' ? -1 : 1);
      });
    }

    nodes.push(
      el(
        'li',
        {
          class: `itinerary-stop${stop.feasible ? '' : ' is-infeasible'}`,
          dataset: { identityKey: stop.event.identity_key },
        },
        [
          el('span', {
            class: 'stop-time',
            text: stop.arrival === null ? '—' : formatClock(stop.arrival),
          }),
          el('span', {}, [
            el('strong', { text: stop.event.title }),
            ' ',
            el('span', { class: 'fact-text', text: stop.event.place.name }),
          ]),
          actions,
          el('span', {
            class: `stop-note${stop.feasible ? '' : ' is-warning'}`,
            text: stop.note,
          }),
        ],
      ),
    );
  });
  replace(list, nodes);

  const status = one('[data-role="itinerary-status"]', root);
  if (status) {
    const parts = [];
    if (!plan.stops.length) {
      parts.push('Save an event with a resolved building to start an itinerary.');
    } else {
      parts.push(`${plan.feasible} of ${plan.stops.length} stops reachable with ${dwell} min per stop.`);
      parts.push(
        exhaustive === null ? 'Manual order.' : exhaustive
          ? 'Every ordering of this selection was checked.'
          : 'Ordered with a fast heuristic; a better order may exist.',
      );
    }
    const excluded = excludedEvents();
    for (const item of excluded) {
      parts.push(`${item.event.title} is excluded because it is ${item.reason}.`);
    }
    if (state.storageWarning) parts.push(state.storageWarning);
    status.textContent = parts.join(' ');
  }
}

/** Recompute and render the itinerary for the selected date. */
export async function renderItinerary(root) {
  const generation = ++planGeneration;
  const selectedDate = state.selectedDate;
  const status = one('[data-role="itinerary-status"]', root);
  const events = plannableEvents();
  const itinerary = state.itinerary;
  const dwell = Number.isFinite(itinerary.dwell) ? itinerary.dwell : state.config.dwell_minutes;
  const departAt = parseClock(itinerary.departAt) ?? parseClock('17:00');

  if (!events.length) {
    renderPlan(root, { stops: [], feasible: 0, finish: departAt }, { exhaustive: true, dwell, onMove: () => {} });
    return;
  }

  if (status) status.textContent = 'Measuring walking times\u2026';
  const matrix = await buildMatrix(state.origin, events);
  if (generation !== planGeneration || selectedDate !== state.selectedDate) return;
  const options = { matrix, departAt, dwell };

  const manualOrder = itinerary.date === state.selectedDate && itinerary.keys.length
    ? itinerary.keys
        .map((key) => events.find((event) => event.identity_key === key))
        .filter(Boolean)
    : [];
  const missing = events.filter(
    (event) => !manualOrder.some((item) => item.identity_key === event.identity_key),
  );
  const order = [...manualOrder, ...missing];

  const plan = simulate(order, options);
  renderPlan(root, plan, {
    exhaustive: null,
    dwell,
    onMove: (key, delta) => {
      const keys = order.map((event) => event.identity_key);
      const index = keys.indexOf(key);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= keys.length) return;
      [keys[index], keys[target]] = [keys[target], keys[index]];
      setItinerary({ ...itinerary, date: state.selectedDate, keys });
      renderItinerary(root);
    },
  });

  // Keep the stored order in step with what is displayed.
  const displayed = order.map((event) => event.identity_key);
  if (itinerary.date !== state.selectedDate || String(itinerary.keys) !== String(displayed)) {
    setItinerary({ ...itinerary, date: state.selectedDate, keys: displayed });
  }

  one('[data-role="itinerary"]', root).dataset.ready = 'true';
  return { matrix, options, events };
}

/** Reorder the itinerary by feasibility and re-render. */
export async function optimizeItinerary(root) {
  const generation = ++planGeneration;
  const selectedDate = state.selectedDate;
  const events = plannableEvents();
  if (events.length < 2) {
    await renderItinerary(root);
    return;
  }
  const itinerary = state.itinerary;
  const dwell = Number.isFinite(itinerary.dwell) ? itinerary.dwell : state.config.dwell_minutes;
  const departAt = parseClock(itinerary.departAt) ?? parseClock('17:00');
  const status = one('[data-role="itinerary-status"]', root);
  if (status) status.textContent = 'Measuring walking times\u2026';
  const matrix = await buildMatrix(state.origin, events);
  if (generation !== planGeneration || selectedDate !== state.selectedDate) return;
  const options = { matrix, departAt, dwell };
  const { plan, exhaustive } = planOrder(events, options);
  setItinerary({
    ...itinerary,
    date: state.selectedDate,
    keys: plan.stops.map((stop) => stop.event.identity_key),
  });
  renderPlan(root, plan, {
    exhaustive,
    dwell,
    onMove: (key, delta) => {
      const keys = plan.stops.map((stop) => stop.event.identity_key);
      const index = keys.indexOf(key);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= keys.length) return;
      [keys[index], keys[target]] = [keys[target], keys[index]];
      setItinerary({ ...state.itinerary, date: state.selectedDate, keys });
      renderItinerary(root);
    },
  });
}

export { formatClock, parseClock };
