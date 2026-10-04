import assert from 'node:assert/strict';
import test from 'node:test';
import {copyCanvasPixels, createMapSnapshot, relocateMap, SNAPSHOT_CLASS} from '../../public/static/js/map-snapshot.js';

/**
 * A minimal DOM: enough tree, attribute and 2D-canvas behavior to observe
 * which pixels a snapshot copies. Canvas "pixels" are an RGBA array; a
 * drawImage copies the source bitmap, which is what the browser does.
 */
class FakeElement {
  constructor(tagName, doc) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.inert = false;
    const classes = new Set();
    this.classList = {add: name => classes.add(name), contains: name => classes.has(name)};
    Object.defineProperty(this, 'className', {get: () => [...classes].join(' '), set: value => { classes.clear(); for (const name of String(value).split(/\s+/).filter(Boolean)) classes.add(name); }});
    if (this.tagName === 'CANVAS') { this._width = 0; this._height = 0; this.pixels = []; this.context = undefined; }
  }
  get width() { return this._width; }
  set width(value) { this._width = value; this.pixels = new Array(value * this._height * 4).fill(0); }
  get height() { return this._height; }
  set height(value) { this._height = value; this.pixels = new Array(this._width * value * 4).fill(0); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
  before(node) { node.remove(); const siblings = this.parentNode.children; node.parentNode = this.parentNode; siblings.splice(siblings.indexOf(this), 0, node); }
  remove() { if (!this.parentNode) return; const siblings = this.parentNode.children; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; }
  descendants() { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelectorAll(selector) {
    const all = this.descendants();
    return selector === '*' ? all : all.filter(node => node.tagName === selector.toUpperCase());
  }
  cloneNode(deep) {
    const copy = this.ownerDocument.createElement(this.tagName);
    copy.className = this.className;
    for (const [name, value] of this.attributes) copy.setAttribute(name, value);
    // Like the browser: the clone keeps its size attributes but no bitmap.
    if (this.tagName === 'CANVAS') { copy._width = this._width; copy._height = this._height; copy.pixels = new Array(this.pixels.length).fill(0); }
    if (deep) for (const child of this.children) copy.append(child.cloneNode(true));
    return copy;
  }
  getContext(type) {
    if (this.context !== undefined) return this.context;
    assert.equal(type, '2d');
    const canvas = this;
    return {
      drawImage(source, x, y) {
        assert.equal(x, 0); assert.equal(y, 0);
        if (source.throwOnRead) throw new DOMException('read failed', 'InvalidStateError');
        canvas.pixels = [...source.pixels];
      },
      getImageData(px, py) {
        const offset = (py * canvas.width + px) * 4;
        return {data: canvas.pixels.slice(offset, offset + 4)};
      },
    };
  }
}
const doc = {createElement: tag => new FakeElement(tag, doc)};
const node = (tag, attrs = {}, children = []) => {
  const element = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) name === 'class' ? element.className = value : element.setAttribute(name, value);
  element.append(...children);
  return element;
};
function paintedCanvas(width, height, className, alpha = 255) {
  const canvas = node('canvas', {class: className, style: `width:${width / 2}px;height:${height / 2}px`});
  canvas.width = width; canvas.height = height;
  canvas.pixels = Array.from({length: width * height * 4}, (_, index) => index % 4 === 3 ? alpha : (index * 37) % 256);
  return canvas;
}
function liveMap({alpha = 255} = {}) {
  const gl = paintedCanvas(8, 6, 'maplibregl-canvas', alpha);
  const overlay = paintedCanvas(4, 4, 'leaflet-overlay', 0);
  const marker = node('div', {class: 'vfr-pin-wrap', tabindex: '0', 'data-role': 'marker'});
  const split = node('div', {class: 'map-split', 'data-role': 'map-split'}, [
    node('div', {class: 'map-canvas', id: 'live-map', 'data-role': 'map'}, [gl, overlay, marker]),
  ]);
  const footer = node('footer', {class: 'map-attribution', 'data-role': 'map-attribution'}, [node('a', {href: 'https://www.openstreetmap.org/copyright'})]);
  return {split, footer, gl, overlay};
}

test('a snapshot copies every canvas pixel at its backing size and keeps CSS size', () => {
  const {split, footer, gl, overlay} = liveMap();
  const before = [...gl.pixels];
  const snapshot = createMapSnapshot([split, footer], doc);
  assert.ok(snapshot);
  const [glCopy, overlayCopy] = snapshot.querySelectorAll('canvas');
  assert.deepEqual([glCopy.width, glCopy.height], [8, 6]);
  assert.deepEqual(glCopy.pixels, gl.pixels);
  assert.deepEqual(overlayCopy.pixels, overlay.pixels, 'transparent overlays are copied as-is');
  assert.equal(glCopy.getAttribute('style'), gl.getAttribute('style'));
  assert.deepEqual(gl.pixels, before, 'the live canvas is only read');
  // The copy is inert and never answers live queries or keyboard focus.
  assert.ok(snapshot.classList.contains(SNAPSHOT_CLASS));
  assert.equal(snapshot.getAttribute('aria-hidden'), 'true');
  assert.equal(snapshot.inert, true);
  assert.ok(snapshot.querySelectorAll('*').every(element => !element.hasAttribute('id') && !element.hasAttribute('data-role')));
  assert.equal(snapshot.querySelectorAll('*').find(element => element.classList.contains('vfr-pin-wrap')).getAttribute('tabindex'), '-1');
  assert.equal(snapshot.querySelectorAll('*').find(element => element.tagName === 'A').getAttribute('tabindex'), '-1');
  assert.equal(split.getAttribute('data-role'), 'map-split', 'the live map keeps its identity');
});

test('an unpreserved (transparent) WebGL buffer, a failed read or a missing context is a failed copy', () => {
  assert.equal(createMapSnapshot([liveMap({alpha: 0}).split], doc), null);
  const unreadable = liveMap();
  unreadable.gl.throwOnRead = true;
  assert.equal(createMapSnapshot([unreadable.split], doc), null);
  const target = doc.createElement('canvas');
  target.context = null;
  assert.equal(copyCanvasPixels(liveMap().gl, target), false);
  const empty = doc.createElement('canvas');
  assert.equal(copyCanvasPixels(empty, doc.createElement('canvas')), true, 'a zero-sized canvas has nothing to lose');
});

test('relocation shows the snapshot in the outgoing panel and releases it when the slide finishes', () => {
  const {split, footer} = liveMap();
  const week = node('div', {class: 'schedule-map-host'}, [split, footer]);
  const mapHome = node('div');
  let flushed = 0;
  const move = relocateMap({nodes: [split, footer], host: mapHome, snapshot: true, beforeSnapshot: () => flushed++, doc});
  assert.equal(flushed, 1, 'the current frame is rendered before copying');
  assert.deepEqual(mapHome.children, [split, footer]);
  assert.equal(week.children.length, 1);
  assert.equal(week.children[0], move.snapshot);
  const copy = move.snapshot.querySelectorAll('canvas')[0];
  move.finish();
  assert.equal(week.children.length, 0);
  assert.equal(copy.width, 0, 'snapshot bitmaps are freed');
});

test('a failed copy keeps the live map in place until the slide ends; a rapid retarget cancels that move', () => {
  const {split, footer, gl} = liveMap({alpha: 0});
  const week = node('div', {}, [split, footer]);
  const mapHome = node('div');
  let moved = 0;
  const first = relocateMap({nodes: [split, footer], host: mapHome, snapshot: true, onMoved: () => moved++, doc});
  assert.equal(first.deferred, true);
  assert.equal(first.snapshot, null);
  assert.deepEqual(week.children, [split, footer], 'no blank copy is shown');
  first.finish();
  assert.deepEqual(mapHome.children, [split, footer]);
  assert.equal(moved, 1);

  // Week -> Map fails to copy, then Map -> Week before the slide settles.
  const back = relocateMap({nodes: [split, footer], host: week, snapshot: true, onMoved: () => moved++, doc});
  assert.equal(back.deferred, true);
  const again = relocateMap({nodes: [split, footer], host: mapHome, snapshot: false, doc});
  back.finish();
  again.finish();
  assert.deepEqual(mapHome.children, [split, footer], 'the cancelled move never runs');
  assert.equal(moved, 1);

  // A stale snapshot left in the new target host is released on retarget.
  gl.pixels = gl.pixels.map((value, index) => index % 4 === 3 ? 255 : value);
  const out = relocateMap({nodes: [split, footer], host: week, snapshot: true, doc});
  assert.equal(mapHome.children[0], out.snapshot);
  relocateMap({nodes: [split, footer], host: mapHome, snapshot: false, doc});
  assert.ok(!mapHome.children.some(child => child.classList.contains(SNAPSHOT_CLASS)));
  assert.deepEqual(mapHome.children, [split, footer]);
  out.finish();
});

test('reduced motion moves the live map directly without copying', () => {
  const {split, footer} = liveMap();
  const week = node('div', {}, [split, footer]);
  const mapHome = node('div');
  const move = relocateMap({nodes: [split, footer], host: mapHome, snapshot: false, beforeSnapshot: () => assert.fail('no copy'), doc});
  assert.equal(move.snapshot, null);
  assert.equal(week.children.length, 0);
  assert.deepEqual(mapHome.children, [split, footer]);
});
