/**
 * `GET /api/calendar/[id]?date=YYYY-MM-DD` — download one event as an
 * iCalendar file.
 *
 * The user chooses to download and then chooses whether to import. Nothing is
 * written to anyone's calendar by this route or by any other part of the app.
 *
 * `id` is the AnchorLink event id. With `date` the lookup is scoped to that
 * published day and never crosses into another; without it the newest
 * published day is used. A cancelled event is still exported, with
 * `STATUS:CANCELLED`, so importing it updates a copy saved earlier.
 */

import { campusPlaces } from "@/lib/vfr/campus-places.ts";
import { buildEventIcs, icsFilename } from "@/lib/vfr/ics.ts";
import { placeDisplayName } from "@/lib/vfr/places.ts";
import { getConfig, getRepository, jsonResponse } from "@/lib/vfr/runtime.ts";
import { parseIsoDate } from "@/lib/vfr/time.ts";

export const dynamic = "force-dynamic";

const NUMERIC_ID = /^[1-9][0-9]{0,18}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!NUMERIC_ID.test(id)) {
    return jsonResponse({ error: "unknown event" }, { status: 404 });
  }
  const rawDate = new URL(request.url).searchParams.get("date");
  let date: string | undefined;
  if (rawDate !== null) {
    if (!ISO_DATE.test(rawDate) || !parseIsoDate(rawDate)) {
      return jsonResponse({ error: "date must be YYYY-MM-DD" }, { status: 400 });
    }
    date = rawDate;
  }

  const config = getConfig();
  let event;
  try {
    const repository = getRepository(config);
    event = await repository.findEventByAnchorlinkId(id, date);
  } catch (error) {
    console.error(`calendar: lookup failed for event ${id}`, error);
    return jsonResponse(
      { error: "event data is temporarily unavailable" },
      { status: 503 },
    );
  }

  if (!event) {
    return jsonResponse({ error: "unknown event" }, { status: 404 });
  }

  const resolved = campusPlaces().resolve(event.location);
  const body = buildEventIcs(event, {
    nowMs: Date.now(),
    timezone: config.timezone,
    location: resolved ? placeDisplayName(resolved) : event.location,
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      // The filename is built from the numeric id only, so no untrusted text
      // from the source can reach this header.
      "content-disposition": `attachment; filename="${icsFilename(event)}"`,
      "cache-control": "no-store",
    },
  });
}
