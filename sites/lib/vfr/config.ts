/**
 * Runtime configuration.
 *
 * Every value has a working default so the site boots without any environment
 * variables configured; the environment only layers overrides on top. An
 * unrecognized value falls back to the default rather than throwing, keeping
 * startup robust.
 *
 * Secrets are read from the environment and never appear in source.
 */

import { FoodConfirmed } from "./models.ts";
import type { ScoreFactor, SourceId } from "./models.ts";

export const ENV_PREFIX = "VFR_";

export type TargetWindow = "next_day" | "today";
export type LocationProviderKind = "haversine" | "google_maps" | "null";

export type AnchorLinkConfig = {
  enabled: boolean;
  baseUrl: string;
  searchPath: string;
  /**
   * The API facet slug. The human-facing listing page uses `perks=FreeFood`,
   * which the JSON endpoint ignores.
   */
  freeFoodFilter: string;
  pageSize: number;
  maxPages: number;
  /** Refuse an implausible reported total rather than paginating forever. */
  maxTotal: number;
  timeoutMs: number;
  institutionId: number;
  branchId: number;
};

export type RankingConfig = {
  weights: Record<ScoreFactor, number>;
  /** Neutral value used when a walk is unknown so it never zeroes a score. */
  walkingUnknownValue: number;
  timingGoodStartHour: number;
  timingGoodEndHour: number;
};

export type DedupConfig = {
  mergeThreshold: number;
  reviewLow: number;
  timeProximityMinutes: number;
};

export type ReferenceLocation = { label: string; lat: number; lng: number };

export type Config = {
  timezone: string;
  targetWindow: TargetWindow;
  referenceLocation: ReferenceLocation;
  anchorLink: AnchorLinkConfig;
  /** Authority order for conflict resolution, most authoritative first. */
  authorityPrecedence: SourceId[];
  ranking: RankingConfig;
  dedup: DedupConfig;
  locationProvider: LocationProviderKind;
  mapsEnabled: boolean;
  mapsApiKey: string;
  /** Bearer token required by the legacy scheduler route and by fallback auth. */
  refreshToken: string;
  /**
   * True when the deployment is owner-private and the hosting platform is
   * already gating every request. Mutations may then rely on that boundary.
   */
  ownerPrivate: boolean;
  /** How long a published feed stays fresh before the UI warns about it. */
  staleAfterMs: number;
  /** Published target days to retain. */
  feedRetentionDays: number;
  /** Age limit for retained history rows. */
  historyRetentionDays: number;
  /** Refresh-run rows to retain. */
  refreshRunRetention: number;
  /** Lifetime of a claimed refresh lease. */
  leaseTtlMs: number;
  /** Hard cap on events published for one day. */
  maxEventsPerFeed: number;
};

/** Ranking weights. These sum to 1.0 and match the reference application. */
function defaultWeights(): Record<ScoreFactor, number> {
  return {
    food_confirmed: 0.25,
    full_meal: 0.25,
    food_specificity: 0.15,
    rsvp_likelihood: 0.1,
    timing: 0.05,
    walking: 0.1,
    confidence: 0.1,
  };
}

export function defaultConfig(): Config {
  return {
    timezone: "America/Chicago",
    targetWindow: "next_day",
    referenceLocation: { label: "Kirkland Hall", lat: 36.1487, lng: -86.8027 },
    anchorLink: {
      enabled: true,
      baseUrl: "https://anchorlink.vanderbilt.edu",
      searchPath: "/api/discovery/event/search",
      freeFoodFilter: "FreeFood",
      pageSize: 100,
      maxPages: 200,
      maxTotal: 20000,
      timeoutMs: 15000,
      institutionId: 24,
      branchId: 56623,
    },
    authorityPrecedence: ["official_page", "anchor_link", "google_calendar"],
    ranking: {
      weights: defaultWeights(),
      walkingUnknownValue: 0.5,
      timingGoodStartHour: 11,
      timingGoodEndHour: 20,
    },
    dedup: { mergeThreshold: 0.75, reviewLow: 0.55, timeProximityMinutes: 30 },
    locationProvider: "haversine",
    mapsEnabled: false,
    mapsApiKey: "",
    refreshToken: "",
    ownerPrivate: false,
    staleAfterMs: 2 * 60 * 60 * 1000,
    feedRetentionDays: 7,
    historyRetentionDays: 30,
    refreshRunRetention: 50,
    leaseTtlMs: 5 * 60 * 1000,
    maxEventsPerFeed: 500,
  };
}

export type EnvLike = Record<string, unknown>;

function readString(env: EnvLike, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" ? value : undefined;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseFloatOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIntIn(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Build a config from defaults plus a curated set of environment overrides. */
export function configFromEnv(env: EnvLike): Config {
  const config = defaultConfig();

  const timezone = readString(env, `${ENV_PREFIX}TIMEZONE`);
  if (timezone && timezone.trim()) config.timezone = timezone.trim();

  const window = readString(env, `${ENV_PREFIX}TARGET_WINDOW`)?.trim().toLowerCase();
  if (window === "today" || window === "next_day") config.targetWindow = window;

  const label = readString(env, `${ENV_PREFIX}REF_LABEL`);
  if (label && label.trim()) config.referenceLocation.label = label.trim();
  config.referenceLocation.lat = parseFloatOr(
    readString(env, `${ENV_PREFIX}REF_LAT`),
    config.referenceLocation.lat,
  );
  config.referenceLocation.lng = parseFloatOr(
    readString(env, `${ENV_PREFIX}REF_LNG`),
    config.referenceLocation.lng,
  );

  const baseUrl = readString(env, `${ENV_PREFIX}ANCHORLINK_BASE_URL`);
  if (baseUrl && baseUrl.trim()) {
    config.anchorLink.baseUrl = baseUrl.trim().replace(/\/+$/, "");
  }
  config.anchorLink.pageSize = parseIntIn(
    readString(env, `${ENV_PREFIX}ANCHORLINK_PAGE_SIZE`),
    config.anchorLink.pageSize,
    1,
    100,
  );
  const timeoutSeconds = readString(
    env,
    `${ENV_PREFIX}ANCHORLINK_TIMEOUT_SECONDS`,
  );
  if (timeoutSeconds !== undefined) {
    config.anchorLink.timeoutMs =
      Math.max(1, parseFloatOr(timeoutSeconds, config.anchorLink.timeoutMs / 1000)) *
      1000;
  }

  const provider = readString(env, `${ENV_PREFIX}LOCATION_PROVIDER`)
    ?.trim()
    .toLowerCase();
  if (provider === "haversine" || provider === "google_maps" || provider === "null") {
    config.locationProvider = provider;
  }
  config.mapsEnabled = parseBool(
    readString(env, `${ENV_PREFIX}MAPS_ENABLED`),
    config.mapsEnabled,
  );
  config.mapsApiKey = readString(env, "GOOGLE_MAPS_API_KEY")?.trim() ?? "";

  config.refreshToken =
    readString(env, `${ENV_PREFIX}REFRESH_TOKEN`)?.trim() ||
    readString(env, "CRON_SECRET")?.trim() ||
    "";

  config.ownerPrivate = parseBool(
    readString(env, `${ENV_PREFIX}OWNER_PRIVATE`),
    config.ownerPrivate,
  );

  const staleHours = readString(env, `${ENV_PREFIX}STALE_AFTER_HOURS`);
  if (staleHours !== undefined) {
    config.staleAfterMs =
      Math.max(0.25, parseFloatOr(staleHours, config.staleAfterMs / 3600000)) *
      3600000;
  }

  config.feedRetentionDays = parseIntIn(
    readString(env, `${ENV_PREFIX}FEED_RETENTION_DAYS`),
    config.feedRetentionDays,
    1,
    90,
  );
  config.historyRetentionDays = parseIntIn(
    readString(env, `${ENV_PREFIX}HISTORY_RETENTION_DAYS`),
    config.historyRetentionDays,
    1,
    365,
  );

  return config;
}

/**
 * The local date the feed targets, derived from the current instant.
 *
 * `today` is passed in so window derivation stays pure and testable.
 */
export function targetDateFor(config: Config, todayIso: string): string {
  if (config.targetWindow === "today") return todayIso;
  const [y, m, d] = todayIso.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(next.getUTCFullYear(), 4)}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** Re-exported so callers comparing food state need only one import. */
export { FoodConfirmed };
