/**
 * Weekly schedule.
 *
 * The schedule browses the week containing the selected date and shares one
 * selection with the map: clicking a row selects the event everywhere. Picking
 * a row from another day also moves the selected date, because a card view
 * showing a mixture of days would break the single-date contract.
 */

import { el, one, replace } from './dom.js';
import { isSaved, state, toggleSaved } from './state.js';

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const DAY_LABEL = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

function dayLabel(isoDate) {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return `${WEEKDAY.format(date)} ${DAY_LABEL.format(date)}`;
}

function agendaRow(event, onSelect) {
  const classes = ['agenda-item'];
  if (event.cancelled) classes.push('is-cancelled');
  if (state.selectedKey === event.identity_key) classes.push('is-selected');
  if (isSaved(event.date, event.identity_key)) classes.push('is-saved');

  const row = el(
    'button',
    {
      type: 'button',
      class: classes.join(' '),
      dataset: { identityKey: event.identity_key, date: event.date },
    },
    [
      el('span', { class: 'agenda-time', text: event.time_label }),
      el('span', { class: 'agenda-title', text: event.title }),
    ],
  );
  row.addEventListener('click', () => onSelect(event.date, event.identity_key));
  const save = el('button', {
    type:'button', class:'agenda-save',
    'aria-label':`${isSaved(event.date,event.identity_key) ? 'Unsave' : 'Save'} ${event.title}`,
    'aria-pressed':String(isSaved(event.date,event.identity_key)),
    text:isSaved(event.date,event.identity_key) ? 'Saved' : 'Save',
  });
  save.addEventListener('click', () => toggleSaved(event.date,event.identity_key));
  return el('div',{class:'agenda-row'},[row,save]);
}

/** Render the agenda for the loaded week. */
export function renderAgenda(root, { onSelect }) {
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

  const days = state.week.days.map((day) => {
    const dateClasses = ['agenda-date'];
    if (state.config && day.date === state.config.today) dateClasses.push('is-today');
    const items = el('div', { class: 'agenda-items' });
    if (!day.events.length) {
      items.append(el('p', { class: 'agenda-empty', text: 'No listings' }));
    } else {
      for (const event of [...day.events].sort((a,b)=>(a.start || '99:99').localeCompare(b.start || '99:99') || a.title.localeCompare(b.title))) {
        items.append(agendaRow(event, onSelect));
      }
    }
    return el('section', { class: 'agenda-day' }, [
      el('h3', { class: dateClasses.join(' '), text: dayLabel(day.date) }),
      items,
    ]);
  });

  replace(container, days);
}
