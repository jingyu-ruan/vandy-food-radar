/** Rank local campus places and event choices before optional address results. */
export function searchPlaces(query, places, limit = 8) {
  const normalize = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const needle = normalize(query);
  return (places || []).map(place => {
    const names = [place.name, ...(place.aliases || [])].map(normalize);
    const rank = !needle || names.some(name => name.startsWith(needle)) ? 0 : names.some(name => name.includes(needle)) ? 1 : 2;
    return {place, rank};
  }).filter(item => item.rank < 2).sort((a, b) => a.rank - b.rank).slice(0, limit).map(item => item.place);
}
/** Keep endpoint groups together, with alphabetical names inside each group. */
export function groupedSearchPlaces(query, places) {
  const groupOrder = {event:0, campus:1, address:2};
  return searchPlaces(query, places, Infinity).sort((a,b) =>
    (groupOrder[a.kind] ?? 3) - (groupOrder[b.kind] ?? 3) ||
    a.name.localeCompare(b.name, 'en', {sensitivity:'base',numeric:true}));
}
export async function searchAddresses(query, signal) {
  const response=await fetch(`/api/search?${new URLSearchParams({q:query})}`,{signal});
  if (!response.ok) throw new Error('Address search unavailable');
  return response.json();
}
/** Typing never commits an endpoint; stale responses cannot replace current choices. */
export function bindPlaceSearch(input, list, {places, choose, currentLabel, remote, onFocus, onChoose, onCancel, openOnFocus=false, alphabetical=false}) {
  let active=-1, matches=[], timer, controller, revision=0, status='', local=[], query='';
  const stop=()=>{clearTimeout(timer);controller?.abort();revision+=1;};
  const close=()=>{
    stop(); list.hidden=true; input.setAttribute('aria-expanded','false');
    input.removeAttribute('aria-activedescendant');active=-1;
  };
  const commit=place=>{close(); input.blur(); input.value=place.name;onChoose?.();choose(place);};
  const render=()=>{
    list.replaceChildren();
    let group='';
    for (const [index, place] of matches.entries()) {
      if (place.kind && place.kind!==group) {
        group=place.kind;
        const heading=document.createElement('li');heading.className='search-group';heading.setAttribute('role','presentation');
        heading.textContent=group==='event' ? 'Events' : group==='address' ? 'Addresses' : 'Campus Places';list.append(heading);
      }
      const item=document.createElement('li');item.id=`${list.id}-${index}`;
      item.setAttribute('role','option');item.setAttribute('aria-selected',String(index===active));
      const title=document.createElement('span');title.textContent=place.name;item.append(title);
      if (place.detail) {const detail=document.createElement('small');detail.textContent=place.detail;item.append(detail);}
      item.addEventListener('pointerdown',event=>{event.preventDefault();commit(place);});list.append(item);
    }
    if (status || !matches.length) {
      const message=document.createElement('li');message.setAttribute('role','presentation');message.className='search-status';
      message.textContent=status || 'No matching place. Choose a point on the map.';list.append(message);
    }
    list.hidden=false;input.setAttribute('aria-expanded','true');
    if (active>=0) input.setAttribute('aria-activedescendant',`${list.id}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const search=(value=input.value)=>{
    stop();active=-1;query=value.trim();local=alphabetical ? groupedSearchPlaces(query,places()) : searchPlaces(query,places(),16);matches=local;
    status=remote && query.length>=3 ? 'Searching addresses…' : '';render();
    if (!remote || query.length<3 || query.length>160) return;
    const token=revision;
    const lookup=async(retry=true)=>{
      controller=new AbortController();
      try {
        const result=await remote(query,controller.signal);
        if (token!==revision || list.hidden) return;
        if (result.status==='busy' && retry) {timer=setTimeout(()=>lookup(false),1200);return;}
        const addresses=(result.results || []).filter(point=>!local.some(place=>
          Math.abs(place.lat-point.lat)<0.0001 && Math.abs(place.lng-point.lng)<0.0001));
        matches=alphabetical ? groupedSearchPlaces('',[...local,...addresses]) : [...local,...addresses];
        status=result.status==='ok' ? (matches.length ? '' : 'No matching address. Choose a point on the map.') : result.status==='busy' ? 'Address search is busy. Try again or choose a point on the map.' : 'Address search is unavailable. Campus places and map selection still work.';
        render();
      } catch(error) {
        if (token!==revision || error.name==='AbortError') return;
        status='Address search is unavailable. Campus places and map selection still work.';render();
      }
    };
    timer=setTimeout(()=>lookup(),650);
  };
  input.addEventListener('input',()=>search());
  input.addEventListener('focus',()=>{input.select();onFocus?.();if(openOnFocus)search('');});
  input.addEventListener('keydown',event=>{
    if (event.key==='Escape') {event.preventDefault();event.stopPropagation();close();input.value=currentLabel();onCancel?.();}
    if (event.key==='ArrowDown' || event.key==='ArrowUp') {
      event.preventDefault();if(list.hidden)search();if(!matches.length)return;
      active=(active+(event.key==='ArrowDown' ? 1 : matches.length-1)+matches.length)%matches.length;
      render();document.getElementById(`${list.id}-${active}`)?.scrollIntoView({block:'nearest'});
    }
    if(event.key==='Enter') {
      event.preventDefault();if(list.hidden)return;
      const pick=active>=0 ? matches[active] : matches.length===1 ? matches[0] : null;
      if(pick)commit(pick);
    }
  });
  input.addEventListener('blur',()=>{close();input.value=currentLabel();});
}
