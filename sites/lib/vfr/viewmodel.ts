import {compareEventCards} from "../../public/static/js/event-order.js";
import { displayFields } from "./display.ts";
import { intelligenceHash, intelligenceInputs, specificFoodItems } from "./intelligence.ts";
import type { AiState } from "./intelligence.ts";
/**
 * View model shared by the server-rendered page and the JSON API.
 *
 * One assembly path builds every card, so the first paint and every later
 * client fetch describe the same events in the same words. The JSON shape is
 * the snake_case `DayFeed` contract of the Python reference
 * (`vandy_food_radar/web/viewmodel.py`), which the browser modules under
 * `public/static/js/` consume unchanged.
 *
 * Two editorial rules live here rather than in markup:
 *
 * - Only material warnings are shown: cancellation, a genuine cross-source
 *   conflict about when/where/food/RSVP, a time or venue change detected
 *   within the last 24 hours, and explicit participation limits. The routine
 *   "partially verified" state and the "New" marker are not badges.
 * - Nothing is asserted that a source did not publish. Coordinates come only
 *   from the curated campus dataset, participation only from matched text, and
 *   external links are dropped unless they are absolute http(s).
 */

import { isLiveMaterialChange } from "./changes.ts";
import type { ChangeRecord } from "./changes.ts";
import type { Config } from "./config.ts";
import { foodExcerpt, namedFoodItems } from "./excerpts.ts";
import { googleCalendarUrl } from "./ics.ts";
import { ChangeKind, FoodCategory, FoodConfirmed, VerificationState } from "./models.ts";
import type { Conflict, Event } from "./models.ts";
import { assessParticipation, participationInputFor, participationWarnings } from "./participation.ts";
import { placeDisplayName } from "./places.ts";
import type { PlaceDataset } from "./places.ts";
import { recommendationStars } from "./ranking.ts";
import type { FeedSnapshot, StoredEvent, StoredSource } from "./repository.ts";
import { haversineMetres, minutesForMetres } from "./routing.ts";
import { buildBrief, formatClock } from "./summary.ts";
import type { DailyBrief } from "./summary.ts";

const SAFE_PROTOCOLS = new Set(["http:", "https:"]);

/** Fields whose disagreement changes what a reader should do. */
const MATERIAL_CONFLICT_FIELDS = new Set([
  "eventDate",
  "startTime",
  "endTime",
  "location",
  "foodConfirmed",
  "rsvpRequired",
]);

const FOOD_LABELS: Record<FoodConfirmed, string> = {
  confirmed: "Food confirmed",
  unconfirmed: "Food unconfirmed",
  contradicted: "Food disputed",
};

const CATEGORY_LABELS: Record<FoodCategory, string> = {
  full_meal: "Full meal",
  snacks_or_refreshments: "Snacks",
  unspecified: "Unspecified",
  none: "No food described",
};

const SOURCE_LABELS: Record<string, string> = {
  anchor_link: "AnchorLink",
  google_calendar: "Calendar",
  official_page: "Official page",
};

const CHANGE_LABELS: Partial<Record<ChangeKind, string>> = {
  time_changed: "Time changed",
  venue_changed: "Venue changed",
  cancelled: "Cancelled",
};

export type PlaceJson = {
  name: string;
  lat: number;
  lng: number;
  source_url: string | null;
  detail: string | null;
};

export type CardJson = {
  identity_key: string;
  title: string;
  date: string;
  stars: number;
  score: number | null;
  score_components: {factor:string; rawValue:number; weight:number; contribution:number; note:string}[];
  time_label: string;
  start: string | null;
  end: string | null;
  food_label: string;
  food_category: string;
  food_description: string | null;
  food_items?: string[];
  description: string | null;
  location_listed: string | null;
  place: PlaceJson | null;
  rsvp_label: string;
  rsvp_url: string | null;
  organizer: string | null;
  participation: { level: string; note: string; certain: boolean; warnings: string[]; ai_note?: string; ai_evidence?: string };
  walking_label: string;
  sources: { label: string; url: string }[];
  event_url: string | null;
  explanation: string;
  conflicts: { field: string; values: string[]; resolution: string | null }[];
  badge: string | null;
  change: string | null;
  cancelled: boolean;
  state: string;
  warnings: string[];
  calendar: { google: string | null; ics: string | null };
};

export type BriefItemJson = {
  identity_key:string; title:string; url:string|null; time:string; food:string; location:string;
  address:string; walk:string; route_url:string|null; rsvp:string; participation:string;
  sources:string; conflicts:string; reason:string;
};

export type DayState = "ok" | "empty" | "uninitialized";

export type DayFeedJson = {
  date: string;
  state: DayState;
  published_at: string | null;
  event_count: number;
  brief: { headline: string; sentences: string[]; text: string; content_hash: string; source?: string; generated_at?: string; model?:string; origin?:string; highlights?:{identityKey:string; text:string}[]; items?:BriefItemJson[] };
  events: CardJson[];
};

export type ViewContext = {
  aiState?: AiState | null;
  config: Config;
  places: PlaceDataset;
  nowMs: number;
};

/** Return `url` only when it is an absolute http(s) URL with a host. */
export function safeUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  const candidate = url.trim();
  try {
    const parsed = new URL(candidate);
    if (!SAFE_PROTOCOLS.has(parsed.protocol) || !parsed.host) return null;
    return candidate;
  } catch {
    return null;
  }
}

function minutesOf(hhmm: string): number {
  const [hour, minute] = hhmm.split(":").map(Number);
  return hour * 60 + minute;
}

/** "6 PM – 8 PM", with an end at or before the start marked as next day. */
export function formatTimeRange(start: string | null, end: string | null): string {
  if (start === null) return "Time not listed";
  if (end === null) return formatClock(start);
  if (minutesOf(end) <= minutesOf(start)) {
    return `${formatClock(start)} \u2013 ${formatClock(end)} (next day)`;
  }
  return `${formatClock(start)} \u2013 ${formatClock(end)}`;
}

function rsvpLabel(event: Event): string {
  if (event.rsvpRequired === null) return "RSVP Not Stated";
  if (!event.rsvpRequired) return "No RSVP Needed";
  if (event.rsvpLinkOk === false) return "RSVP Required (link looks broken)";
  return "RSVP Required";
}

function words(fieldName: string): string {
  return fieldName
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function conflictView(conflict: Conflict) {
  return {
    field: words(conflict.fieldName),
    values: conflict.competingValues.map(
      (value) => `${value.sourceId.replace(/_/g, " ")}: ${displayValue(value.value)}`,
    ),
    resolution: conflict.resolution,
  };
}

function sourceLinks(event: Event, sources: StoredSource[]): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const url = safeUrl(source.sourceUrl);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    links.push({
      label: SOURCE_LABELS[source.sourceId] ?? source.sourceId.replace(/_/g, " "),
      url,
    });
  }
  const eventUrl = safeUrl(event.eventUrl);
  if (eventUrl !== null && !seen.has(eventUrl)) links.push({ label: "Event page", url: eventUrl });
  return links;
}

function walkingLabelFor(config: Config, place: PlaceJson | null): string {
  if (place === null || config.locationProvider === "null") return "Walking time unavailable";
  const reference = config.referenceLocation;
  const minutes = minutesForMetres(
    haversineMetres({ lat: reference.lat, lng: reference.lng }, place),
  );
  return `${minutes} min estimate from ${reference.label}`;
}

/** The change worth labelling on a card, if any. "New" never is. */
function visibleChange(change: ChangeRecord | null, context: ViewContext): ChangeKind | null {
  if (!change) return null;
  if (change.kind === ChangeKind.CANCELLED) return change.kind;
  return isLiveMaterialChange(change, context.nowMs, context.config.changeWarningMs)
    ? change.kind
    : null;
}

/** Calendar download path, scoped to the event's own published date. */
export function icsPath(event: Event): string | null {
  if (!event.anchorlinkId || !/^[1-9][0-9]{0,18}$/.test(event.anchorlinkId)) return null;
  return `/api/calendar/${event.anchorlinkId}?date=${encodeURIComponent(event.eventDate)}`;
}

/** Assemble one card from a published event. */
export function buildCard(stored: StoredEvent, context: ViewContext): CardJson {
  const { event } = stored;
  const resolved = context.places.resolve(event.location);
  const place: PlaceJson | null = resolved
    ? {
        name: resolved.place.name,
        lat: resolved.place.point.lat,
        lng: resolved.place.point.lng,
        source_url: safeUrl(resolved.place.sourceUrl),
        detail: resolved.detail,
      }
    : null;
  const assessment = assessParticipation(participationInputFor(event, stored.sources));
  const cancelled = event.verificationState === VerificationState.CANCELLED;
  const materialConflicts = stored.conflicts.filter((conflict) =>
    MATERIAL_CONFLICT_FIELDS.has(conflict.fieldName),
  );
  const changeKind = visibleChange(stored.change, context);

  const warnings: string[] = [];
  if (cancelled) warnings.push("This listing is cancelled.");
  if (changeKind === ChangeKind.TIME_CHANGED) {
    warnings.push("The listed time changed since the last refresh.");
  }
  if (changeKind === ChangeKind.VENUE_CHANGED) {
    warnings.push("The listed venue changed since the last refresh.");
  }
  if (materialConflicts.length) {
    const fields = [...new Set(materialConflicts.map((c) => words(c.fieldName)))].sort();
    warnings.push(`Sources disagree on ${fields.join(", ")}; check the source listing.`);
  }
  if (event.foodConfirmed === FoodConfirmed.CONTRADICTED) {
    warnings.push("Sources disagree about whether food is provided.");
  }
  warnings.push(...participationWarnings(assessment));

  let badge: string | null = null;
  if (cancelled) badge = "Cancelled";
  else if (event.verificationState === VerificationState.CONFLICTING && materialConflicts.length) {
    badge = "Conflicting details";
  }

  const calendarLocation = resolved ? placeDisplayName(resolved) : event.location;
  return displayFields({
    identity_key: event.identityKey,
    title: event.title,
    date: event.eventDate,
    stars: recommendationStars(event.scoreTotal),
    score: event.scoreTotal,
    score_components: stored.components.map(component => ({...component})),
    time_label: formatTimeRange(event.startTime, event.endTime).replace("Time not listed","Time Not Listed"),
    start: event.startTime ? `${event.startTime}:00` : null,
    end: event.endTime ? `${event.endTime}:00` : null,
    food_label: FOOD_LABELS[event.foodConfirmed] ?? "Food unconfirmed",
    food_category: CATEGORY_LABELS[event.foodCategory] ?? "Unspecified",
    food_description: foodExcerpt(event.foodDescription),
    description: event.foodDescription,
    location_listed: event.location,
    place,
    rsvp_label: rsvpLabel(event),
    rsvp_url: safeUrl(event.rsvpUrl),
    organizer: event.organizer,
    participation: {
      level: assessment.level,
      note: assessment.note,
      certain: assessment.certain,
      warnings: participationWarnings(assessment),
    },
    walking_label: walkingLabelFor(context.config, place),
    sources: sourceLinks(event, stored.sources),
    event_url: safeUrl(event.eventUrl),
    explanation: stored.explanation,
    conflicts: stored.conflicts.map(conflictView),
    badge,
    change: changeKind ? (CHANGE_LABELS[changeKind] ?? null) : null,
    cancelled,
    state: event.verificationState,
    warnings,
    calendar: {
      google: googleCalendarUrl(event, {
        timezone: context.config.timezone,
        location: calendarLocation,
      }),
      ics: icsPath(event),
    },
  });
}

function briefJson(brief: DailyBrief): DayFeedJson["brief"] {
  return displayFields({
    headline: brief.headline,
    sentences: [...brief.sentences],
    text: brief.text,
    content_hash: brief.contentHash,
  });
}

/**
 * Build the strictly single-day feed for `date`.
 *
 * Only events whose own date is `date` are included, as a defensive check on
 * top of the date-scoped query, so a selected date can never show another
 * day's listings.
 */
export async function buildDayFeed(
  date: string,
  snapshot: FeedSnapshot | null,
  context: ViewContext,
): Promise<DayFeedJson> {
  const events = (snapshot?.events ?? []).filter((stored) => stored.event.eventDate === date);
  const cards = events.map((stored) => buildCard(stored, context)).sort(compareEventCards);
  let brief: DayFeedJson["brief"];
  if (snapshot === null) {
    // Never published is not the same as a quiet day, and the brief says so.
    const empty = await buildBrief(date, []);
    brief = {
      headline: "Not yet published",
      sentences: ["No listing has been published for this date yet."],
      text: "No listing has been published for this date yet.",
      content_hash: empty.contentHash,
    };
  } else {
    brief = briefJson(await buildBrief(date, events.map((stored) => stored.event)));
    const ai = context.aiState?.result;
    if (ai && ai.date === date && ai.model === context.config.gemini.model &&
      ai.hash === await intelligenceHash(date,intelligenceInputs(events))) {
      brief = {...brief,text:ai.brief,highlights:ai.highlights,sentences:[ai.brief],content_hash:ai.hash,source:"gemini",generated_at:ai.generatedAt,model:ai.model};
      for (const card of cards) {
        const food = ai.foods?.find(f=>f.identityKey===card.identity_key);
        if (food) {card.food_items=specificFoodItems(food.items);if (card.food_items.length) card.food_description=card.food_items.join(", ");}
        const trait = ai.traits.find(t=>t.identityKey===card.identity_key);
        if (trait) {card.participation.ai_note = trait.note; card.participation.ai_evidence = trait.evidence;}
      }
    }
  }
  if (snapshot && cards.length) {
    const ai=context.aiState?.result;
    brief.origin=context.config.referenceLocation.label;
    brief.items=cards.map(card=>briefItem(card,cards,context,brief.source==='gemini' ? ai?.recommendations?.find(item=>item.identityKey===card.identity_key)?.reason : undefined));
    if (brief.source!=='gemini') {
      brief.source='rules';
      brief.text=ruleTakeaway(cards);
      const pick=cards.find(card=>!card.cancelled);
      brief.highlights=pick ? [{identityKey:pick.identity_key,text:brief.text.replace(/, starting at [^.]+\./,'.')}] : [];
      brief.sentences=[brief.text];
    }
  }
  return {
    date,
    state: snapshot === null ? "uninitialized" : cards.length ? "ok" : "empty",
    published_at: snapshot?.publishedAt ?? null,
    event_count: cards.length,
    brief,
    events: cards,
  };
}

/** Browser configuration. Deliberately free of every secret. */
export function clientConfig(
  config: Config,
  today: string,
  selected: string,
  routingAvailable: boolean,
): Record<string, unknown> {
  return {
    timezone: config.timezone,
    today,
    selected_date: selected,
    offline: false,
    week_length: 7,
    reference: {
      label: config.referenceLocation.label,
      lat: config.referenceLocation.lat,
      lng: config.referenceLocation.lng,
    },
    routing_available: routingAvailable,
    card_routing_available: Boolean(config.routing.apiKey),
    dwell_minutes: config.itinerary.dwellMinutes,
    max_exact_stops: config.itinerary.maxExactStops,
    max_waypoints: config.routing.maxWaypoints,
    refresh_day_choices: [1, 2, 7],
  };
}

/**
 * Serialize for a `<script type="application/json">` element. `<`, `>`, `&`,
 * and the JavaScript line separators are escaped, so no value can close the
 * element or be parsed as markup.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** "a", "a and b", "a, b and c" for short source-derived lists. */
function listPhrase(items:string[]):string {
  return items.length<3 ? items.join(" and ") : `${items.slice(0,-1).join(", ")} and ${items[items.length-1]}`;
}

/**
 * Rule-based opening when no matching model result exists: one concrete pick,
 * the highest-ranked listing that is not cancelled, described only with
 * published fields. Menus come from named source items and access conditions
 * only from a stated RSVP requirement; nothing is inferred. Wording is
 * date-neutral because the selected date need not be today.
 */
export function ruleTakeaway(cards:CardJson[]):string {
  const pick=cards.find(card=>!card.cancelled);
  if (!pick) return "Every listing for this date is marked cancelled, so there is no event to recommend.";
  const place=pick.place ? pick.place.name+(pick.place.detail ? `, ${pick.place.detail}` : "") : pick.location_listed;
  const start=pick.start ? formatClock(pick.start.slice(0,5)) : null;
  const opening=`Top pick: ${pick.title}${place ? ` at ${place}` : ""}${start ? `, starting at ${start}` : ""}.`;
  const named=specificFoodItems(pick.food_items?.length ? pick.food_items : namedFoodItems(pick.description));
  const food=named.length ? `The listing names ${listPhrase(named.slice(0,3))}.`
    : pick.food_category==="Full meal" ? "The listing advertises a meal."
    : pick.food_category==="Snacks" ? "The listing advertises light refreshments." : "";
  const overlap=pick.start && pick.end ? cards.find(other=>other.identity_key!==pick.identity_key && !other.cancelled &&
    other.start && other.end && pick.start!<other.end && other.start<pick.end!) : undefined;
  const tradeoff=/^RSVP Required/i.test(pick.rsvp_label) ? "RSVP is required, so register before you go."
    : overlap ? `It overlaps ${overlap.title}, so you may need to choose.`
    : pick.participation.level==="structured" ? "Plan to join the scheduled program rather than only stopping by for food." : "";
  return [opening,food,tradeoff].filter(Boolean).join(" ");
}

function briefItem(card:CardJson, cards:CardJson[], context:ViewContext, aiReason?:string):BriefItemJson {
  const reference=context.config.referenceLocation;
  const walk=card.place ? minutesForMetres(haversineMetres(reference,card.place)) : null;
  const named=card.food_items?.length ? card.food_items : namedFoodItems(card.description);
  const menu=named.length ? named.join(", ") : "Food/Menu Not Specified";
  const location=card.location_listed || card.place?.name || "Location Not Listed";
  const address=/\b\d{2,5}\s+.+\b(?:avenue|ave|street|st|road|rd|drive|dr|boulevard|blvd)\b/i.test(location) ? location : "Full Street Address Unverified";
  const destination=card.place ? `${card.place.lat},${card.place.lng}` : card.location_listed ? `${location}, Vanderbilt University, Nashville, TN` : null;
  const params=destination ? new URLSearchParams({api:"1",origin:reference.label==="2320 West End Avenue" ? "2320 West End Avenue, Nashville, TN 37203" : `${reference.lat},${reference.lng}`,destination,travelmode:"walking"}) : null;
  const peers=card.start && card.end && !card.cancelled ? cards.filter(other=>other.identity_key!==card.identity_key && !other.cancelled && other.start && other.end && card.start!<other.end && other.start<card.end!) : [];
  const hasCalendar=card.sources.some(source=>source.label==="Calendar");
  const sourceStatus=card.sources.length>1 && new Set(card.sources.map(source=>source.label)).size>1 ? (card.conflicts.length ? "Multiple Sources Have Conflicting Details" : "Multiple Sources; No Recorded Field Conflicts") : "AnchorLink Only; Second-Source Match Unverified";
  const category=card.food_category==="Full meal" ? "Meal provided" : card.food_category==="Snacks" ? "Refreshments provided" : named.length ? "Food options listed" : "Free food; menu unspecified";
  const restricted=card.rsvp_label==="RSVP Required" || /\b(?:spaces? (?:are |is )?limited|limited spaces?|registration is required|rsvp is required)\b/i.test(card.description || "");
  const fallback=card.cancelled ? "This event is cancelled" : `${category}${restricted ? "; check registration and eligibility" : card.participation.level==="structured" ? " during the scheduled activity" : ""}`;
  const assessment=(aiReason || fallback).replace(/[.;\s]+$/,"");
  return {identity_key:card.identity_key,title:card.title,url:card.event_url,
    time:`${card.start?.slice(0,5) || "Start Time Not Listed"}–${card.end?.slice(0,5) || "End Time Not Listed"} (Nashville Local Time)${card.cancelled ? "; Cancelled" : ""}`,
    food:menu,location,address,walk:walk===null ? "Walking Time Unverified" : `${walk} min straight-line estimate; actual pedestrian route/time unverified`,
    route_url:params ? `https://www.google.com/maps/dir/?${params}` : null,
    rsvp:card.rsvp_label==="RSVP Not Stated" ? (/\b(?:rsvp|register|registration|sign[- ]?up)\b/i.test(card.description || "") ? "The source mentions RSVP/registration; check requirements, eligibility and remaining availability" : "RSVP/Registration Not Stated") : card.rsvp_label==="No RSVP Needed" ? "The source explicitly states no RSVP is needed" : "RSVP Required; Check Availability and Eligibility",
    participation:card.participation.ai_note ? card.participation.ai_note : ({open:"Open attendance is explicitly stated; suitability for a food-only visit remains unverified",structured:"The activity has a planned format; suitability for a brief food-only visit remains unverified",restricted:"The source lists participation restrictions; verify eligibility",unknown:"Eligibility and participation format are unstated or unverified"}[card.participation.level] || "Consult the official participation requirements; suitability for a brief food-only visit is unverified"),
    sources:sourceStatus+(hasCalendar ? "; See event links for the calendar source" : "; Personal calendar is not connected; calendar time/location differences unverified"),
    conflicts:[...card.conflicts.map(c=>`${c.field}: ${c.values.join(" / ")}`),...(peers.length ? [`Overlaps ${peers.map(p=>p.title).join("; ")}; all events retained`] : ["No overlap found among listed event times"])].join("; "),
    reason:`${card.cancelled ? 'This event is cancelled' : assessment}.${card.conflicts.length ? ' Source details conflict.' : ''}`,
  };
}
