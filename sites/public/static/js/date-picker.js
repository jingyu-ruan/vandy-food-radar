/** Desktop calendar; touch devices retain their system date control. */
import {el,one,replace} from './dom.js';
import {icon} from './icons.js';

const iso = date => date.toISOString().slice(0,10);
const utc = date => new Date(`${date}T12:00:00Z`);
export function shiftCalendarDay(date,offset) {
  const value=utc(date); value.setUTCDate(value.getUTCDate()+offset); return iso(value);
}
export function shiftCalendarMonth(date,offset) {
  const value=utc(date), day=value.getUTCDate();
  value.setUTCDate(1); value.setUTCMonth(value.getUTCMonth()+offset);
  const last=new Date(Date.UTC(value.getUTCFullYear(),value.getUTCMonth()+1,0)).getUTCDate();
  value.setUTCDate(Math.min(day,last)); return iso(value);
}
export function calendarDays(date) {
  const first=`${date.slice(0,7)}-01`, start=shiftCalendarDay(first,-utc(first).getUTCDay());
  return Array.from({length:42},(_,index)=>shiftCalendarDay(start,index));
}
const dateLabel=(date,options)=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',...options}).format(utc(date));
export function syncDatePicker(root,date) {
  const label=one('[data-role="date-picker-label"]',root), trigger=one('[data-role="date-picker-trigger"]',root);
  if(label) label.textContent=dateLabel(date,{month:'short',day:'numeric',year:'numeric'});
  if(trigger) trigger.setAttribute('aria-label',`Choose date. Selected ${dateLabel(date,{month:'long',day:'numeric',year:'numeric'})}`);
}
export function bindDatePicker(root,{today,onSelect}) {
  const holder=one('[data-role="date-picker"]',root), input=one('#date-input',root), trigger=one('[data-role="date-picker-trigger"]',root);
  if(!holder || !input || !trigger) return;
  const media=window.matchMedia('(min-width:801px) and (pointer:fine)');
  const popup=el('div',{id:'desktop-date-picker',class:'desktop-date-picker',role:'dialog','aria-label':'Choose event date',hidden:true});
  holder.append(popup);
  let visibleMonth=input.value, focusDate=input.value;
  const close=(restore=false)=>{popup.hidden=true;trigger.setAttribute('aria-expanded','false');if(restore)trigger.focus();};
  const position=()=>{
    const box=trigger.getBoundingClientRect(), width=popup.getBoundingClientRect().width, height=popup.getBoundingClientRect().height;
    popup.style.left=`${Math.max(12,Math.min(box.left,window.innerWidth-width-12))}px`;
    popup.style.top=`${Math.max(12,box.bottom+height+8<=window.innerHeight ? box.bottom+8 : box.top-height-8)}px`;
  };
  const choose=date=>{onSelect(date);close(true);};
  const render=(focus=false,control=null)=>{
    const month=visibleMonth.slice(0,7);
    const monthButton=(offset,name)=>el('button',{type:'button',class:'calendar-month-button','aria-label':name,dataset:{monthOffset:offset}},[icon(offset<0?'chevron-left':'chevron-right')]);
    const cells=calendarDays(visibleMonth).map(date=>el('button',{type:'button',class:`calendar-day${date.slice(0,7)!==month?' is-outside':''}${date===input.value?' is-selected':''}`,text:Number(date.slice(-2)),dataset:{date},tabindex:date===focusDate?'0':'-1','aria-label':dateLabel(date,{weekday:'long',month:'long',day:'numeric',year:'numeric'}),'aria-pressed':String(date===input.value),'aria-current':date===today?'date':null}));
    replace(popup,[el('div',{class:'calendar-head'},[monthButton(-1,'Previous month'),el('span',{class:'calendar-month','aria-live':'polite',text:dateLabel(visibleMonth,{month:'long',year:'numeric'})}),monthButton(1,'Next month')]),el('div',{class:'calendar-weekdays','aria-hidden':'true'},['S','M','T','W','T','F','S'].map(day=>el('span',{text:day}))),el('div',{class:'calendar-days'},cells),el('div',{class:'calendar-footer'},[el('button',{type:'button',class:'calendar-today',dataset:{calendarToday:'true'},text:'Today'})])]);
    if(focus) one(control || `[data-date="${focusDate}"]`,popup)?.focus();
    position();
  };
  trigger.addEventListener('click',()=>{
    if(!popup.hidden){close();return;}
    visibleMonth=input.value;focusDate=input.value;popup.hidden=false;trigger.setAttribute('aria-expanded','true');render(true);
  });
  popup.addEventListener('click',event=>{
    const day=event.target.closest('[data-date]');if(day){choose(day.dataset.date);return;}
    const button=event.target.closest('[data-month-offset]');
    if(button){const offset=Number(button.dataset.monthOffset);visibleMonth=shiftCalendarMonth(visibleMonth,offset);focusDate=visibleMonth;render(true,`[data-month-offset="${offset}"]`);return;}
    if(event.target.closest('[data-calendar-today]'))choose(today);
  });
  popup.addEventListener('keydown',event=>{
    if(event.key==='Escape'){event.preventDefault();close(true);return;}
    const day=event.target.closest('[data-date]');if(!day)return;
    let next;
    if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))next=shiftCalendarDay(day.dataset.date,{ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7}[event.key]);
    if(event.key==='PageUp' || event.key==='PageDown')next=shiftCalendarMonth(day.dataset.date,event.key==='PageUp'?-1:1);
    if(event.key==='Home')next=shiftCalendarDay(day.dataset.date,-utc(day.dataset.date).getUTCDay());
    if(event.key==='End')next=shiftCalendarDay(day.dataset.date,6-utc(day.dataset.date).getUTCDay());
    if(next){event.preventDefault();focusDate=next;visibleMonth=next;render(true);}
  });
  root.addEventListener('pointerdown',event=>{if(!holder.contains(event.target))close();});
  holder.addEventListener('focusout',()=>requestAnimationFrame(()=>{if(!holder.contains(document.activeElement))close();}));
  const mode=()=>{close();input.hidden=media.matches;trigger.hidden=!media.matches;holder.classList.toggle('is-custom',media.matches);};
  media.addEventListener('change',mode);
  window.addEventListener('resize',()=>{if(!popup.hidden)position();});
  window.addEventListener('scroll',()=>{if(!popup.hidden)position();},true);
  syncDatePicker(root,input.value);mode();
}
