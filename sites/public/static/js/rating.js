/** Present published score components; display preferences never rescore events. */
const LABELS = {
  food_confirmed:'Food confirmed', full_meal:'Full meal', food_specificity:'Description detail',
  rsvp_likelihood:'RSVP likelihood', timing:'Timing', walking:'Walking',
  confidence:'Verification confidence', participation:'Participation convenience',
};
const number = new Intl.NumberFormat('en-US', {maximumFractionDigits:2});
/** @param {{date:string, identity_key:string, stars:number, score:number|null, score_components?:Array<{factor:string, rawValue:number, weight:number, contribution:number, note:string}>}} event */
export function ratingPresentation(event) {
  const rows = (event.score_components || []).map(component => ({
    label:LABELS[component.factor] || component.factor,
    weight:`${number.format(component.weight * 100)}%`,
    value:number.format(component.rawValue),
    points:number.format(component.contribution * 100),
    note:component.note,
  }));
  return {
    id:`rating-${event.date}-${event.identity_key}`.replace(/[^a-zA-Z0-9_-]/g, '-'),
    score:Math.max(0, Math.min(5, event.stars || 0)),
    total:Number.isFinite(event.score) ? `${number.format(event.score * 100)}/100` : 'Unavailable',
    rows,
    context:'Scores use the published snapshot. Walking and timing reflect the scoring origin and time at publication.',
    scale:'Rating is the weighted total scaled to 5 and rounded.',
  };
}
