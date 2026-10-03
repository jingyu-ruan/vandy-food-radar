/** Same-origin icon sprite shared by server and browser-rendered controls. */
export function icon(name) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('class', 'ui-icon');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `/static/icons.svg#${name}`);
  node.append(use);
  return node;
}
