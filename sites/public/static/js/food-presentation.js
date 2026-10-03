/** Merge the source's food certainty and category into one readable badge. */
/** @param {{food_label:string,food_category:string,food_description?:string|null}} event */
export function foodPresentation(event) {
  const type = event.food_category;
  if (event.food_label === 'Food disputed') return {label:'Food disputed', tone:'red', detail:type === 'Unspecified' ? '' : `${type} listed`};
  if (event.food_label !== 'Food confirmed') return {label:'Food unconfirmed', tone:'amber', detail:type === 'Unspecified' ? '' : `${type} listed`};
  if (type === 'Full meal') return {label:'Meal', tone:'green', detail:''};
  if (type === 'Snacks') return {label:'Snacks', tone:'blue', detail:''};
  if (type === 'No food described') return {label:'Free food', tone:'teal', detail:'Food details not listed'};
  return {label:'Free food', tone:'teal', detail:'Food type not listed'};
}
