/**
 * `GET /api/calendar/[id]` — download one event as an iCalendar file.
 *
 * The user chooses to download and then chooses whether to import. Nothing is
 * written to anyone's calendar by this route or by any other part of the app.
 *
 * `id` is the AnchorLink event id. The event must already be published, so the
 * export can only ever describe data that has been ingested and verified.
 */

import { buildEventIcs, icsFilename } from "@/lib/vfr/ics.ts";
import { VerificationState } from "@/lib/vfr/models.ts";
import { getConfig, getRepository, jsonResponse } from "@/lib/vfr/runtime.ts";

export const dynamic = "force-dynamic";

const NUMERIC_ID = /^[1-9][0-9]{0,18}$/;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  if (!NUMERIC_ID.test(id)) {
    return jsonResponse({ error: "unknown event" }, { status: 404 });
  }

  const config = getConfig();
  let event;
  try {
    const repository = getRepository(config);
    event = await repository.findEventByAnchorlinkId(id);
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
  if (event.verificationState === VerificationState.CANCELLED) {
    return jsonResponse(
      { error: "this event is cancelled, so no calendar file is offered" },
      { status: 409 },
    );
  }

  const body = buildEventIcs(event, { nowMs: Date.now(), timezone: config.timezone });
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
