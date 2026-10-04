import type {BriefItemJson, CardJson, DayFeedJson} from '@/lib/vfr/viewmodel.ts';
import {BRIEF_COLUMNS, briefContext, briefRows, eventHref} from '@/public/static/js/brief.js';

export function BriefAssessments({brief,date,events=[]}:{brief:DayFeedJson['brief']|undefined;date:string;events?:CardJson[]}) {
 const rows:(BriefItemJson & {rank:number;cancelled:boolean;walk_detail?:string})[]=briefRows(brief,events,'12');
 return <div className="brief-assessments" data-role="brief-assessments" lang="en" hidden={!rows.length}>
  {rows.length>0 && <>
   <p className="brief-context" data-role="brief-context">{briefContext(brief?.origin)}</p>
   <div className="brief-table-scroll" tabIndex={0} role="region" aria-label="Daily Brief activity table">
    <table className="brief-table">
     <caption className="visually-hidden">Ranked free-food activities for the selected date</caption>
     <thead><tr>{BRIEF_COLUMNS.map(column=><th scope="col" key={column}>{column}</th>)}</tr></thead>
     <tbody>{rows.map(item=><tr key={item.identity_key} data-identity-key={item.identity_key} className={item.cancelled ? 'brief-row-cancelled' : undefined}>
      <td className="brief-rank">{item.rank}</td>
      <th scope="row" className="brief-activity"><a className="brief-event-link" href={eventHref(item.identity_key,date)}>{item.title}</a>{item.cancelled && <span className="brief-cancelled">Cancelled</span>}</th>
      <td className="brief-time">{item.time}</td><td>{item.food}</td><td>{item.location}</td>
      <td className="brief-walk" data-role="brief-walking" title={item.walk_detail}>{item.walk}</td>
      <td className="brief-notes">{item.reason}</td>
     </tr>)}</tbody>
    </table>
   </div>
   <p className="brief-scroll-hint">Scroll horizontally to see all columns.</p>
  </>}
 </div>;
}
