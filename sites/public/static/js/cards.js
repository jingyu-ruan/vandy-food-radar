import { icon } from './icons.js';
import { foodPresentation } from './food-presentation.js';
import { eventTime } from './preferences.js';
/**
 * Card rendering and card-level interactions.
 *
 * The server renders the first screen; this module renders every subsequent
 * date so switching days never costs a page load. The markup produced here
 * mirrors `_event_card.html` exactly, so a server-rendered card and a
 * client-rendered one are indistinguishable to the reader and to the CSS.
 *
 * All text arrives from the JSON API and is written with `textContent` through
 * `dom.el`; no event field is ever interpolated into markup.
 */

import { all, el, one, replace } from './dom.js';
import { findEvent, isSaved, state, toggleSaved } from './state.js';

function stars(count) {
  const wrap = el('span', {
    class: 'stars',
    role: 'img',
    'aria-label': `Recommendation ${count} of 5`,
    title: `Recommendation ${count} of 5`,
  });
  for (let index = 0; index < 5; index += 1) {
    wrap.append(el('i', { class: `star ${index < count ? 'on' : 'off'}`, 'aria-hidden': 'true' }));
  }
  return wrap;
}

function fact(label, children, wide = false) {
  return el('div', { class: `fact${wide ? ' fact-wide' : ''}` }, [
    el('dt', { text: label }),
    el('dd', {}, children),
  ]);
}

function placeFact(event) {
  if (event.place) {
    const children = [el('span', { class: 'fact-strong', text: event.place.name })];
    if (event.place.detail) {
      children.push(' ');
      children.push(el('span', { class: 'fact-text', text: event.place.detail }));
    }
    return fact('Place', children);
  }
  if (event.location_listed) {
    return fact('Place', [
      el('span', { class: 'fact-strong', text: event.location_listed }),
      ' ',
      el('span', { class: 'fact-muted', text: 'not matched to a campus building' }),
    ]);
  }
  return fact('Place', [el('span', { class: 'fact-muted', text: 'Not listed' })]);
}

function actionsFor(event) {
  const actions = el('footer', { class: 'card-actions' }, [
    el('button', {
      type: 'button',
      class: 'action action-save icon-button',
      'aria-label': `${isSaved(event.date, event.identity_key) ? 'Unsave' : 'Save'} ${event.title}`,
      title: `${isSaved(event.date, event.identity_key) ? 'Unsave' : 'Save'} ${event.title}`,
      'data-action': 'toggle-save',
      'aria-pressed': String(isSaved(event.date, event.identity_key)),
    }, [icon('star')]),
  ]);
  if (!event.cancelled) {
    const options = el('div',{class:'calendar-options'});
    if (event.calendar && event.calendar.google) {
      options.append(
        el('a', {
          class: 'action',
          href: event.calendar.google,
          rel: 'noopener noreferrer',
          target: '_blank',
          text: 'Google Calendar',
        }),
      );
    }
    if (event.calendar && event.calendar.ics) {
      options.append(
        el('a', { class: 'action', href: event.calendar.ics, text: 'Download .ics' }),
      );
    }
    actions.append(el('details',{class:'calendar-menu'},[el('summary',{class:'action'},[icon('calendar'),el('span',{text:'Calendar'})]),options]));
  }
  if (event.event_url) {
    actions.append(
      el('a', {
        class: 'action',
        href: event.event_url,
        rel: 'noopener noreferrer',
        target: '_blank',
      }, [icon('external-link'), el('span', {text:'Source'})]),
    );
  }
  actions.append(
    el('button', {
      type: 'button',
      class: 'action',
      'data-action': 'toggle-details',
      'aria-expanded': 'false',
    }, [icon('info'), el('span', {dataset:{role:'action-label'}, text:'Details'})]),
  );
  return actions;
}

function detailsFor(event) {
  const details = el('div', { class: 'card-details', hidden: true }, [
    el('p', { class: 'detail-why', text: event.explanation }),
  ]);
  if (event.description) details.prepend(el('p', {class:'detail-description', text:event.description}));
  if (event.sources && event.sources.length) {
    const sources = el('p', { class: 'detail-sources' });
    event.sources.forEach((source, index) => {
      sources.append(
        el('a', {
          href: source.url,
          rel: 'noopener noreferrer',
          target: '_blank',
          text: source.label,
        }),
      );
      if (index < event.sources.length - 1) {
        sources.append(el('span', { class: 'sep', text: ' ' }));
      }
    });
    details.append(sources);
  }
  if (event.conflicts && event.conflicts.length) {
    const list = el('ul', { class: 'detail-conflicts' });
    for (const conflict of event.conflicts) {
      const item = el('li', {}, [
        el('strong', { text: conflict.field }),
        ' ',
        el('span', { text: conflict.values.join('; ') }),
      ]);
      if (conflict.resolution) {
        item.append(' ');
        item.append(el('em', { text: conflict.resolution }));
      }
      list.append(item);
    }
    details.append(list);
  }
  return details;
}

/** Build one card element from an API event object. */
export function renderCard(event) {
  const card = el('article', {
    class: `card is-${event.state}`,
    dataset: {
      identityKey: event.identity_key,
      date: event.date,
      ...(event.place ? { lat: event.place.lat, lng: event.place.lng } : {}),
    },
  });

  card.append(
    el('header', { class: 'card-top' }, [
      el('h3', { class: 'card-title', text: event.title }),
      stars(event.stars || 0),
    ]),
  );

  const when = el('p', { class: 'card-when' }, [
    el('span', { class: 'when-time', text: eventTime(event) }),
  ]);
  if (event.badge) when.append(el('span', { class: 'tag tag-alert', text: event.badge }));
  if (event.change) when.append(el('span', { class: 'tag tag-change', text: event.change }));
  card.append(when);

  const food = foodPresentation(event);
  const foodChildren = [el('span', {class:`chip chip-${food.tone}`}, [food.label])];
  if (food.detail) foodChildren.push(el('span', {class:'food-note',text:food.detail}));
  if (event.food_description) {
    foodChildren.push(el('span', { class: 'fact-text', text: event.food_description }));
  }

  const facts = el('dl', { class: 'card-facts' }, [fact('Food', foodChildren), placeFact(event)]);
  if (event.place && event.location_listed) {
    facts.append(
      fact('Listed as', [el('span', { class: 'fact-text', text: event.location_listed })]),
    );
  }
  facts.append(fact('Walk', [el('span', { class: 'fact-text', 'data-role':'walking', text: event.walking_label })]));
  if (event.rsvp_label !== 'RSVP not stated' || event.rsvp_url) facts.append(
    fact('RSVP', [
      event.rsvp_url
        ? el('a', {
            class: 'fact-link',
            href: event.rsvp_url,
            rel: 'noopener noreferrer',
            target: '_blank',
            text: event.rsvp_label,
          })
        : el('span', { class: 'fact-text', text: event.rsvp_label }),
    ]),
  );
  facts.append(
    fact('Host', [el('span', { class: 'fact-text', text: event.organizer || 'Not listed' })]),
  );
  const accessChildren = [el('span', { class: 'fact-text', text: event.participation.note })];
  facts.append(fact('Participation', accessChildren, true));
  card.append(facts);

  if (event.warnings && event.warnings.length) {
    const warnings = el('ul', { class: 'card-warnings' });
    for (const warning of event.warnings) {
      warnings.append(el('li', { text: warning }));
    }
    card.append(warnings);
  }

  card.append(actionsFor(event));
  card.append(detailsFor(event));
  return card;
}

/** Re-render the whole card grid for the currently loaded day. */
export function renderCards(root) {
  const grid = one('[data-role="card-grid"]', root);
  if (!grid) return;
  if (!state.events.length) {
    const message = state.config && state.config.offline
      ? 'No free-food listings are published for this date. Use \u201cRefresh demo\u201d to reload the fixture corpus.'
      : 'No free-food listings are published for this date.';
    replace(grid, el('p', { class: 'empty', text: message }));
  } else {
    replace(grid, state.events.map(renderCard));
  }
  const count = one('[data-role="card-count"]', root);
  if (count) count.textContent = String(state.events.length);
  syncCardChrome(root);
}

/** Keep save buttons and selection highlighting in step with state. */
export function syncCardChrome(root) {
  for (const card of all('.card', root)) {
    const key = card.dataset.identityKey;
    const date = card.dataset.date;
    const button = one('[data-action="toggle-save"]', card);
    if (button) {
      const saved = isSaved(date, key);
      button.setAttribute('aria-pressed', String(saved));
      button.setAttribute('aria-label', `${saved ? 'Unsave' : 'Save'} ${one('.card-title', card).textContent}`);
      button.title = button.getAttribute('aria-label');
    }
    card.classList.toggle('is-selected', state.selectedKey === key);
  }
}

/**
 * Wire card interactions once, using delegation so client-rendered cards need
 * no extra binding.
 */
export function bindCardEvents(root, { onSelect } = {}) {
  root.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const saveButton = target.closest('[data-action="toggle-save"]');
    if (saveButton) {
      const card = saveButton.closest('.card');
      if (!card) return;
      toggleSaved(card.dataset.date, card.dataset.identityKey);
      return;
    }

    const detailsButton = target.closest('[data-action="toggle-details"]');
    if (detailsButton) {
      const card = detailsButton.closest('.card');
      const panel = card && one('.card-details', card);
      if (panel) {
        const open = panel.hasAttribute('hidden');
        if (open) panel.removeAttribute('hidden');
        else panel.setAttribute('hidden', '');
        one('[data-role="action-label"]', detailsButton).textContent = open ? 'Hide details' : 'Details';
        detailsButton.setAttribute('aria-expanded', String(open));
      }
      return;
    }

    const card = target.closest('.card');
    if (card && onSelect && !target.closest('a') && !target.closest('button')) {
      const key = card.dataset.identityKey;
      onSelect(findEvent(key) ? key : null);
    }
  });
}
