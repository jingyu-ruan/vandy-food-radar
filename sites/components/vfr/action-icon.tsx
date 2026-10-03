export function ActionIcon({name}: {name: string}) {
  return <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true"><use href={`/static/icons.svg#${name}`} /></svg>;
}
