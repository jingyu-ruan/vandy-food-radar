import type {DayFeedJson} from '@/lib/vfr/viewmodel.ts';
import {eventHref} from '@/public/static/js/brief.js';

export function BriefAssessments({brief,date}:{brief:DayFeedJson['brief']|undefined;date:string}) {
 return <div className="brief-assessments" data-role="brief-assessments" lang="en">
  {(brief?.items || []).map(item=><p key={item.identity_key}><a className="brief-event-link" href={eventHref(item.identity_key,date)}>{item.title}</a>: {item.reason}</p>)}
 </div>;
}
