/** Camera identity depends on coordinates, never labels or saved state. */
export function coordinateKey(point) {
  return Number.isFinite(point?.lat) && Number.isFinite(point?.lng) ? `${point.lat}:${point.lng}` : null;
}

export function cameraChange(previous, next) {
  if (!previous) return 'initial';
  if (previous.destination !== next.destination && next.destination) return 'destination';
  if (previous.origin !== next.origin && next.origin) return 'origin';
  if (previous.date !== next.date && !next.selected) return 'date';
  return null;
}
