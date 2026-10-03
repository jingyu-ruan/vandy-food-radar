/** Search the verified campus dataset without sending keystrokes to a service. */
export function searchPlaces(query, places, limit = 8) {
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const needle = normalize(query);
  return (places || []).map(place => {
    const names = [place.name, ...(place.aliases || [])].map(normalize);
    const rank = !needle || names.some(name => name.startsWith(needle)) ? 0 : names.some(name => name.includes(needle)) ? 1 : 2;
    return {place, rank};
  }).filter(item => item.rank < 2).sort((a, b) => a.rank - b.rank).slice(0, limit).map(item => item.place);
}

/** A keyboard-accessible campus combobox. Typing never changes an endpoint. */
export function bindPlaceSearch(input, list, {places, choose, currentLabel}) {
  let active = -1;
  let matches = [];
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const commit = place => {
    close();
    input.value = place.name;
    choose(place);
  };
  const render = () => {
    list.replaceChildren();
    for (const [index, place] of matches.entries()) {
      const item = document.createElement('li');
      item.id = `${list.id}-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === active));
      item.textContent = place.name;
      item.addEventListener('pointerdown', event => {event.preventDefault(); commit(place);});
      list.append(item);
    }
    if (!matches.length) {
      const empty = document.createElement('li');
      empty.setAttribute('role', 'presentation');
      empty.textContent = 'No matching campus building. Choose a point on the map.';
      list.append(empty);
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const search = () => {active = -1; matches = searchPlaces(input.value, places()); render();};
  input.addEventListener('input', search);
  input.addEventListener('focus', () => {input.select();});
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); close(); input.value = currentLabel();}
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) {matches = searchPlaces(input.value, places()); active = -1;}
      if (!matches.length) return;
      active = (active + (event.key === 'ArrowDown' ? 1 : matches.length - 1) + matches.length) % matches.length;
      render();
      list.children[active]?.scrollIntoView({block:'nearest'});
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (list.hidden) return;
      const pick = active >= 0 ? matches[active] : matches.length === 1 ? matches[0] : null;
      if (pick) commit(pick);
    }
  });
  input.addEventListener('blur', () => {close(); input.value = currentLabel();});
}
