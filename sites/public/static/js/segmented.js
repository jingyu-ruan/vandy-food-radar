/** A moving selection surface shared by display and preference controls. */
export function bindSegmented(root) {
  for (const group of root.querySelectorAll('.segmented')) {
    const indicator = document.createElement('span');
    indicator.className = 'segmented-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    group.prepend(indicator);
    let initialized = false;
    const update = () => {
      const selected = group.querySelector('button[aria-pressed="true"]');
      if (!selected || !group.clientWidth) return;
      if (!initialized) indicator.style.transition = 'none';
      indicator.style.width = `${selected.offsetWidth}px`;
      indicator.style.transform = `translate3d(${selected.offsetLeft}px,0,0)`;
      group.classList.add('has-slider');
      if (!initialized) {
        initialized = true;
        requestAnimationFrame(() => requestAnimationFrame(() => {indicator.style.transition = '';}));
      }
    };
    new MutationObserver(update).observe(group, {subtree:true, attributes:true, attributeFilter:['aria-pressed']});
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(update).observe(group);
    else window.addEventListener('resize', update);
    document.fonts?.ready.then(update);
    update();
  }
}
