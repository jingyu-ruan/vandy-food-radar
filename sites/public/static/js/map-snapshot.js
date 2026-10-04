/**
 * Outgoing-map snapshots for the Week and Map slide.
 *
 * One live Leaflet map moves between the Week and Map panels. While the
 * outgoing panel slides away it shows a static copy, so the live map can be
 * resized in its new panel without the old panel going blank. `cloneNode`
 * copies the DOM (tile images, markers, controls) but never canvas pixels, so
 * every cloned canvas receives an explicit bitmap copy. The MapLibre WebGL
 * canvas can only be read outside its render frame when it was created with
 * `preserveDrawingBuffer`; a copy that comes back transparent is treated as a
 * failure rather than shown as an empty grey map.
 *
 * Nothing here touches the map instance, so the camera and shared state are
 * unchanged by taking or discarding a snapshot.
 */

export const SNAPSHOT_CLASS = 'map-transition-snapshot';

/** Whether a canvas must contain opaque pixels for its copy to be usable. */
export function requiresOpaque(canvas) {
  return Boolean(canvas.classList?.contains('maplibregl-canvas'));
}

/**
 * Copy every pixel of `source` into `target` at the same backing size.
 * Returns false when the copy is impossible or visibly empty.
 */
export function copyCanvasPixels(source, target, {opaque = requiresOpaque(source)} = {}) {
  const width = source.width, height = source.height;
  target.width = width;
  target.height = height;
  // A zero-sized canvas has nothing to show; an empty copy is identical.
  if (!width || !height) return true;
  try {
    const context = target.getContext('2d');
    if (!context) return false;
    context.drawImage(source, 0, 0);
    if (opaque) {
      // An unpreserved WebGL buffer reads back fully transparent.
      const pixel = context.getImageData(Math.floor(width / 2), Math.floor(height / 2), 1, 1).data;
      if (!pixel || pixel[3] === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Free snapshot bitmaps promptly instead of waiting for garbage collection. */
export function releaseSnapshot(snapshot) {
  if (!snapshot) return;
  for (const canvas of snapshot.querySelectorAll('canvas')) {
    canvas.width = 0;
    canvas.height = 0;
  }
  snapshot.remove();
}

/**
 * Build an inert, unidentified copy of `nodes`, or null when any canvas
 * cannot be copied. A partial copy is released, never returned.
 */
export function createMapSnapshot(nodes, doc = document) {
  const snapshot = doc.createElement('div');
  snapshot.className = SNAPSHOT_CLASS;
  snapshot.setAttribute('aria-hidden', 'true');
  snapshot.inert = true;
  for (const node of nodes) {
    const copy = node.cloneNode(true);
    const sources = [...node.querySelectorAll('canvas')];
    const targets = [...copy.querySelectorAll('canvas')];
    snapshot.append(copy);
    if (sources.length !== targets.length || sources.some((canvas, index) => !copyCanvasPixels(canvas, targets[index]))) {
      releaseSnapshot(snapshot);
      return null;
    }
    // Copies must not answer live queries, labels or focus.
    for (const element of [copy, ...copy.querySelectorAll('*')]) {
      element.removeAttribute('id');
      element.removeAttribute('data-role');
      if (element.hasAttribute?.('tabindex') || /^(?:A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(element.tagName || '')) element.setAttribute('tabindex', '-1');
    }
  }
  return snapshot;
}

const pending = new WeakMap();

/**
 * Move the live map `nodes` into `host`.
 *
 * With motion, the outgoing panel keeps a pixel-identical snapshot until
 * `finish()` runs. If a snapshot cannot be made, the live map stays in the
 * outgoing panel for the slide and moves when `finish()` runs, so neither
 * panel shows a blank map. Starting a new relocation cancels a deferred move
 * and discards any snapshot already shown in the new target host.
 */
export function relocateMap({nodes, host, snapshot = false, beforeSnapshot, onMoved, doc = document}) {
  const [lead] = nodes;
  const previous = pending.get(lead);
  if (previous) previous.cancelled = true;
  pending.delete(lead);
  const done = {snapshot: null, deferred: false, finish() {}};
  if (!lead || !host) return done;
  for (const child of [...host.children]) {
    if (child.classList?.contains(SNAPSHOT_CLASS)) releaseSnapshot(child);
  }
  if (lead.parentNode === host) return done;
  if (snapshot) {
    try { beforeSnapshot?.(); } catch { /* A copy of the last frame is still usable. */ }
    done.snapshot = createMapSnapshot(nodes, doc);
    if (!done.snapshot) {
      const move = {cancelled: false};
      pending.set(lead, move);
      done.deferred = true;
      done.finish = () => {
        if (move.cancelled) return;
        pending.delete(lead);
        host.append(...nodes);
        onMoved?.();
      };
      return done;
    }
    lead.before(done.snapshot);
    const shown = done.snapshot;
    done.finish = () => releaseSnapshot(shown);
  }
  host.append(...nodes);
  return done;
}
