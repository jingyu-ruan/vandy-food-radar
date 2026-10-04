import {ActionIcon} from './action-icon';
import type {BriefItemJson, CardJson, DayFeedJson} from '@/lib/vfr/viewmodel.ts';
import {BRIEF_COLUMNS, briefRows, eventHref} from '@/public/static/js/brief.js';

export function BriefAssessments({brief,date,events=[]}:{brief:DayFeedJson['brief']|undefined;date:string;events?:CardJson[]}) {
 const rows:(BriefItemJson & {rank:number;cancelled:boolean;walk_detail?:string;source_url?:string|null})[]=briefRows(brief,events,'12');
 return <div className="brief-assessments" data-role="brief-assessments" lang="en" hidden={!rows.length}>
  {rows.length>0 && <>
   <div className="brief-table-scroll" tabIndex={0} role="region" aria-label="Daily Brief event table">
    <table className="brief-table">
     <caption className="visually-hidden">Ranked free-food events for the selected date</caption>
     <thead><tr>{BRIEF_COLUMNS.map(column=><th scope="col" key={column}>{column}</th>)}</tr></thead>
     <tbody>{rows.map(item=><tr key={item.identity_key} data-identity-key={item.identity_key} className={item.cancelled ? 'brief-row-cancelled' : undefined}>
      <td className="brief-rank">{item.rank}</td>
      <th scope="row" className="brief-activity"><div className="brief-event"><a className="brief-event-link brief-event-title" href={eventHref(item.identity_key,date)}>{item.title}</a><span className="brief-event-actions"><a className="brief-event-link brief-event-action" href={eventHref(item.identity_key,date)} title="Show event card" aria-label={`Show event card for ${item.title}`}><ActionIcon name="arrow-down" /></a>{item.source_url && <a className="brief-event-action" href={item.source_url} target="_blank" rel="noopener noreferrer" title="Open source" aria-label={`Open source for ${item.title}`}><ActionIcon name="external-link" /></a>}</span></div>{item.cancelled && <span className="brief-cancelled">Cancelled</span>}</th>
      <td className="brief-time">{item.time}</td><td>{item.food}</td><td>{item.location}</td>
      <td className="brief-walk" data-role="brief-walking" title={item.walk_detail} aria-label={item.walk_detail || 'Walking time unavailable'}>{item.walk}</td>
      <td className="brief-notes">{item.reason}</td>
     </tr>)}</tbody>
    </table>
   </div>
   <p className="brief-scroll-hint">Scroll horizontally to see all columns.</p>
  </>}
 </div>;
}
