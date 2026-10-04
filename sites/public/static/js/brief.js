import {foodEmojiText, foodSourceText, dietaryOptions} from './food-emoji.js';
/** Shared table presentation and stable card links for server/browser rendering. */
import {compareEventCards} from './event-order.js';
import { el, one, replace } from './dom.js';
import { eventTime, formatTimesInText } from './preferences.js';
import { bindBriefLayout } from './brief-layout.js';
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
      walk: (item.walk || '—').replace(/^~/,'').replace('Walking Time Unverified', '—').replace(/;.*$/, '').replace(/\s+(?:straight-line )?estimate$/, ''),
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
  if (!rows.length) { replace(node, []); bindBriefLayout(node); return; }
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
    el('p', {class:'brief-scroll-hint',text:'Scroll horizontally to view all columns.',hidden:true}),
  ]);
  bindBriefLayout(node);
}
export function bindBriefLinks(root) {
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

/** Newlines carry distinct highlights; the application supplies list markup. */
export function briefLines(text) {
  return String(text || '').split(/[\r\n]+/).map(line=>line.trim().replace(/^[-•]\s*/, '')).filter(Boolean);
}
/** Bind each food recommendation to its published event before ordering or timing it. */
export function briefHighlights(text, events=[], clock, highlights=[]) {
  const normalize=value=>String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const available=events.filter(event=>!event.cancelled);
  const structured=highlights.map(highlight=>({text:highlight.text,event:available.find(event=>event.identity_key===highlight.identityKey)})).filter(row=>row.event);
  const fallback=briefLines(text).map(line=>{
      const exact=available.filter(event=>normalize(line).includes(normalize(event.title)));
      // Older saved briefs sometimes omit punctuation or a short parenthetical subtitle.
      const named=exact.length ? exact : available.filter(event=>{
        const title=normalize(event.title.replace(/\([^)]*\)/g,''));
        return title.length>8 && normalize(line).includes(title);
      });
      return {text:line,event:named.length===1 ? named[0] : null};
    });
  const rows=structured.length ? [...structured,...fallback.filter(row=>row.event && !structured.some(pick=>pick.event.identity_key===row.event.identity_key))] : fallback;
  return rows.sort((a,b)=>a.event && b.event ? compareEventCards(a.event,b.event) : a.event ? -1 : b.event ? 1 : 0).slice(0,3)
    .map(row=>({text:foodEmojiText(formatTimesInText(row.text,clock),foodSourceText(row.event ? [row.event] : available)),
      time:row.event ? eventTime(row.event,clock) : '',identityKey:row.event?.identity_key}));
}
export function renderBriefCopy(node,text,events=[],highlights=[]) {
  const rows=briefHighlights(text,events,undefined,highlights);
  const copy=row=>[row.time ? el('span',{class:'brief-highlight-time',text:row.time+' '}) : null,el('span',{text:row.text})];
  replace(node, rows.length>1 ? el('ul',{class:'brief-highlights'},rows.map(row=>el('li',{},copy(row)))) : el('p',{},rows.length ? copy(rows[0]) : []));
}
