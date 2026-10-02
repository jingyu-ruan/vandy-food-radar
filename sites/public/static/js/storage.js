/**
 * Local persistence for bookmarks, walking origin, and the itinerary.
 *
 * Browser storage is treated as hostile input. It may be unavailable (private
 * mode, blocked third-party storage, quota exhausted) and its contents may be
 * stale, hand-edited, or written by an older version of this app. Every read
 * is therefore validated field by field and anything unusable is discarded
 * rather than trusted; every write is wrapped so a failure degrades the
 * feature to in-memory only instead of breaking the page.
 */

const KEYS = {
  saved: 'vfr.saved.v1',
  origin: 'vfr.origin.v1',
  itinerary: 'vfr.itinerary.v1',
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ITEMS = 200;

let available = null;
/** In-memory mirror used when storage is unavailable or write-blocked. */
const memory = new Map();

/** Probe storage once; a blocked or quota-full store reports unavailable. */
function storage() {
  if (available === false) return null;
  try {
    const store = window.localStorage;
    if (available === null) {
      const probe = '__vfr_probe__';
      store.setItem(probe, '1');
      store.removeItem(probe);
      available = true;
    }
    return store;
  } catch {
    available = false;
    return null;
  }
}

function readRaw(key) {
  const store = storage();
  if (!store) return memory.get(key) ?? null;
  try {
    return store.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function writeRaw(key, value) {
  memory.set(key, value);
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(key, value);
    return true;
  } catch {
    available = false;
    return false;
  }
}

function readJson(key) {
  const raw = readRaw(key);
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Corrupt payload: drop it so the next write starts from a clean slate.
    remove(key);
    return null;
  }
}

function remove(key) {
  memory.delete(key);
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    /* nothing further to do */
  }
}

/** Whether persistent storage is usable in this browser session. */
export function storageAvailable() {
  return storage() !== null;
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00`);
  return !Number.isNaN(parsed.getTime()) && parsed.getFullYear()===Number(value.slice(0,4))
    && parsed.getMonth()+1===Number(value.slice(5,7)) && parsed.getDate()===Number(value.slice(8,10));
}

function validRef(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    typeof entry.identity_key === 'string' &&
    entry.identity_key.length > 0 &&
    entry.identity_key.length <= 240 &&
    isIsoDate(entry.date)
  );
}

/** Load saved event references, dropping anything malformed. */
export function loadSaved() {
  const payload = readJson(KEYS.saved);
  if (!Array.isArray(payload)) return [];
  const seen = new Set();
  const result = [];
  for (const entry of payload.slice(0, MAX_ITEMS)) {
    if (!validRef(entry)) continue;
    const id = `${entry.date}|${entry.identity_key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({ date: entry.date, identity_key: entry.identity_key });
  }
  return result;
}

/** Persist saved event references (best effort). */
export function saveSaved(entries) {
  const payload = entries
    .filter(validRef)
    .slice(0, MAX_ITEMS)
    .map((entry) => ({ date: entry.date, identity_key: entry.identity_key }));
  return writeRaw(KEYS.saved, JSON.stringify(payload));
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Load the stored walking origin.
 *
 * Coordinates are range-checked, because a bad stored value would otherwise
 * be sent to the walking endpoint and drawn on the map.
 */
export function loadOrigin() {
  const payload = readJson(KEYS.origin);
  if (!payload || typeof payload !== 'object') return null;
  const { label, lat, lng, kind } = payload;
  if (!finiteNumber(lat) || !finiteNumber(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  if (typeof label !== 'string' || !label.trim() || label.length > 160) return null;
  const allowedKinds = new Set(['place', 'pin', 'gps', 'default']);
  return {
    label: label.trim(),
    lat,
    lng,
    kind: allowedKinds.has(kind) ? kind : 'place',
  };
}

/** Persist the walking origin (best effort). */
export function saveOrigin(origin) {
  if (!origin) {
    remove(KEYS.origin);
    return true;
  }
  return writeRaw(
    KEYS.origin,
    JSON.stringify({
      label: origin.label,
      lat: origin.lat,
      lng: origin.lng,
      kind: origin.kind || 'place',
    }),
  );
}

/**
 * Load the itinerary.
 *
 * An itinerary is scoped to one date by design, so a stored payload without a
 * valid date is discarded entirely rather than merged into the current day.
 */
export function loadItinerary() {
  const payload = readJson(KEYS.itinerary);
  if (!payload || typeof payload !== 'object') return null;
  if (!isIsoDate(payload.date)) return null;
  if (!Array.isArray(payload.keys)) return null;
  const keys = [];
  for (const key of payload.keys.slice(0, 40)) {
    if (typeof key === 'string' && key && key.length <= 240 && !keys.includes(key)) {
      keys.push(key);
    }
  }
  const dwell = finiteNumber(payload.dwell) ? Math.min(240, Math.max(0, payload.dwell)) : null;
  const departAt = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(payload.departAt) ? payload.departAt : null;
  return { date: payload.date, keys, dwell, departAt };
}

/** Persist the itinerary (best effort). */
export function saveItinerary(itinerary) {
  if (!itinerary || !isIsoDate(itinerary.date)) {
    remove(KEYS.itinerary);
    return true;
  }
  return writeRaw(
    KEYS.itinerary,
    JSON.stringify({
      date: itinerary.date,
      keys: itinerary.keys.slice(0, 40),
      dwell: itinerary.dwell,
      departAt: itinerary.departAt,
    }),
  );
}

/** Clear every stored value this app owns. */
export function clearAll() {
  Object.values(KEYS).forEach(remove);
}
