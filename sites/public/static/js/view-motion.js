/** A critically damped spring keeps position and velocity when retargeted. */
export function springStep(position, velocity, target, seconds, frequency = 24) {
  const displacement = position - target;
  const coefficient = velocity + frequency * displacement;
  const decay = Math.exp(-frequency * seconds);
  return {
    position: target + (displacement + coefficient * seconds) * decay,
    velocity: (velocity - frequency * coefficient * seconds) * decay,
  };
}

const transitions = new WeakMap();

/** Slide visible panels without snapping when another tab is clicked. */
export function slideViews(viewport, panels, view, previousView, onFinish) {
  let transition = transitions.get(viewport);
  if (!transition) {
    transition = {items:new Map(), frame:null, lastTime:null, cleanups:[]};
    transitions.set(viewport, transition);
  }
  if (onFinish) transition.cleanups.push(onFinish);
  if (transition.frame !== null) cancelAnimationFrame(transition.frame);
  const width = viewport.clientWidth;
  const nextIndex = panels.findIndex(panel => panel.dataset.viewPanel === view);
  const previousIndex = panels.findIndex(panel => panel.dataset.viewPanel === previousView);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const nextPanel = panels[nextIndex];

  const finish = () => {
    for (const panel of panels) {
      panel.hidden = panel !== nextPanel;
      panel.inert = false;
      panel.classList.remove('is-leaving');
      panel.style.transform = '';
      panel.style.willChange = '';
    }
    viewport.classList.remove('is-transitioning');
    viewport.style.minHeight = '';
    transition.items.clear();
    transition.frame = null;
    for (const cleanup of transition.cleanups.splice(0)) cleanup();
  };
  if (reduced || !width || !previousView) {finish(); return;}

  for (const [index, panel] of panels.entries()) {
    let item = transition.items.get(panel);
    if (!item && (panel === nextPanel || index === previousIndex)) {
      item = {position:index === previousIndex ? 0 : Math.sign(nextIndex - previousIndex) * width, velocity:0};
      transition.items.set(panel, item);
    }
    if (!item) continue;
    item.target = index === nextIndex ? 0 : Math.sign(index - nextIndex) * width;
    panel.hidden = false;
    panel.inert = panel !== nextPanel;
    panel.classList.toggle('is-leaving', panel !== nextPanel);
    panel.style.willChange = 'transform';
    panel.style.transform = `translate3d(${item.position}px,0,0)`;
  }
  viewport.style.minHeight = `${nextPanel.getBoundingClientRect().height}px`;
  viewport.classList.add('is-transitioning');
  transition.lastTime = performance.now();
  const tick = time => {
    const seconds = Math.min((time - transition.lastTime) / 1000, 0.064);
    transition.lastTime = time;
    let settled = true;
    for (const [panel, item] of transition.items) {
      const step = springStep(item.position, item.velocity, item.target, seconds);
      item.position = step.position;
      item.velocity = step.velocity;
      panel.style.transform = `translate3d(${item.position}px,0,0)`;
      if (Math.abs(item.position - item.target) > 0.5 || Math.abs(item.velocity) > 5) settled = false;
    }
    if (settled) finish();
    else transition.frame = requestAnimationFrame(tick);
  };
  transition.frame = requestAnimationFrame(tick);
}
