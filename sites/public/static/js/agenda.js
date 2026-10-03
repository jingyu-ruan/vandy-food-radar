import { eventTime } from './preferences.js';
/**
 * Weekly schedule.
 *
 * The schedule browses the week containing the selected date and shares one
 * map markers retain location selection. Event rows open their AnchorLink
 * source; a contextual menu saves events and opens walking directions.
 */

import { el, one, replace } from './dom.js';
import { isSaved, state, toggleSaved } from './state.js';
import { icon } from './icons.js';
import { destinationFor, googleWalkingUrl } from './directions.js';

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const DAY_LABEL = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

function dayLabel(isoDate) {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return `${WEEKDAY.format(date)} ${DAY_LABEL.format(date)}`;
}

function agendaRow(event) {
  const classes = ['agenda-item'];
  if (event.cancelled) classes.push('is-cancelled');
  if (isSaved(event.date, event.identity_key)) classes.push('is-saved');

  const row = el(
    event.event_url ? 'a' : 'div',
    {
      href: event.event_url,
      target: '_blank',
      rel: 'noopener noreferrer',
      class: classes.join(' '),
      dataset: { identityKey: event.identity_key, date: event.date },
    },
    [
      el('span', { class: 'agenda-time', text: eventTime(event) }),
      el('span', { class: 'agenda-title', text: event.title }),
    ],
  );
  const saved = isSaved(event.date, event.identity_key);
  if (saved) row.append(el('span', {class:'agenda-saved', text:'Saved'}));
  const save = el('button', {
    type:'button', class:'action agenda-save',
    'aria-label':`${saved ? 'Unsave' : 'Save'} ${event.title}`,
    'aria-pressed':String(saved),
  }, [icon('star'), el('span', {text:saved ? 'Unsave event' : 'Save event'})]);
  const menu = el('details', {class:'agenda-menu', 'data-action-menu':''}, [
    el('summary', {class:'icon-button', 'aria-label':`Actions for ${event.title}`, title:`Actions for ${event.title}`}, [icon('ellipsis')]),
  ]);
  save.addEventListener('click', () => {
    menu.open = false;
    toggleSaved(event.date, event.identity_key);
    // Saving rebuilds the week. Keep keyboard focus on this row's menu.
    const replacement = Array.from(document.querySelectorAll('.agenda-row')).find(item => item.querySelector('.agenda-item')?.dataset.identityKey === event.identity_key && item.querySelector('.agenda-item')?.dataset.date === event.date);
    replacement?.querySelector('summary')?.focus({preventScroll:true});
  });
  const options = el('div', {class:'agenda-menu-options'}, [save]);
  const url = googleWalkingUrl(state.origin, destinationFor(event));
  if (url) {
    const directions = el('a', {class:'action agenda-directions', href:url, target:'_blank', rel:'noopener noreferrer'}, [icon('directions'), el('span', {text:'Walking directions'})]);
    directions.addEventListener('click', () => {menu.open = false;});
    options.append(directions);
  }
  menu.append(options);
  return el('div', {class:'agenda-row'}, [row, menu]);
}

/** Render the agenda for the loaded week. */
export function futureWeekDays(days, today) {
  return days.filter(day => day.date >= today);
}

export function renderAgenda(root) {
  const container = one('[data-role="agenda"]', root);
  if (!container) return;

  const label = one('[data-role="week-label"]', root);
  if (label && state.weekStart) label.textContent = dayLabel(state.weekStart);

  if (!state.week) {
    replace(container, el('p', { class: 'agenda-empty', text: 'Loading the week\u2026' }));
    return;
  }
  if (state.week.error) {
    replace(
      container,
      el('p', { class: 'agenda-empty', text: `Could not load the week: ${state.week.error}` }),
    );
    return;
  }

  const days = futureWeekDays(state.week.days, state.config.today).map((day) => {
    const dateClasses = ['agenda-date'];
    if (state.config && day.date === state.config.today) dateClasses.push('is-today');
    const items = el('div', { class: 'agenda-items' });
    if (!day.events.length) {
      items.append(el('p', { class: 'agenda-empty', text: 'No listings' }));
    } else {
      for (const event of [...day.events].sort((a,b)=>(a.start || '99:99').localeCompare(b.start || '99:99') || a.title.localeCompare(b.title))) {
        items.append(agendaRow(event));
      }
    }
    return el('section', { class: 'agenda-day' }, [
      el('h3', { class: dateClasses.join(' '), text: dayLabel(day.date) }),
      items,
    ]);
  });

  replace(container, days.length ? days : el('p', {class:'agenda-empty', text:'This week has ended. Choose today or a future date.'}));
}

/** Native disclosure menus work with pointer, keyboard and touch input. */
export function bindAgendaMenus(root) {
  root.addEventListener('click', event => {
    const current = event.target.closest?.('[data-action-menu]');
    for (const menu of root.querySelectorAll('[data-action-menu][open]')) {
      if (menu !== current) menu.open = false;
    }
  });
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const menu = event.target.closest?.('[data-action-menu][open]');
    if (menu) {
      menu.open = false;
      menu.querySelector('summary').focus();
      event.preventDefault();
    }
  });
}
