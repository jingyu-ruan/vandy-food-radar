/** A visible, keyboard-accessible cue for the independently scrolling week. */
export function bindScrollHint(root) {
  const agenda = root.querySelector('[data-role="agenda"]');
  const hint = root.querySelector('[data-action="scroll-agenda"]');
  if (!agenda || !hint) return;
  const update = () => {
    hint.hidden = agenda.clientHeight === 0 || agenda.scrollHeight - agenda.clientHeight - agenda.scrollTop <= 8;
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
