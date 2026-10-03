/** Presentation-only copy cleanup. Source records and link targets stay intact. */
export function displayText(value: string): string {
  return value.replaceAll("\u00b7", " ").replace(/[ \t]{2,}/g, " ");
}

const DATA_KEYS = new Set(["identity_key", "date", "start", "end", "state", "level", "url", "source_url", "event_url", "rsvp_url", "google", "ics", "content_hash"]);

export function displayFields<T>(value: T, key = ""): T {
  if (typeof value === "string") return (DATA_KEYS.has(key) ? value : displayText(value)) as T;
  if (Array.isArray(value)) return value.map(item => displayFields(item, key)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([field, item]) => [field, displayFields(item, field)])) as T;
  }
  return value;
}
