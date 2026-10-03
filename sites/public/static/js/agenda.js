import { eventTime } from './preferences.js';
/**
 * Weekly schedule.
 *
 * Event rows are semantic buttons that select the event and pan the map.
 * A filled gold star beside the ellipsis unsaves saved events; unsaved events
 * offer Save in the contextual menu. Source links and walking directions live
 * inside the ellipsis menu.
 */

import { el, one, replace } from './dom.js';
import { isSaved, state, toggleSaved } from './state.js';
import { icon } from './icons.js';
import { destinationFor, googleWalkingUrl } from './directions.js';

/** @type {((date:string, key:string)=>void)|null} */
let _onSelect = null;

const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const DAY_LABEL = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

function dayLabel(isoDate) {
  const date = new Date(`${isoDate}T00:00:00`);
  if (Number.isNaN(date.getTime())) return isoDate;
  return `${WEEKDAY.format(date)} ${DAY_LABEL.format(date)}`;
}

function agendaRow(event) {
  const saved = isSaved(event.date, event.identity_key);
  const selected = state.selectedKey === event.identity_key;
  const hasPlace = Boolean(event.place);

  // --- primary row: a button that selects the event ---
  const classes = ['agenda-item'];
  if (event.cancelled) classes.push('is-cancelled');
  if (saved) classes.push('is-saved');
  if (selected) classes.push('is-selected');

  const row = el('button', {
    type: 'button',
    class: classes.join(' '),
    dataset: { identityKey: event.identity_key, date: event.date },
    'aria-pressed': String(selected),
  }, [
    el('span', { class: 'agenda-time', text: eventTime(event) }),
    el('span', { class: 'agenda-title', text: event.title }),
  ]);

  // Inline feedback for unresolved locations
  if (selected && !hasPlace) {
    row.append(el('span', { class: 'agenda-location-note', text: event.location_listed
      ? `${event.location_listed}. Location not mapped` : 'Location not listed' }));
  }

  // Selection handler — wired through the module-level callback
  row.addEventListener('click', (e) => {
    // Never trigger selection from star or menu clicks that bubble
    if (e.target.closest('.agenda-star') || e.target.closest('.agenda-menu')) return;
    if (_onSelect) _onSelect(event.date, event.identity_key);
    if (state.view === 'schedule') findRow(event.date, event.identity_key)?.querySelector('.agenda-item')?.focus({preventScroll:true});
  });

  // Keyboard: Enter/Space are native for buttons. We only add Escape to
  // deselect.
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.selectedKey === event.identity_key) {
      if (_onSelect) _onSelect(event.date, null);
      e.preventDefault();
    }
  });

  // --- gold star for saved events (unsaves on click) ---
  let star = null;
  if (saved) {
    star = el('button', {
      type: 'button',
      class: 'icon-button agenda-star',
      'aria-label': `Unsave ${event.title}`,
      title: `Unsave ${event.title}`,
    }, [icon('star')]);
    star.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSaved(event.date, event.identity_key);
      // Focus retention: after rerender, focus the star or summary of the same row
      requestAnimationFrame(() => {
        const replacement = findRow(event.date, event.identity_key);
        const target = replacement?.querySelector('.agenda-star') || replacement?.querySelector('summary');
        target?.focus({ preventScroll: true });
      });
    });
  }

  // --- ellipsis menu ---
  const menu = el('details', { class: 'agenda-menu', 'data-action-menu': '' }, [
    el('summary', {
      class: 'icon-button',
      'aria-label': `Actions for ${event.title}`,
      title: `Actions for ${event.title}`,
    }, [icon('ellipsis')]),
  ]);
  const options = el('div', { class: 'agenda-menu-options', popover:'auto', 'aria-label':`Actions for ${event.title}` });
  const positionMenu = () => {
    const anchor = menu.querySelector('summary').getBoundingClientRect();
    const width = Math.min(260, window.innerWidth - 24);
    options.style.width = `${width}px`;
    const height = options.getBoundingClientRect().height;
    options.style.left = `${Math.max(12, Math.min(anchor.right-width, window.innerWidth-width-12))}px`;
    options.style.top = `${Math.max(12, anchor.bottom+height+8 > window.innerHeight ? anchor.top-height-4 : anchor.bottom+4)}px`;
  };
  menu.addEventListener('toggle', () => {
    if (menu.open && !options.matches(':popover-open')) {options.showPopover();positionMenu();}
    else if (!menu.open && options.matches(':popover-open')) options.hidePopover();
  });
  options.addEventListener('toggle', () => {if (!options.matches(':popover-open')) menu.open=false;});
  // Scroll/resize can move the trigger; close rather than leave a detached menu.
  options.addEventListener('beforetoggle', event => {
    if (event.newState === 'open') {
      window.addEventListener('resize', closeMenu);
      document.addEventListener('scroll', closeMenu, true);
    } else {
      window.removeEventListener('resize', closeMenu);
      document.removeEventListener('scroll', closeMenu, true);
    }
  });
  function closeMenu(event) {if (event.type === 'resize' || !options.contains(event.target)) menu.open=false;}

  // Save appears only for unsaved events
  if (!saved) {
    const save = el('button', {
      type: 'button', class: 'action agenda-save',
      'aria-label': `Save ${event.title}`,
    }, [icon('star'), el('span', { text: 'Save Event' })]);
    save.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.open = false;
      toggleSaved(event.date, event.identity_key);
      requestAnimationFrame(() => {
        const replacement = findRow(event.date, event.identity_key);
        const target = replacement?.querySelector('.agenda-star') || replacement?.querySelector('summary');
        target?.focus({ preventScroll: true });
      });
    });
    options.append(save);
  }

  // Source link (moved from the primary row)
  if (event.event_url) {
    const source = el('a', {
      class: 'action agenda-source',
      href: event.event_url,
      target: '_blank',
      rel: 'noopener noreferrer',
    }, [icon('external-link'), el('span', { text: 'Source on AnchorLink' })]);
    source.addEventListener('click', (e) => { e.stopPropagation(); menu.open = false; });
    options.append(source);
  }

  // Walking Directions
  const url = googleWalkingUrl(state.origin, destinationFor(event));
  if (url) {
    const directions = el('a', {
      class: 'action agenda-directions',
      href: url, target: '_blank', rel: 'noopener noreferrer',
    }, [icon('directions'), el('span', { text: 'Walking Directions' })]);
    directions.addEventListener('click', (e) => { e.stopPropagation(); menu.open = false; });
    options.append(directions);
  }

  menu.append(options);

  const rowContainer = el('div', { class: `agenda-row${selected ? ' is-selected' : ''}` });
  rowContainer.append(row);
  if (star) rowContainer.append(star);
  rowContainer.append(menu);
  return rowContainer;
}

function findRow(date, identityKey) {
  return Array.from(document.querySelectorAll('.agenda-row')).find(
    r => r.querySelector('.agenda-item')?.dataset.identityKey === identityKey &&
         r.querySelector('.agenda-item')?.dataset.date === date
  );
}

/** Render the agenda for the loaded week. */
export function futureWeekDays(days, today) {
  return days.filter(day => day.date >= today);
}

export function renderAgenda(root) {
  const container = one('[data-role="agenda"]', root);
  if (!container) return;
  const scroll = container.dataset.week === state.weekStart ? container.scrollTop : 0;
  const focused = container.contains(document.activeElement) ? document.activeElement.closest('.agenda-row')?.querySelector('.agenda-item')?.dataset : null;
  container.dataset.week = state.weekStart;

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

  const days = futureWeekDays(state.week.days, state.config.today).map((day, dayIndex) => {
    const dateClasses = ['agenda-date'];
    if (state.config && day.date === state.config.today) dateClasses.push('is-today');
    const items = el('div', { class: 'agenda-items' });
    if (!day.events.length) {
      items.append(el('p', { class: 'agenda-empty', text: 'No listings' }));
    } else {
      for (const event of [...day.events].sort((a, b) => (a.start || '99:99').localeCompare(b.start || '99:99') || a.title.localeCompare(b.title))) {
        items.append(agendaRow(event));
      }
    }
    const section = el('section', { class: `agenda-day${dayIndex === 0 ? ' is-first' : ''}` }, [
      el('h3', { class: dateClasses.join(' '), text: dayLabel(day.date) }),
      items,
    ]);
    return section;
  });

  replace(container, days.length ? days : el('p', { class: 'agenda-empty', text: 'This week has ended. Choose today or a future date.' }));
  container.scrollTop = scroll;
  if (focused) findRow(focused.date, focused.identityKey)?.querySelector('.agenda-item')?.focus({preventScroll:true});
}

/** Set the selection callback used by agenda rows. */
export function setAgendaSelectHandler(handler) {
  _onSelect = handler;
}

/** Native disclosure menus work with pointer, keyboard and touch input. */
export function bindAgendaMenus(root) {
  root.addEventListener('click', event => {
    const current = event.target.closest?.('[data-action-menu]');
    for (const menu of root.querySelectorAll('[data-action-menu][open]')) {
      if (menu !== current) menu.open = false;
    }
  }, true);
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
