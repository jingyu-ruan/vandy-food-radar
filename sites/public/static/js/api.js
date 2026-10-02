/**
 * Thin client for the app's own JSON API.
 *
 * Only same-origin paths are requested; there is no caller-supplied URL
 * anywhere in this module. Every call returns parsed JSON or throws, so the
 * views can show a specific failure state instead of a blank panel.
 */

const JSON_HEADERS = { Accept: 'application/json' };

async function getJson(path) {
  const response = await fetch(path, { headers: JSON_HEADERS, credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(`request failed (${response.status})`);
  }
  return response.json();
}

/** Fetch the feed for exactly one local date. */
export function fetchDay(isoDate) {
  return getJson(`/api/day?date=${encodeURIComponent(isoDate)}`);
}

/** Fetch seven consecutive days starting at `isoDate`. */
export function fetchWeek(isoDate) {
  return getJson(`/api/week?start=${encodeURIComponent(isoDate)}`);
}

/** Fetch the campus place dataset served as a static asset. */
export function fetchPlaces() {
  return getJson('/static/campus-places.json');
}

/**
 * Ask the server for a walking distance across `waypoints`.
 *
 * The response states whether it is a real pedestrian route or a labelled
 * straight-line estimate; callers must surface that distinction.
 */
export async function fetchWalking(waypoints) {
  const response = await fetch('/api/walking', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...JSON_HEADERS },
    credentials: 'same-origin',
    body: JSON.stringify({ waypoints }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error((payload && payload.error) || `walking request failed (${response.status})`);
  }
  return payload;
}
