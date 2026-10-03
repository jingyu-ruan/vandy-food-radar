import { displayText } from './preferences.js';
/**
 * Minimal DOM helpers.
 *
 * Every piece of event text comes from an external listing, so this module is
 * the only way nodes are built and it has no path that assigns `innerHTML`
 * from data. Text is always set through `textContent`, and attribute values
 * that could become navigable URLs go through `safeHref`.
 */

const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Create an element with attributes and children.
 *
 * `text` sets `textContent`; `class` sets the class list; `dataset` sets data
 * attributes; `href`/`src` are validated. Children may be nodes or strings,
 * and strings always become text nodes rather than markup.
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') {
      node.textContent = displayText(value);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (key === 'dataset') {
      for (const [dataKey, dataValue] of Object.entries(value)) {
        if (dataValue === null || dataValue === undefined) continue;
        node.dataset[dataKey] = String(dataValue);
      }
    } else if (key === 'href' || key === 'src') {
      const href = safeHref(value);
      if (href) node.setAttribute(key, href);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  append(node, children);
  return node;
}

/** Append `children` (nodes or strings) to `node`. */
export function append(node, children) {
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(displayText(child)));
  }
}

/** Return `value` only when it resolves to an absolute http(s) URL. */
export function safeHref(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, window.location.origin);
    if (!SAFE_PROTOCOLS.has(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Remove every child of `node`. */
export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Replace the children of `node` with `children`. */
export function replace(node, children) {
  clear(node);
  append(node, children);
}

/** Query one element, scoped to `root`. */
export function one(selector, root = document) {
  return root.querySelector(selector);
}

/** Query all matching elements as an array, scoped to `root`. */
export function all(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}
