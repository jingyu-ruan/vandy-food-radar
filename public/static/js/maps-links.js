/** Pure Google Maps walking-link helpers shared by server and browser cards. */
export function validPoint(point) {
  return Number.isFinite(point?.lat) && Math.abs(point.lat) <= 90 && Number.isFinite(point?.lng) && Math.abs(point.lng) <= 180;
}
export function mapsEndpoint(point) {
  if (validPoint(point)) return `${point.lat},${point.lng}`;
  return typeof point?.address === 'string' && point.address.trim() ? point.address.trim().slice(0,300) : null;
}
export function googleWalkingUrl(origin, destination) {
  const start = mapsEndpoint(origin), end = mapsEndpoint(destination);
  if (!start || !end) return null;
  const params = new URLSearchParams({api:'1',origin:start,destination:end,travelmode:'walking'});
  return `https://www.google.com/maps/dir/?${params}`;
}
export function destinationFor(event) {
  if (event.place) return {label:event.place.name,lat:event.place.lat,lng:event.place.lng,eventKey:event.identity_key,date:event.date};
  if (event.location_listed) return {label:event.location_listed,address:`${event.location_listed}, Vanderbilt University, Nashville, TN`,eventKey:event.identity_key,date:event.date};
  return null;
}
