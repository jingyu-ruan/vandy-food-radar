/** Present published score components; display preferences never rescore events. */
const LABELS = {food_confirmed:'Food Confirmed', full_meal:'Full Meal', food_specificity:'Menu Specificity', timing:'Meal Timing', walking:'Walking'};
const number = new Intl.NumberFormat('en-US', {maximumFractionDigits:2});
export function compactRatingNote(component) {
  if(component.factor==='food_confirmed')return component.rawValue===1 ? 'Free food confirmed' : component.rawValue===0 ? 'Food disputed' : 'Food unconfirmed';
  if(component.factor==='full_meal')return component.rawValue===1 ? 'Full meal' : component.rawValue===0.4 ? 'Snacks or drinks' : component.rawValue===0 ? 'No food listed' : 'Meal size unspecified';
  if(component.factor==='food_specificity')return component.rawValue===1 ? 'Named food or drink' : component.rawValue===0.75 ? 'Named food provider' : component.rawValue===0.4 ? 'Dietary options listed' : 'Menu unspecified';
  if(component.factor==='timing') {
    const time=component.note?.match(/Starts at (\d{1,2}):(\d{2})/i);
    if(!time)return 'Start time unspecified';
    const hour=Number(time[1]);return `Starts at ${hour%12 || 12}${time[2]==='00'?'':`:${time[2]}`} ${hour<12?'AM':'PM'}`;
  }
  return String(component.note || '').replace(/^about a /i,'').replace(/[.!]+$/,'').trim();
}
/** @param {{date:string, identity_key:string, stars:number, score:number|null, score_components?:Array<{factor:string, rawValue:number, weight:number, contribution:number, note:string}>}} event */
export function ratingPresentation(event) {
  const rows = (event.score_components || []).map(component => ({
    label:LABELS[component.factor] || component.factor,
    weight:`${number.format(component.weight * 100)}%`,
    value:number.format(component.rawValue),
    points:number.format(component.contribution * 100),
    note:compactRatingNote(component),
  }));
  return {
    id:`rating-${event.date}-${event.identity_key}`.replace(/[^a-zA-Z0-9_-]/g, '-'),
    score:Math.max(0, Math.min(5, Number.isFinite(event.score) ? (Math.round(event.score * 50 + Number.EPSILON * 50) / 10) : event.stars || 0)).toFixed(1),
    total:Number.isFinite(event.score) ? `${number.format(event.score * 100)} / 100` : 'Unavailable',
    rows,
    context:'Scores use the published snapshot. Walking and timing reflect the scoring origin and time at publication.',
    scale:'Rating is the weighted total scaled to 5 and rounded to one decimal place.',
  };
}
