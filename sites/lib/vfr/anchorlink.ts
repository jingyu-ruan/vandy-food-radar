/**
 * Live Vanderbilt AnchorLink Free Food source adapter.
 *
 * The canonical human filter is the AnchorLink events page with the Free Food
 * perk selected. That page is client-rendered on top of a public JSON
 * discovery interface, which is what this adapter reads. The verified contract:
 *
 * - `benefitNames=FreeFood` applies the Free Food facet. The page parameter
 *   `perks=FreeFood` is not an API filter.
 * - `startsAfter` / `startsBefore` bound event start instants.
 * - `skip` / `take` paginate; `@odata.count` reports the matching total.
 * - Genuine event pages live at `/event/<numeric-id>`.
 *
 * Every page for the target local day is fetched, and each row is then checked
 * again defensively. A listing HTTP failure, an invalid response envelope, a
 * pagination inconsistency, or a row with a malformed required field aborts the
 * whole refresh, so a transient upstream problem can never be published as a
 * successful empty day. A genuine zero-match response is accepted as a real
 * empty day.
 */

import type { AnchorLinkConfig } from "./config.ts";
import { ParseStatus, SourceId } from "./models.ts";
import type { SourceRecord } from "./models.ts";
import { htmlToPlainText } from "./text.ts";
import {
  formatLocalTime,
  localDateOf,
  localDayBounds,
  parseAwareTimestamp,
  toUtcIso,
} from "./time.ts";

export const FREE_FOOD_PERK = "Free Food";

/** Event links are only ever built from an ID the API itself returned. */
const CANONICAL_EVENT_BASE_URL = "https://anchorlink.vanderbilt.edu";
const EVENT_ID_PATTERN = /^[1-9][0-9]*$/;

/** Raised when a complete, trustworthy live result cannot be obtained. */
export class AnchorLinkFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnchorLinkFetchError";
  }
}

/** Raised for a row whose required fields do not match the public schema. */
class RowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RowValidationError";
  }
}

export type FetchResult = {
  ok: boolean;
  status: number | null;
  text: string | null;
  error: string | null;
};

/** Network seam, so the adapter is exercised without live network access. */
export type HttpFetcher = {
  get(url: string, options: { timeoutMs: number }): Promise<FetchResult>;
};

/** Default fetcher using the Workers runtime `fetch`. */
export const workerFetcher: HttpFetcher = {
  async get(url, { timeoutMs }) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "VandyFoodRadar/1.0",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const ok = response.status >= 200 && response.status < 300;
      const text = ok ? await response.text() : null;
      return {
        ok,
        status: response.status,
        text,
        error: ok ? null : `HTTP ${response.status}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "request failed";
      return { ok: false, status: null, text: null, error: message };
    }
  },
};

export type AnchorLinkFetchSummary = {
  records: SourceRecord[];
  reportedTotal: number;
  pagesFetched: number;
};

type SearchPayload = { total: number; values: unknown[] };

function decodeSearchPayload(text: string): SearchPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new AnchorLinkFetchError("AnchorLink returned invalid JSON");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new AnchorLinkFetchError("AnchorLink response is not an object");
  }
  const record = payload as Record<string, unknown>;
  const total = record["@odata.count"];
  const values = record["value"];
  if (
    typeof total !== "number" ||
    !Number.isInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(total)
  ) {
    throw new AnchorLinkFetchError("AnchorLink response has no valid @odata.count");
  }
  if (!Array.isArray(values)) {
    throw new AnchorLinkFetchError("AnchorLink response has no event list");
  }
  return { total, values };
}

function matchesIdentifier(value: unknown, expected: number): boolean {
  if (typeof value === "boolean") return false;
  if (typeof value === "number" || typeof value === "string") {
    return String(value) === String(expected);
  }
  return false;
}

function matchesBranch(item: Record<string, unknown>, expected: number): boolean {
  if (matchesIdentifier(item["branchId"], expected)) return true;
  const branchIds = item["branchIds"];
  if (Array.isArray(branchIds)) {
    return branchIds.some((value) => matchesIdentifier(value, expected));
  }
  return false;
}

export type AnchorLinkAdapterOptions = {
  fetcher: HttpFetcher;
  settings: AnchorLinkConfig;
  timezone: string;
  /** Single clock reading for the whole fetch, keeping every page consistent. */
  nowMs: number;
};

export class LiveAnchorLinkAdapter {
  readonly sourceId = SourceId.ANCHOR_LINK;

  private readonly fetcher: HttpFetcher;
  private readonly settings: AnchorLinkConfig;
  private readonly timezone: string;
  private readonly nowMs: number;

  constructor(options: AnchorLinkAdapterOptions) {
    this.fetcher = options.fetcher;
    this.settings = options.settings;
    this.timezone = options.timezone;
    this.nowMs = options.nowMs;
  }

  /** Fetch every API page for `targetDate` and map the valid rows. */
  async fetch(targetDate: string): Promise<AnchorLinkFetchSummary> {
    const bounds = localDayBounds(targetDate, this.timezone);
    // `startsAfter` is exclusive, so step back a second to include an event
    // that begins exactly at local midnight.
    const startsAfter = toUtcIso(bounds.startMs - 1000);
    const startsBefore = toUtcIso(bounds.endMs);

    const records: SourceRecord[] = [];
    const seenIds = new Set<string>();
    let malformedRows = 0;
    let skip = 0;
    let pagesFetched = 0;
    let total: number | null = null;

    while (total === null || skip < total) {
      if (pagesFetched >= this.settings.maxPages) {
        throw new AnchorLinkFetchError("AnchorLink pagination exceeded safety limit");
      }
      const query = new URLSearchParams({
        benefitNames: this.settings.freeFoodFilter,
        startsAfter,
        startsBefore,
        take: String(this.settings.pageSize),
        skip: String(skip),
      });
      const url = `${this.settings.baseUrl.replace(/\/+$/, "")}${this.settings.searchPath}?${query.toString()}`;
      const result = await this.fetcher.get(url, {
        timeoutMs: this.settings.timeoutMs,
      });
      if (!result.ok || result.text === null) {
        const detail = result.error ?? `HTTP ${result.status ?? "error"}`;
        throw new AnchorLinkFetchError(
          `AnchorLink discovery request failed at offset ${skip}: ${detail}`,
        );
      }
      const payload = decodeSearchPayload(result.text);
      if (payload.total > this.settings.maxTotal) {
        throw new AnchorLinkFetchError(
          `AnchorLink reported an implausible total (${payload.total})`,
        );
      }
      // Counts can grow while pagination is in flight. Never lower the target
      // and silently accept an incomplete shrinking result.
      total = total === null ? payload.total : Math.max(total, payload.total);

      const checkedAt = toUtcIso(this.nowMs);
      for (const item of payload.values) {
        let record: SourceRecord | null;
        try {
          record = this.recordFromItem(item, { targetDate, checkedAt });
        } catch (error) {
          if (error instanceof RowValidationError) {
            malformedRows += 1;
            continue;
          }
          throw error;
        }
        if (record === null) continue;
        const externalId = record.id.replace(/^anchorlink-/, "");
        if (seenIds.has(externalId)) {
          throw new AnchorLinkFetchError(
            "AnchorLink pagination returned a duplicate event id",
          );
        }
        seenIds.add(externalId);
        records.push(record);
      }

      const pageLength = payload.values.length;
      pagesFetched += 1;
      if (pageLength === 0) {
        if (skip < total) {
          throw new AnchorLinkFetchError(
            "AnchorLink pagination ended before the reported total",
          );
        }
        break;
      }
      skip += pageLength;
    }

    if (malformedRows > 0) {
      throw new AnchorLinkFetchError(
        "AnchorLink returned rows with an invalid public event schema",
      );
    }
    return { records, reportedTotal: total ?? 0, pagesFetched };
  }

  /**
   * Map one API row to a source record.
   *
   * Returns `null` for a row that is validly shaped but does not belong on the
   * target day (wrong institution, not public, already ended, a different
   * date). Throws `RowValidationError` when a required field is malformed,
   * which fails the entire refresh rather than quietly shrinking the feed.
   */
  private recordFromItem(
    item: unknown,
    context: { targetDate: string; checkedAt: string },
  ): SourceRecord | null {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new RowValidationError("event row is not an object");
    }
    const row = item as Record<string, unknown>;

    const benefits = row["benefitNames"];
    if (!Array.isArray(benefits) || !benefits.every((v) => typeof v === "string")) {
      throw new RowValidationError("invalid benefit names");
    }
    if (!benefits.includes(FREE_FOOD_PERK)) return null;

    const status = row["status"];
    const visibility = row["visibility"];
    if (typeof status !== "string" || typeof visibility !== "string") {
      throw new RowValidationError("missing event publication state");
    }
    if (status !== "Approved" || visibility !== "Public") return null;
    if (!matchesIdentifier(row["institutionId"], this.settings.institutionId)) {
      return null;
    }
    if (!matchesBranch(row, this.settings.branchId)) return null;

    const rawId = row["id"];
    const externalId =
      typeof rawId === "number" || typeof rawId === "string" ? String(rawId) : "";
    if (!EVENT_ID_PATTERN.test(externalId)) {
      throw new RowValidationError("invalid event id");
    }
    const title = row["name"];
    if (typeof title !== "string" || !title.trim()) {
      throw new RowValidationError("missing event name");
    }

    let startsOnMs: number;
    let endsOnMs: number;
    try {
      startsOnMs = parseAwareTimestamp(row["startsOn"]);
      endsOnMs = parseAwareTimestamp(row["endsOn"]);
    } catch (error) {
      throw new RowValidationError(
        error instanceof Error ? error.message : "invalid event timestamp",
      );
    }
    if (endsOnMs <= startsOnMs) {
      throw new RowValidationError("event end is not after start");
    }

    const localStartDate = localDateOf(startsOnMs, this.timezone);
    if (localStartDate !== context.targetDate) return null;
    // Keep in-progress events on a same-day feed; only events that have ended
    // are stale.
    if (endsOnMs <= this.nowMs) return null;

    const localEndDate = localDateOf(endsOnMs, this.timezone);
    const eventUrl = `${CANONICAL_EVENT_BASE_URL}/event/${externalId}`;
    const description = htmlToPlainText(row["description"]);
    const location = row["location"];
    const organizer = row["organizationName"];

    return {
      id: `anchorlink-${externalId}`,
      sourceId: SourceId.ANCHOR_LINK,
      sourceUrl: eventUrl,
      rawPayload: stableStringify(row),
      parsedFields: {
        title: title.trim(),
        event_date: localStartDate,
        // The normalizer contract is local HH:MM, not a full ISO instant.
        start_time: formatLocalTime(startsOnMs, this.timezone),
        end_time: formatLocalTime(endsOnMs, this.timezone),
        start_utc: toUtcIso(startsOnMs),
        end_utc: toUtcIso(endsOnMs),
        ends_next_day: localEndDate !== localStartDate,
        location: typeof location === "string" ? location.trim() || null : null,
        organizer: typeof organizer === "string" ? organizer.trim() || null : null,
        event_url: eventUrl,
        anchorlink_id: externalId,
        source_identity: `anchorlink:${externalId}`,
        food_confirmed: "confirmed",
        food_description: description ?? "AnchorLink Free Food perk",
        status,
        cancelled: false,
      },
      checkedAt: context.checkedAt,
      parseStatus: ParseStatus.OK,
      sourceUpdatedAt: null,
    };
  }
}

/** Serialize with sorted keys so a stored raw payload is byte-stable. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}
