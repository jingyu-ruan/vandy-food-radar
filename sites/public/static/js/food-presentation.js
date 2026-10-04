/** Merge the source's food certainty and category into one readable badge. */
/** @param {{food_label:string,food_category:string,food_description?:string|null}} event */
export function foodPresentation(event) {
  const type = event.food_category;
  if (event.food_label === 'Food disputed') return {label:'Food Disputed', tone:'red', detail:type === 'Unspecified' ? '' : `${type.replace(/\b[a-z]/g,letter=>letter.toUpperCase())} Listed`};
  if (event.food_label !== 'Food confirmed') return {label:'Food Unconfirmed', tone:'amber', detail:type === 'Unspecified' ? '' : `${type.replace(/\b[a-z]/g,letter=>letter.toUpperCase())} Listed`};
  if (type === 'Full meal') return {label:'Meal', tone:'green', detail:''};
  if (type === 'Snacks') return {label:'Snacks', tone:'blue', detail:''};
  if (type === 'No food described') return {label:'Free Food', tone:'teal', detail:'Menu Unspecified'};
  return {label:'Free Food', tone:'teal', detail:'Menu Unspecified'};
}
