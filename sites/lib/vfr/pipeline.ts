/**
 * Refresh orchestration: discover, normalize, deduplicate, verify, rank, publish.
 *
 * A refresh covers a span of local days that always begins today (`days=1`,
 * `2`, or `7`). Every requested day is ingested and computed in memory before
 * anything is written; only once every page of every day has been fetched and
 * every event scored is a single transactional publish issued. The
 * consequences are the ones that matter operationally:
 *
 * - A source outage, a malformed row, or a pagination inconsistency on any day
 *   aborts the run before any write, so the previously published feed stays
 *   visible for every day.
 * - A storage failure during publish rolls the whole batch back, so a partial
 *   day or a partial span is never visible either.
 * - A day outside the request is never erased; it only ages out through the
 *   bounded rolling retention window.
 * - A persistent lease with an expiry prevents two overlapping refreshes from
 *   interleaving reads and writes and regressing each other's work. The holder
 *   is re-validated inside the publish transaction, so a run that overran its
 *   lease cannot overwrite the newer feed that superseded it.
 *
 * Every refresh re-derives the complete result, so raw source payloads,
 * provenance, the scoring breakdown, and the change classification are all
 * carried forward across successful refreshes rather than decaying. A detected
 * time or venue change keeps its original detection time for 24 hours, so the
 * warning survives the next refresh instead of vanishing an hour later.
 */

import { LiveAnchorLinkAdapter, workerFetcher } from "./anchorlink.ts";
import type { HttpFetcher } from "./anchorlink.ts";
import { campusPlaces } from "./campus-places.ts";
import {
  detectChanges,
  diffHistory,
  isLiveMaterialChange,
  tallyChanges,
} from "./changes.ts";
import type { ChangeCounts, ChangeRecord } from "./changes.ts";
import type { Config, RefreshDays } from "./config.ts";
import { deduplicate } from "./dedup.ts";
import { StorageError } from "./d1.ts";
import { ChangeKind, VerificationState } from "./models.ts";
import type { Event, EventHistoryEntry, SourceRecord } from "./models.ts";
import { normalize } from "./normalize.ts";
import { assessParticipation, participationInputFor } from "./participation.ts";
import type { PlaceDataset } from "./places.ts";
import { buildExplanation, orderEvents, scoreEvent } from "./ranking.ts";
import type {
  DayPublication,
  PreviousEvent,
  RefreshRunRecord,
  Repository,
} from "./repository.ts";
import { localDateOf, shiftIsoDate } from "./time.ts";
import { verify } from "./verify.ts";
import { buildLocationProvider, walkingLabel } from "./walking.ts";
import type { LocationProvider } from "./walking.ts";

export type DaySummary = {
  targetDate: string;
  fetched: number;
  published: number;
  pagesFetched: number;
  reportedTotal: number;
  changes: ChangeCounts;
};

export type RefreshSummary = {
  /** First requested day, which is always today. */
  targetDate: string;
  /** Every requested day, ascending, all published in one transaction. */
  days: string[];
  perDay: DaySummary[];
  timezone: string;
  publishedAt: string;
  fetched: number;
  published: number;
  pagesFetched: number;
  reportedTotal: number;
  changes: ChangeCounts;
  historyEntries: number;
  durationMs: number;
};

export type RefreshResult =
  | { ok: true; summary: RefreshSummary }
  | { ok: false; kind: "locked"; message: string; retryAfterSeconds: number }
  | { ok: false; kind: "source"; message: string }
  | { ok: false; kind: "storage"; message: string; schemaMissing: boolean };

export type RefreshOptions = {
  repository: Repository;
  config: Config;
  trigger: string;
  /** Span of local days starting today. Defaults to one day. */
  days?: RefreshDays;
  /** Injected so a refresh is reproducible in tests. */
  nowMs?: number;
  fetcher?: HttpFetcher;
  locationProvider?: LocationProvider;
  places?: PlaceDataset;
  /** Distinguishes concurrent refresh attempts in the lease. */
  holder?: string;
};

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** The consecutive local dates a refresh of `days` covers, starting today. */
export function refreshDates(todayIso: string, days: number): string[] {
  const count = Math.max(1, days);
  return Array.from({ length: count }, (_, offset) => shiftIsoDate(todayIso, offset));
}

/** Run one complete refresh for the requested span. */
export async function runRefresh(options: RefreshOptions): Promise<RefreshResult> {
  const { repository, config, trigger } = options;
  const nowMs = options.nowMs ?? Date.now();
  const startedAt = new Date(nowMs).toISOString();
  const holder = options.holder ?? randomId();
  const todayIso = localDateOf(nowMs, config.timezone);
  const targetDates = refreshDates(todayIso, options.days ?? 1);

  let claimed = false;
  try {
    claimed = await repository.claimLease(holder, nowMs);
  } catch (error) {
    return storageFailure(error);
  }
  if (!claimed) {
    let expiresAt: number | null = null;
    try {
      expiresAt = await repository.leaseExpiresAt();
    } catch {
      expiresAt = null;
    }
    const retryAfterSeconds = expiresAt
      ? Math.max(1, Math.ceil((expiresAt - nowMs) / 1000))
      : Math.ceil(config.leaseTtlMs / 1000);
    return {
      ok: false,
      kind: "locked",
      message: "another refresh is already in progress",
      retryAfterSeconds,
    };
  }

  try {
    return await executeRefresh({
      ...options,
      nowMs,
      startedAt,
      todayIso,
      targetDates,
      runId: randomId(),
      trigger,
      holder,
    });
  } finally {
    // Releasing is best-effort: the lease expires on its own, so a failure here
    // delays the next refresh at worst and never deadlocks it.
    try {
      await repository.releaseLease(holder);
    } catch {
      /* lease expiry is the backstop */
    }
  }
}

function storageFailure(error: unknown): RefreshResult {
  if (error instanceof StorageError) {
    return {
      ok: false,
      kind: "storage",
      message: error.message,
      schemaMissing: error.schemaMissing,
    };
  }
  return {
    ok: false,
    kind: "storage",
    message: error instanceof Error ? error.message : "durable storage failed",
    schemaMissing: false,
  };
}

type ExecuteOptions = RefreshOptions & {
  nowMs: number;
  startedAt: string;
  todayIso: string;
  targetDates: string[];
  runId: string;
  holder: string;
};

type ComputedDay = {
  publication: DayPublication;
  summary: DaySummary;
};

async function executeRefresh(options: ExecuteOptions): Promise<RefreshResult> {
  const { repository, config, targetDates, nowMs, startedAt, runId, trigger, holder } =
    options;
  const nowIso = new Date(nowMs).toISOString();
  // Durations are measured against the real clock, but every stored timestamp is
  // anchored on the injected `nowMs`, so a run log is ordered deterministically
  // and a test can reason about it.
  const wallStart = Date.now();
  const finishedIso = () => new Date(nowMs + (Date.now() - wallStart)).toISOString();
  const elapsedMs = () => Math.max(0, Date.now() - wallStart);
  const failureContext = {
    runId,
    targetDate: targetDates[0],
    startedAt,
    nowMs,
    trigger,
    finishedIso,
    elapsedMs,
  };

  if (!config.anchorLink.enabled) {
    return { ok: false, kind: "source", message: "no event source is enabled" };
  }

  const adapter = new LiveAnchorLinkAdapter({
    fetcher: options.fetcher ?? workerFetcher,
    settings: config.anchorLink,
    timezone: config.timezone,
    nowMs,
  });
  const locationProvider = options.locationProvider ?? buildLocationProvider(config);
  const places = options.places ?? campusPlaces();

  const computed: ComputedDay[] = [];
  for (const targetDate of targetDates) {
    // The previous publication is needed before anything is replaced, both for
    // change classification and to carry forward creation timestamps.
    let previous: PreviousEvent[] | null;
    try {
      previous = await repository.readPublishedEvents(targetDate);
    } catch (error) {
      await recordFailure(repository, error, { ...failureContext, status: "storage_error" });
      return storageFailure(error);
    }

    let records: SourceRecord[];
    let reportedTotal = 0;
    let pagesFetched = 0;
    try {
      const fetched = await adapter.fetch(targetDate);
      records = fetched.records;
      reportedTotal = fetched.reportedTotal;
      pagesFetched = fetched.pagesFetched;
    } catch (error) {
      const message = error instanceof Error ? error.message : "source fetch failed";
      await recordFailure(repository, error, { ...failureContext, status: "source_error" });
      return { ok: false, kind: "source", message: `${targetDate}: ${message}` };
    }

    computed.push(
      await computeDay({
        config,
        targetDate,
        nowMs,
        nowIso,
        records,
        reportedTotal,
        pagesFetched,
        previous,
        locationProvider,
        places,
      }),
    );
  }

  const totals = sumCounts(computed.map((day) => day.summary.changes));
  const fetched = computed.reduce((sum, day) => sum + day.summary.fetched, 0);
  const published = computed.reduce((sum, day) => sum + day.summary.published, 0);
  const pagesFetched = computed.reduce((sum, day) => sum + day.summary.pagesFetched, 0);
  const reportedTotal = computed.reduce((sum, day) => sum + day.summary.reportedTotal, 0);
  const historyEntries = computed.reduce(
    (sum, day) => sum + day.publication.history.length,
    0,
  );

  const run: RefreshRunRecord = {
    id: runId,
    targetDate: targetDates[0],
    status: "success",
    startedAt,
    finishedAt: finishedIso(),
    durationMs: elapsedMs(),
    trigger,
    fetched,
    published,
    pagesFetched,
    changesJson: JSON.stringify({ ...totals, days: targetDates }),
    error: null,
  };

  try {
    await repository.publishFeed({
      timezone: config.timezone,
      targetWindow: "today",
      publishedAt: nowIso,
      todayDate: options.todayIso,
      leaseHolder: holder,
      days: computed.map((day) => day.publication),
      run,
    });
  } catch (error) {
    await recordFailure(repository, error, { ...failureContext, status: "storage_error" });
    return storageFailure(error);
  }

  return {
    ok: true,
    summary: {
      targetDate: targetDates[0],
      days: targetDates,
      perDay: computed.map((day) => day.summary),
      timezone: config.timezone,
      publishedAt: nowIso,
      fetched,
      published,
      pagesFetched,
      reportedTotal,
      changes: totals,
      historyEntries,
      durationMs: run.durationMs,
    },
  };
}

function sumCounts(all: ChangeCounts[]): ChangeCounts {
  const total: ChangeCounts = {
    new: 0,
    time_changed: 0,
    venue_changed: 0,
    cancelled: 0,
    unchanged: 0,
  };
  for (const counts of all) {
    for (const key of Object.keys(total) as (keyof ChangeCounts)[]) total[key] += counts[key];
  }
  return total;
}

/** Normalize, deduplicate, verify, resolve, score, and order one local day. */
async function computeDay(input: {
  config: Config;
  targetDate: string;
  nowMs: number;
  nowIso: string;
  records: SourceRecord[];
  reportedTotal: number;
  pagesFetched: number;
  previous: PreviousEvent[] | null;
  locationProvider: LocationProvider;
  places: PlaceDataset;
}): Promise<ComputedDay> {
  const { config, targetDate, nowMs, nowIso, records, previous } = input;
  const sourceMap = new Map(records.map((record) => [record.id, record]));
  const merged = deduplicate(records.map(normalize), config.dedup);
  const origin = {
    lat: config.referenceLocation.lat,
    lng: config.referenceLocation.lng,
  };

  const scored: {
    event: Event;
    components: ReturnType<typeof scoreEvent>["components"];
    conflicts: ReturnType<typeof verify>["conflicts"];
    provenance: ReturnType<typeof verify>["provenance"];
    sources: SourceRecord[];
    walkingLabel: string;
    verificationHistory: EventHistoryEntry[];
  }[] = [];

  for (const group of merged) {
    const verified = verify(group, sourceMap, config, nowIso);
    const sources = group.members
      .map((member) => sourceMap.get(member.sourceRecordId))
      .filter((record): record is SourceRecord => record !== undefined);
    // Coordinates come only from the curated campus dataset; an unmatched
    // location stays unresolved rather than being approximated.
    const resolved = input.places.resolve(verified.event.location);
    const event: Event = { ...verified.event, locationGeo: resolved?.place.point ?? null };
    const walk = await input.locationProvider.walking(origin, event.locationGeo);
    const assessment = assessParticipation(participationInputFor(event, sources));
    const result = scoreEvent(event, config, walk, assessment);
    scored.push({
      event: result.event,
      components: result.components,
      conflicts: verified.conflicts,
      provenance: verified.provenance,
      sources,
      walkingLabel: walkingLabel(walk),
      verificationHistory: verified.history,
    });
  }

  // Ranking input objects are carried by reference through `orderEvents`, so the
  // detail for each event is looked up by object identity. Keying this on the
  // event id would conflate two distinct source events that happen to produce
  // the same derived key.
  const rankable = scored.map((entry) => ({
    event: entry.event,
    components: entry.components,
  }));
  const detailOf = new Map(rankable.map((entry, index) => [entry, scored[index]]));
  const ordered = orderEvents(rankable);

  const freshEvents = ordered.map((entry) => entry.event);
  const changes = detectChanges(freshEvents, previous?.map((entry) => entry.event) ?? null);
  const previousByIdentity = new Map(
    (previous ?? []).map((entry) => [entry.event.identityKey, entry]),
  );

  const history: EventHistoryEntry[] = [];
  // `(feed_date, identity_key)` is unique in the schema, and the physical event
  // id is derived from the target date plus that identity. For a provider-native
  // identity the two are already distinct per native event; this pass is the
  // deterministic safety net for a derived identity that is not.
  const usedIdentities = new Set<string>();
  const uniqueIdentity = (base: string): string => {
    let candidate = base;
    let suffix = 2;
    while (usedIdentities.has(candidate)) {
      candidate = `${base}#${suffix}`;
      suffix += 1;
    }
    usedIdentities.add(candidate);
    return candidate;
  };

  const events: DayPublication["events"] = ordered.map((entry, index) => {
    const detail = detailOf.get(entry)!;
    const prior = previousByIdentity.get(entry.event.identityKey) ?? null;
    const previousEvent = prior?.event ?? null;
    history.push(...diffHistory(previousEvent, entry.event, nowIso));
    // A cancellation is a transition marker, recorded the first time an event is
    // seen as cancelled rather than on every subsequent refresh.
    const alreadyCancelled =
      previousEvent !== null &&
      previousEvent.verificationState === VerificationState.CANCELLED;
    if (!alreadyCancelled) history.push(...detail.verificationHistory);

    const fresh: ChangeRecord = changes.get(entry.event.identityKey) ?? {
      kind: ChangeKind.UNCHANGED,
      detail: null,
    };
    // A recent time or venue change outlives the refresh that detected it, so
    // a reader who checks back within the warning window still sees it.
    const carried =
      fresh.kind === ChangeKind.UNCHANGED &&
      isLiveMaterialChange(prior?.change, nowMs, config.changeWarningMs)
        ? prior!.change!
        : null;
    const change = carried
      ? { kind: carried.kind, detail: carried.detail, detectedAt: carried.detectedAt! }
      : { kind: fresh.kind, detail: fresh.detail, detectedAt: nowIso };

    const identityKey = uniqueIdentity(entry.event.identityKey);
    return {
      event: { ...entry.event, identityKey, id: `${targetDate}|${identityKey}` },
      rank: index + 1,
      explanation: buildExplanation(entry.components, entry.event.verificationState),
      walkingLabel: detail.walkingLabel,
      components: entry.components,
      conflicts: detail.conflicts,
      provenance: detail.provenance,
      sources: detail.sources,
      change,
      createdAt: prior?.createdAt ?? nowIso,
    };
  });

  return {
    publication: {
      targetDate,
      sourceTotal: input.reportedTotal,
      pagesFetched: input.pagesFetched,
      events,
      history,
    },
    summary: {
      targetDate,
      fetched: records.length,
      published: events.length,
      pagesFetched: input.pagesFetched,
      reportedTotal: input.reportedTotal,
      changes: tallyChanges(changes),
    },
  };
}

/**
 * Log a failed attempt without touching the published feed.
 *
 * The log write is itself allowed to fail silently: if durable storage is down,
 * the inability to record that fact must not mask the original error.
 */
async function recordFailure(
  repository: Repository,
  error: unknown,
  context: {
    runId: string;
    targetDate: string;
    startedAt: string;
    nowMs: number;
    trigger: string;
    status: RefreshRunRecord["status"];
    finishedIso: () => string;
    elapsedMs: () => number;
  },
): Promise<void> {
  try {
    await repository.recordRun({
      id: context.runId,
      targetDate: context.targetDate,
      status: context.status,
      startedAt: context.startedAt,
      finishedAt: context.finishedIso(),
      durationMs: context.elapsedMs(),
      trigger: context.trigger,
      fetched: 0,
      published: 0,
      pagesFetched: 0,
      changesJson: null,
      error: (error instanceof Error ? error.message : "refresh failed").slice(0, 500),
    });
  } catch {
    /* the original failure is what the caller needs to hear about */
  }
}
