import {el,one,replace} from './dom.js';
import {icon} from './icons.js';
const profiles=new Map();
export function hostEventId(url) {
  try {const value=new URL(url);return value.origin==='https://anchorlink.vanderbilt.edu' ? value.pathname.match(/^\/event\/([1-9][0-9]*)$/)?.[1] || null : null;}catch{return null;}
}
export function hostPanelId(event) {return `host-${event.date}-${event.identity_key}`.replace(/[^a-zA-Z0-9_-]/g,'-');}
export function hostFor(event) {
  const id=hostEventId(event.event_url);
  if(!id || !event.organizer)return el('span',{class:'fact-text',text:event.organizer || 'Not Listed'});
  return el('span',{class:'host-profile',dataset:{eventId:id}},[el('button',{type:'button',class:'host-trigger','aria-expanded':'false','aria-controls':hostPanelId(event),'aria-label':`About ${event.organizer}`,text:event.organizer}),el('span',{class:'host-panel',id:hostPanelId(event),role:'region','aria-label':`Host introduction for ${event.organizer}`,hidden:true},[el('span',{class:'host-description',text:'Loading introduction…'})])]);
}
export function bindHosts(root) {
  const leaveTimers=new WeakMap();
  const position=host=>{
    const panel=one('.host-panel',host), box=one('.host-trigger',host).getBoundingClientRect(), rect=panel.getBoundingClientRect();
    panel.style.left=`${Math.max(16,Math.min(box.left,innerWidth-rect.width-16))}px`;
    panel.style.top=`${Math.max(16,box.bottom+rect.height+8<innerHeight ? box.bottom+8 : box.top-rect.height-8)}px`;
  };
  const close=host=>{one('.host-panel',host).hidden=true;one('.host-trigger',host).setAttribute('aria-expanded','false');host.classList.remove('is-pinned');};
  const open=async host=>{
    for(const other of root.querySelectorAll('.host-profile'))if(other!==host)close(other);
    const panel=one('.host-panel',host);panel.hidden=false;one('.host-trigger',host).setAttribute('aria-expanded','true');position(host);
    if(panel.dataset.loaded==='true')return;
    const id=host.dataset.eventId;
    if(!profiles.has(id))profiles.set(id,fetch(`/api/organization?event=${encodeURIComponent(id)}`,{credentials:'same-origin'}).then(async response=>{if(!response.ok)throw new Error();return (await response.json()).profile;}).catch(()=>{profiles.delete(id);return null;}));
    const profile=await profiles.get(id);
    replace(panel,profile ? [el('span',{class:'host-header'},[el('strong',{class:'host-name',text:profile.name}),profile.url ? el('a',{class:'host-source',href:profile.url,target:'_blank',rel:'noopener noreferrer'},[el('span',{text:'View Organization'}),icon('external-link')]) : null]),el('span',{class:'host-description',text:profile.description || 'This organization has no published introduction'})] : el('span',{class:'host-description',text:'The host introduction is temporarily unavailable. Try again shortly'}));
    panel.dataset.loaded=String(Boolean(profile));
    if(!panel.hidden)position(host);
  };
  root.addEventListener('pointerover',event=>{if(!matchMedia('(hover:hover)').matches)return;const host=event.target.closest?.('.host-profile');if(host){clearTimeout(leaveTimers.get(host));if(!host.contains(event.relatedTarget))open(host);}});
  root.addEventListener('pointerout',event=>{const host=event.target.closest?.('.host-profile');if(host && !host.contains(event.relatedTarget))leaveTimers.set(host,setTimeout(()=>{if(!host.contains(document.activeElement) && !host.classList.contains('is-pinned'))close(host);},180));});
  root.addEventListener('focusin',event=>{const host=event.target.closest?.('.host-profile');if(host)open(host);});
  root.addEventListener('focusout',event=>{const host=event.target.closest?.('.host-profile');if(host)requestAnimationFrame(()=>{if(!host.contains(document.activeElement))close(host);});});
  root.addEventListener('click',event=>{const trigger=event.target.closest?.('.host-trigger');if(!trigger)return;const host=trigger.closest('.host-profile');if(host.classList.contains('is-pinned'))close(host);else{host.classList.add('is-pinned');open(host);}});
  root.addEventListener('pointerdown',event=>{for(const host of root.querySelectorAll('.host-profile'))if(!host.contains(event.target))close(host);});
  root.addEventListener('keydown',event=>{const host=event.target.closest?.('.host-profile');if(host && event.key==='Escape'){event.preventDefault();one('.host-trigger',host).focus();close(host);}});
  const reposition=()=>{for(const host of root.querySelectorAll('.host-profile'))if(!one('.host-panel',host).hidden)position(host);};
  window.addEventListener('resize',reposition);window.addEventListener('scroll',reposition,true);
}
