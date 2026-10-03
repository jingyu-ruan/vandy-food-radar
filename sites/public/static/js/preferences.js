/** Device-local presentation preferences. Canonical event times remain unchanged. */
export const PREFERENCE_KEY = 'vfr:preferences';
export const preferences = { theme: 'system', clock: '12' };

export function normalizePreferences(value) {
  return {
    theme: ['system', 'light', 'dark'].includes(value?.theme) ? value.theme : 'system',
    clock: value?.clock === '24' ? '24' : '12',
  };
}

export function loadPreferences(storage) {
  try {
    Object.assign(preferences, normalizePreferences(JSON.parse(storage.getItem(PREFERENCE_KEY))));
  } catch {
    Object.assign(preferences, normalizePreferences(null));
  }
  return preferences;
}

export function displayText(value) {
  return String(value ?? '').replaceAll('\u00b7', ' ').replace(/[ \t]{2,}/g, ' ');
}

export function formatMinutes(minutes, clock = preferences.clock) {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = String(wrapped % 60).padStart(2, '0');
  return clock === '24'
    ? `${String(h).padStart(2, '0')}:${m}`
    : `${h % 12 || 12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

export function clockMinutes(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})(?::00)?(?:\s*(AM|PM))?$/i.exec(value.trim());
  if (!match) return null;
  let h = Number(match[1]);
  const m = Number(match[2]);
  if (m > 59 || h > (match[3] ? 12 : 23) || (match[3] && h === 0)) return null;
  if (match[3]) h = h % 12 + (match[3].toUpperCase() === 'PM' ? 12 : 0);
  return h * 60 + m;
}

export function eventTime(event, clock = preferences.clock) {
  const start = clockMinutes(event.start);
  const end = clockMinutes(event.end);
  if (start === null) return displayText(event.time_label || 'Time not listed');
  const first = formatMinutes(start, clock);
  if (end === null) return first;
  return `${first} – ${formatMinutes(end, clock)}${end <= start ? ' next day' : ''}`;
}

/** Adapt generated brief times without changing the underlying source text. */
export function formatTimesInText(text, clock = preferences.clock) {
  return text.replace(/\b(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\b/gi, (match, hour, minute, suffix) => {
    const minutes = clockMinutes(`${hour}:${minute || '00'} ${suffix}`);
    return minutes === null ? match : formatMinutes(minutes, clock);
  });
}

export function applyPreferences(root = document) {
  const html = root.documentElement;
  if (preferences.theme === 'system') delete html.dataset.theme;
  else html.dataset.theme = preferences.theme;
  for (const button of root.querySelectorAll('[data-theme], [data-clock]')) {
    const active = button.dataset.theme
      ? button.dataset.theme === preferences.theme
      : button.dataset.clock === preferences.clock;
    button.setAttribute('aria-pressed', String(active));
  }
}

export function bindPreferences(root, onClockChange) {
  let storage;
  try { storage = window.localStorage; } catch { /* Session defaults remain usable. */ }
  loadPreferences(storage);
  applyPreferences(root);
  for (const button of root.querySelectorAll('[data-theme], [data-clock]')) {
    button.addEventListener('click', () => {
      if (button.dataset.theme) preferences.theme = button.dataset.theme;
      else preferences.clock = button.dataset.clock;
      applyPreferences(root);
      try {
        storage.setItem(PREFERENCE_KEY, JSON.stringify(preferences));
        root.querySelector('[data-role="preferences-status"]').textContent = 'Changes save automatically on this device.';
      } catch {
        root.querySelector('[data-role="preferences-status"]').textContent = 'Preferences apply to this session. Device storage is unavailable.';
      }
      if (button.dataset.clock) onClockChange();
    });
  }
  window.addEventListener('storage', event => {
    if (event.key !== PREFERENCE_KEY && event.key !== null) return;
    const previousClock = preferences.clock;
    loadPreferences(storage);
    applyPreferences(root);
    if (previousClock !== preferences.clock) onClockChange();
  });
}
