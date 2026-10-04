/** Shared table presentation and stable card links for server/browser rendering. */
import { el, one, replace } from './dom.js';
import { eventTime, formatTimesInText } from './preferences.js';
export const BRIEF_COLUMNS = ['Ranking', 'Activity', 'Time', 'Food', 'Location', 'Walk', 'Notes'];
export function briefRows(brief, events = [], clock) {
  const cards = new Map(events.map(event => [event.identity_key, event]));
  return (brief?.items || []).map((item, index) => {
    const card = cards.get(item.identity_key);
    return {
      ...item,
      rank: index + 1,
      time: card ? eventTime(card, clock) : formatTimesInText(item.time || 'Time not listed', clock),
      food: !item.food || item.food === 'Food/Menu Not Specified' ? 'Unspecified' : item.food,
      location: item.location || 'Location not listed',
      walk: (item.walk || '—').replace('Walking Time Unverified', '—').replace(/;.*$/, '').replace(/\s+(?:straight-line )?estimate$/, ''),
      walk_detail: item.walk,
      reason: formatTimesInText(item.reason || 'Check the event details for participation requirements.', clock),
      cancelled: Boolean(card?.cancelled),
    };
  });
}
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
  if (brief?.source==='rules') return 'Source summary';
  if (brief?.source!=='gemini' || !brief.generated_at || !brief.model) return '';
  const date=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(brief.generated_at));
  return `Generated ${date} by ${brief.model}`;
}
export function renderBriefAssessments(root, brief, events = []) {
  const node=one('[data-role="brief-assessments"]',root);
  if (!node) return;
  const rows = briefRows(brief, events);
  node.hidden = !rows.length;
  if (!rows.length) { replace(node, []); return; }
  replace(node, [
    el('div', {class:'brief-table-scroll',tabindex:0,role:'region','aria-label':'Daily Brief activity table'}, [
      el('table', {class:'brief-table'}, [
        el('caption', {class:'visually-hidden',text:'Ranked free-food activities for the selected date'}),
        el('thead', {}, [el('tr', {}, BRIEF_COLUMNS.map(column => el('th', {scope:'col',text:column})))]),
        el('tbody', {}, rows.map(item => el('tr', {dataset:{identityKey:item.identity_key},class:item.cancelled ? 'brief-row-cancelled' : ''}, [
          el('td', {class:'brief-rank',text:item.rank}),
          el('th', {scope:'row',class:'brief-activity'}, [el('a',{class:'brief-event-link',href:eventHref(item.identity_key,brief?.date),text:item.title}), item.cancelled ? el('span',{class:'brief-cancelled',text:'Cancelled'}) : null]),
          el('td', {class:'brief-time',text:item.time}),
          el('td', {text:item.food}),
          el('td', {text:item.location}),
          el('td', {class:'brief-walk',dataset:{role:'brief-walking'},text:item.walk,title:item.walk_detail,'aria-label':item.walk_detail || 'Walking time unavailable'}),
          el('td', {class:'brief-notes',text:item.reason}),
        ]))),
      ]),
    ]),
    el('p', {class:'brief-scroll-hint',text:'Scroll horizontally to see all columns.'}),
  ]);
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
