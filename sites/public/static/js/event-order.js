/** Published scores descend; equal scores use time, title and identity. */
export function compareEventCards(a, b) {
  const cancelled=Number(Boolean(a?.cancelled))-Number(Boolean(b?.cancelled));
  if(cancelled) return cancelled;
  const score=(Number.isFinite(b?.score) ? b.score : -1)-(Number.isFinite(a?.score) ? a.score : -1);
  if(score) return score;
  const time=String(a?.start || '99:99').localeCompare(String(b?.start || '99:99'));
  return time || String(a?.title || '').localeCompare(String(b?.title || ''),'en',{sensitivity:'base'}) || String(a?.identity_key || '').localeCompare(String(b?.identity_key || ''));
}
