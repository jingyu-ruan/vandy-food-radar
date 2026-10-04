import {foodEmojiText, foodSourceText, dietaryOptions} from './food-emoji.js';
/** Shared table presentation and stable card links for server/browser rendering. */
import {compareEventCards} from './event-order.js';
import { el, one, replace } from './dom.js';
import { eventTime, formatTimesInText } from './preferences.js';
export const BRIEF_COLUMNS = ['Rank', 'Event', 'Time', 'Food', 'Location', 'Walk', 'Notes'];
export function briefRows(brief, events = [], clock) {
  const cards = new Map(events.map(event => [event.identity_key, event]));
  return [...(brief?.items || [])].sort((a,b)=>compareEventCards(cards.get(a.identity_key),cards.get(b.identity_key))).map((item, index) => {
    const card = cards.get(item.identity_key);
    return {
      ...item,
      rank: index + 1,
      source_url: card?.event_url || null,
      time: card ? eventTime(card, clock) : formatTimesInText(item.time || 'Time Not Listed', clock),
      food: foodEmojiText(!item.food || ['Food/Menu Not Specified','Unspecified'].includes(item.food) ? (card ? dietaryOptions(card).join(', ') || 'Unspecified' : 'Unspecified') : item.food,foodSourceText(card ? [card] : [])),
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
  if (brief?.source==='rules') return 'Source Summary';
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
    el('div', {class:'brief-table-scroll',tabindex:0,role:'region','aria-label':'Daily Brief event table'}, [
      el('table', {class:'brief-table'}, [
        el('caption', {class:'visually-hidden',text:'Ranked free-food events for the selected date'}),
        el('thead', {}, [el('tr', {}, BRIEF_COLUMNS.map(column => el('th', {scope:'col',text:column})))]),
        el('tbody', {}, rows.map(item => el('tr', {dataset:{identityKey:item.identity_key},class:item.cancelled ? 'brief-row-cancelled' : ''}, [
          el('td', {class:'brief-rank'},[el('a',{class:'brief-card-link',href:eventHref(item.identity_key,brief?.date),text:item.rank,title:'View Event Card','aria-label':`View event card for ${item.title}`})]),
          el('th', {scope:'row',class:'brief-activity'}, [item.source_url ? el('a',{class:'brief-event-link',href:item.source_url,target:'_blank',rel:'noopener noreferrer',text:item.title,title:'Open Event Source'}) : el('span',{text:item.title}),item.cancelled ? el('span',{class:'brief-cancelled',text:'Cancelled'}) : null]),
          el('td', {class:'brief-time',text:item.time}),
          el('td', {text:item.food}),
          el('td', {text:item.location}),
          el('td', {class:'brief-walk',dataset:{role:'brief-walking'},text:item.walk,title:item.walk_detail,'aria-label':item.walk_detail || 'Walking time unavailable'}),
          el('td', {class:'brief-notes',text:item.reason}),
        ]))),
      ]),
    ]),
    el('p',{class:'brief-link-hint',text:'Select Rank to view the event card. Select Event to open its source.'}),
    el('p', {class:'brief-scroll-hint',text:'Scroll inside the table for more events and columns.'}),
  ]);
  requestAnimationFrame(()=>updateBriefOverflow(root));
}
export function bindBriefLinks(root) {
  const holder=one('[data-role="brief-assessments"]',root);
  if(holder && typeof ResizeObserver!=='undefined') new ResizeObserver(()=>updateBriefOverflow(root)).observe(holder);
  window.addEventListener('resize',()=>updateBriefOverflow(root));
  updateBriefOverflow(root);
  root.addEventListener('click',event=>{
    const link=event.target.closest('.brief-card-link');
    if (!link || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target=document.getElementById(decodeURIComponent(new URL(link.href).hash.slice(1)));
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
    target.focus({preventScroll:true});
  });
}

export function updateBriefOverflow(root) {
  const scroll=one('.brief-table-scroll',root), hint=one('.brief-scroll-hint',root);
  if(scroll && hint) hint.hidden=scroll.scrollHeight<=scroll.clientHeight+1 && scroll.scrollWidth<=scroll.clientWidth+1;
}
/** Newlines carry distinct highlights; the application supplies list markup. */
export function briefLines(text) {
  return String(text || '').split(/[\r\n]+/).map(line=>line.trim().replace(/^[-•]\s*/, '')).filter(Boolean);
}
export function renderBriefCopy(node,text,events=[]) {
  const lines=briefLines(foodEmojiText(formatTimesInText(text),foodSourceText(events)));
  replace(node, lines.length>1 ? el('ul',{class:'brief-highlights'},lines.map(line=>el('li',{text:line}))) : el('p',{text:lines[0] || ''}));
}
