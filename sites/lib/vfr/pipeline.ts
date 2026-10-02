/**
 * Refresh orchestration: discover, normalize, deduplicate, verify, rank, publish.
 *
 * The whole target day is ingested and computed in memory before anything is
 * written. Only once every page has been fetched and every event scored is a
 * single transactional publish issued. The consequences are the ones that
 * matter operationally:
 *
 * - A source outage, a malformed row, or a pagination inconsistency aborts the
 *   run before any write, so the previously published feed stays visible.
 * - A storage failure during publish rolls the whole batch back, so a partial
 *   day is never visible either.
 * - A persistent lease with an expiry prevents two overlapping refreshes from
 *   interleaving reads and writes and regressing each other's work. The holder
 *   is re-validated inside the publish transaction, so a run that overran its
 *   lease cannot overwrite the newer feed that superseded it.
 *
 * Every refresh re-derives the complete result, so raw source payloads,
 * provenance, the scoring breakdown, and the change classification are all
 * carried forward across successful refreshes rather than decaying.
 */

import { LiveAnchorLinkAdapter, workerFetcher } from "./anchorlink.ts";
import type { HttpFetcher } from "./anchorlink.ts";
import { detectChanges, diffHistory, tallyChanges } from "./changes.ts";
import type { ChangeCounts, ChangeRecord } from "./changes.ts";
import { targetDateFor } from "./config.ts";
import type { Config } from "./config.ts";
import { deduplicate } from "./dedup.ts";
import { StorageError } from "./d1.ts";
import { ChangeKind, VerificationState } from "./models.ts";
import type { Event, EventHistoryEntry, SourceRecord } from "./models.ts";
import { normalize } from "./normalize.ts";
import { buildExplanation, orderEvents, scoreEvent } from "./ranking.ts";
import type { PublishPayload, RefreshRunRecord, Repository } from "./repository.ts";
import { localDateOf } from "./time.ts";
import { verify } from "./verify.ts";
import { buildLocationProvider, walkingLabel } from "./walking.ts";
import type { LocationProvider } from "./walking.ts";

export type RefreshSummary = {
  targetDate: string;
  timezone: string;
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
  /** Injected so a refresh is reproducible in tests. */
  nowMs?: number;
  fetcher?: HttpFetcher;
  locationProvider?: LocationProvider;
  /** Distinguishes concurrent refresh attempts in the lease. */
  holder?: string;
};

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Run one complete refresh for the configured target day. */
export async function runRefresh(options: RefreshOptions): Promise<RefreshResult> {
  const { repository, config, trigger } = options;
  const nowMs = options.nowMs ?? Date.now();
  const startedAt = new Date(nowMs).toISOString();
  const holder = options.holder ?? randomId();
  const todayIso = localDateOf(nowMs, config.timezone);
  const targetDate = targetDateFor(config, todayIso);

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
      targetDate,
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

async function executeRefresh(
  options: RefreshOptions & {
    nowMs: number;
    startedAt: string;
    targetDate: string;
    runId: string;
    holder: string;
  },
): Promise<RefreshResult> {
  const { repository, config, targetDate, nowMs, startedAt, runId, trigger, holder } =
    options;
  const nowIso = new Date(nowMs).toISOString();
  // Durations are measured against the real clock, but every stored timestamp is
  // anchored on the injected `nowMs`, so a run log is ordered deterministically
  // and a test can reason about it.
  const wallStart = Date.now();
  const finishedIso = () => new Date(nowMs + (Date.now() - wallStart)).toISOString();
  const elapsedMs = () => Math.max(0, Date.now() - wallStart);

  if (!config.anchorLink.enabled) {
    return { ok: false, kind: "source", message: "no event source is enabled" };
  }

  // The previous publication is needed before anything is replaced, both for
  // change classification and to carry forward creation timestamps.
  let previousPublished: { event: Event; createdAt: string }[] | null;
  try {
    previousPublished = await repository.readPublishedEvents(targetDate);
  } catch (error) {
    await recordFailure(repository, error, {
      runId,
      targetDate,
      startedAt,
      nowMs,
      trigger,
      status: "storage_error",
      finishedIso,
      elapsedMs,
    });
    return storageFailure(error);
  }

  const adapter = new LiveAnchorLinkAdapter({
    fetcher: options.fetcher ?? workerFetcher,
    settings: config.anchorLink,
    timezone: config.timezone,
    nowMs,
  });

  let records: SourceRecord[];
  let reportedTotal = 0;
  let pagesFetched = 0;
  try {
    const summary = await adapter.fetch(targetDate);
    records = summary.records;
    reportedTotal = summary.reportedTotal;
    pagesFetched = summary.pagesFetched;
  } catch (error) {
    const message = error instanceof Error ? error.message : "source fetch failed";
    await recordFailure(repository, error, {
      runId,
      targetDate,
      startedAt,
      nowMs,
      trigger,
      status: "source_error",
      finishedIso,
      elapsedMs,
    });
    return { ok: false, kind: "source", message };
  }

  const sourceMap = new Map(records.map((record) => [record.id, record]));
  const normalized = records.map(normalize);
  const merged = deduplicate(normalized, config.dedup);
  const locationProvider = options.locationProvider ?? buildLocationProvider(config);
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
    const walk = await locationProvider.walking(origin, verified.event.locationGeo);
    const result = scoreEvent(verified.event, config, walk);
    scored.push({
      event: result.event,
      components: result.components,
      conflicts: verified.conflicts,
      provenance: verified.provenance,
      sources: group.members
        .map((member) => sourceMap.get(member.sourceRecordId))
        .filter((record): record is SourceRecord => record !== undefined),
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
  const previousEvents = previousPublished?.map((entry) => entry.event) ?? null;
  const changes = detectChanges(freshEvents, previousEvents);
  const previousByIdentity = new Map(
    (previousPublished ?? []).map((entry) => [entry.event.identityKey, entry]),
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

  const publishEvents: PublishPayload["events"] = ordered.map((entry, index) => {
    const detail = detailOf.get(entry)!;
    const prior = previousByIdentity.get(entry.event.identityKey) ?? null;
    const previous = prior?.event ?? null;
    history.push(...diffHistory(previous, entry.event, nowIso));
    // A cancellation is a transition marker, recorded the first time an event is
    // seen as cancelled rather than on every subsequent refresh.
    const alreadyCancelled =
      previous !== null && previous.verificationState === VerificationState.CANCELLED;
    if (!alreadyCancelled) history.push(...detail.verificationHistory);

    const change: ChangeRecord =
      changes.get(entry.event.identityKey) ?? { kind: ChangeKind.UNCHANGED, detail: null };

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

  const counts = tallyChanges(changes);
  const run: RefreshRunRecord = {
    id: runId,
    targetDate,
    status: "success",
    startedAt,
    finishedAt: finishedIso(),
    durationMs: elapsedMs(),
    trigger,
    fetched: records.length,
    published: publishEvents.length,
    pagesFetched,
    changesJson: JSON.stringify(counts),
    error: null,
  };

  try {
    await repository.publishFeed({
      targetDate,
      timezone: config.timezone,
      targetWindow: config.targetWindow,
      publishedAt: nowIso,
      sourceTotal: reportedTotal,
      pagesFetched,
      leaseHolder: holder,
      events: publishEvents,
      history,
      run,
    });
  } catch (error) {
    await recordFailure(repository, error, {
      runId,
      targetDate,
      startedAt,
      nowMs,
      trigger,
      status: "storage_error",
      finishedIso,
      elapsedMs,
    });
    return storageFailure(error);
  }

  return {
    ok: true,
    summary: {
      targetDate,
      timezone: config.timezone,
      fetched: records.length,
      published: publishEvents.length,
      pagesFetched,
      reportedTotal,
      changes: counts,
      historyEntries: history.length,
      durationMs: run.durationMs,
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
