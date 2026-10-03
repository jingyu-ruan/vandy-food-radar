/** Shared narrative and stable card links for server and browser rendering. */
import { el, one, replace } from './dom.js';
export function eventAnchor(identityKey) {
  return `event-${encodeURIComponent(identityKey)}`;
}
export function eventHref(identityKey, date) {
  const fragment=`#${encodeURIComponent(eventAnchor(identityKey))}`;
  return date ? `?date=${encodeURIComponent(date)}${fragment}` : fragment;
}
export function participationText(participation) {
  return (participation?.ai_note || participation?.note || '').replace(/^(?:Inferred|AI Estimate):\s*/i,'');
}
export function generatedLabel(brief, timezone='America/Chicago') {
  if (brief?.source!=='gemini' || !brief.generated_at || !brief.model) return '';
  const date=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(brief.generated_at));
  return `Generated ${date} by ${brief.model}`;
}
export function renderBriefAssessments(root, brief) {
  const node=one('[data-role="brief-assessments"]',root);
  if (!node) return;
  replace(node,(brief?.items || []).map(item=>el('p',{},[
    el('a',{class:'brief-event-link',href:eventHref(item.identity_key,brief?.date),text:item.title}),
    ': ', item.reason,
  ])));
}
export function bindBriefLinks(root) {
  root.addEventListener('click',event=>{
    const link=event.target.closest('.brief-event-link');
    if (!link || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target=document.getElementById(decodeURIComponent(new URL(link.href).hash.slice(1)));
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
    target.focus({preventScroll:true});
  });
}
