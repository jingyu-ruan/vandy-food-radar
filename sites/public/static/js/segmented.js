/** A moving selection surface shared by display and preference controls. */

/**
 * Where the indicator must sit inside `group` to cover `selected`.
 *
 * `offsetLeft` is measured from the button's offsetParent. The indicator is
 * absolutely positioned against the group, so the two only agree when the
 * group itself is the offsetParent (it is `position:relative`). If it is not
 * — the stylesheet has not applied yet, or a rule made it static — fall back
 * to layout rectangles relative to the group's padding edge instead of
 * trusting an offset measured from some outer ancestor.
 */
export function indicatorGeometry(group, selected) {
  if (selected.offsetParent === group) return {left: selected.offsetLeft, width: selected.offsetWidth};
  const outer = group.getBoundingClientRect();
  const inner = selected.getBoundingClientRect();
  return {left: inner.left - outer.left - (group.clientLeft || 0), width: selected.offsetWidth};
}

export function bindSegmented(root) {
  for (const group of root.querySelectorAll('.segmented')) {
    const indicator = document.createElement('span');
    indicator.className = 'segmented-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    group.prepend(indicator);
    // Snap (no transition) on the first measurement and whenever the group
    // becomes visible again, e.g. a closed settings dialog reopening after
    // the selection changed while it was hidden.
    let snap = true;
    let frame = 0;
    const update = () => {
      const selected = group.querySelector('button[aria-pressed="true"]');
      if (!selected || !group.clientWidth || !selected.offsetWidth) {
        snap = true;
        return;
      }
      const {left, width} = indicatorGeometry(group, selected);
      if (snap) indicator.style.transition = 'none';
      indicator.style.width = `${width}px`;
      indicator.style.transform = `translate3d(${left}px,0,0)`;
      group.classList.add('has-slider');
      if (snap) {
        snap = false;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {frame = requestAnimationFrame(() => {indicator.style.transition = '';});});
      }
    };
    new MutationObserver(update).observe(group, {subtree:true, attributes:true, attributeFilter:['aria-pressed']});
    if (typeof ResizeObserver !== 'undefined') {
      // Buttons can change width (font load, breakpoint type sizes) while the
      // group keeps its width, so watch them too.
      const observer = new ResizeObserver(update);
      observer.observe(group);
      for (const button of group.querySelectorAll('button')) observer.observe(button);
    } else window.addEventListener('resize', update);
    document.fonts?.ready.then(update);
    update();
  }
}
