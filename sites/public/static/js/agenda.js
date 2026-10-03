import { eventTime } from './preferences.js';
/**
 * Weekly schedule.
 *
 * The schedule browses the week containing the selected date and shares one
 * map markers retain location selection. Event rows open their AnchorLink
 * source; separate buttons save events and open walking directions.
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
  const save = el('button', {
    type:'button', class:'agenda-save icon-button',
    'aria-label':`${isSaved(event.date,event.identity_key) ? 'Unsave' : 'Save'} ${event.title}`,
    'aria-pressed':String(isSaved(event.date,event.identity_key)),
    title:`${isSaved(event.date,event.identity_key) ? 'Unsave' : 'Save'} ${event.title}`,
  }, [icon('star')]);
  save.addEventListener('click', () => toggleSaved(event.date,event.identity_key));
  const url = googleWalkingUrl(state.origin, destinationFor(event));
  const directions = url ? el('a', {class:'agenda-directions icon-button', href:url, target:'_blank', rel:'noopener noreferrer', 'aria-label':`Walking directions to ${event.title}`, title:`Walking directions to ${event.title}`}, [icon('directions')]) : null;
  return el('div',{class:'agenda-row'},[row,save,directions]);
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
