/** Shared cue for independently scrolling event lists. */
export function bindScrollHint(root) {
  bindListHint(root.querySelector('[data-role="agenda"]'), root.querySelector('[data-action="scroll-agenda"]'));
  bindListHint(root.querySelector('[data-role="map-list"]'), root.querySelector('[data-action="scroll-map-events"]'));
}
function bindListHint(agenda, hint) {
  if (!agenda || !hint) return;
  const update = () => {
    // The list reserves bottom padding for this cue; padding is not another event.
    const last = agenda.lastElementChild;
    const visibleBottom = agenda.getBoundingClientRect().top + agenda.clientTop + agenda.clientHeight;
    hint.hidden = agenda.clientHeight === 0 || !last || last.getBoundingClientRect().bottom <= visibleBottom + 8;
  };
  agenda.addEventListener('scroll', update, {passive:true});
  hint.addEventListener('click', () => {
    agenda.scrollBy({top:agenda.clientHeight * 0.7,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
  });
  new MutationObserver(update).observe(agenda, {childList:true,subtree:true});
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(update).observe(agenda);
  window.addEventListener('resize',update);
  update();
}
