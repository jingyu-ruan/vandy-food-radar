/** Shared column sizing for one day's table; widths include cell padding. */
export function briefColumnWidths(containerWidth, contentWidths, timePartWidth = (contentWidths[2] || 0) / 2) {
  const compact = containerWidth < 720;
  // Rank, Event, Time, Food, Location, Walk, Notes.
  const limits = compact
    ? [[52,52,0],[150,180,1],[110,132,0],[110,140,1.4],[120,160,1.6],[60,68,0],[170,230,3]]
    : [[52,52,0],[200,300,1],[132,220,0],[120,230,1.4],[140,260,1.6],[64,80,0],[190,340,3]];
  const lines = [1,compact ? 3 : 2,1,2,2,1,2];
  const padding = compact ? 20 : 24;
  const widths = limits.map(([min,max],index) => {
    const content = index === 2 && compact ? timePartWidth : contentWidths[index] || 0;
    const timeInset = index === 2 && !compact ? 8 : 0;
    return Math.max(min,Math.min(max,Math.ceil(content / lines[index] + padding + timeInset)));
  });
  let remaining = Math.floor(containerWidth) - widths.reduce((sum,width)=>sum+width,0);
  // Notes has first priority for spare space; titles stay within a narrower cap.
  while (remaining > 0) {
    const active = limits.map(([,,weight],index)=>({index,weight}))
      .filter(({index,weight})=>weight && widths[index] < limits[index][1]);
    if (!active.length) break;
    const total = active.reduce((sum,{weight})=>sum+weight,0), budget = remaining;
    for (const {index,weight} of active) {
      const extra = Math.min(remaining,limits[index][1]-widths[index],Math.max(1,Math.floor(budget*weight/total)));
      widths[index] += extra;
      remaining -= extra;
    }
  }
  return {widths,compact,tableWidth:widths.reduce((sum,width)=>sum+width,0)};
}

const bindings = new WeakMap();

/** Rebind after date/clock changes; observe the container, not the browser window. */
export function bindBriefLayout(root) {
  bindings.get(root)?.();
  bindings.delete(root);
  const scroll = root.querySelector('.brief-table-scroll'), table = scroll?.querySelector('.brief-table');
  if (!table) return;
  const headers = [...table.querySelectorAll('thead th')];
  const hint = root.querySelector('.brief-scroll-hint');
  const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
  let frame = 0, active = true;
  const update = () => {
    frame = 0;
    if (!active || !scroll.isConnected || !scroll.clientWidth) return;
    const measured = headers.map(()=>0);
    let timePartWidth = 0;
    for (const row of table.rows) {
      [...row.cells].forEach((cell,index)=>{
        const style = getComputedStyle(cell);
        if (context) context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const measure = text=>context ? context.measureText(text).width : text.length * parseFloat(style.fontSize) * 0.55;
        const text = cell.textContent.trim().replace(/\s+/g,' ');
        measured[index] = Math.max(measured[index],measure(text));
        if (index === 2) timePartWidth = Math.max(timePartWidth,...text.split(' – ').map(measure));
      });
    }
    const result = briefColumnWidths(scroll.clientWidth,measured,timePartWidth);
    scroll.dataset.compact = String(result.compact);
    table.style.width = `${result.tableWidth}px`;
    headers.forEach((header,index)=>{header.style.width = `${result.widths[index]}px`;});
    if (hint) hint.hidden = result.tableWidth <= scroll.clientWidth + 1;
  };
  const schedule = () => { if (active && !frame) frame = requestAnimationFrame(update); };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  if (observer) observer.observe(scroll);
  else window.addEventListener('resize',schedule);
  document.fonts?.ready.then(schedule);
  bindings.set(root,()=>{
    active = false;
    observer?.disconnect();
    if (!observer) window.removeEventListener('resize',schedule);
    cancelAnimationFrame(frame);
  });
  update();
}
