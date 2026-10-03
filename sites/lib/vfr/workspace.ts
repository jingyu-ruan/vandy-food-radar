/**
 * Read paths behind the workspace: one selected day and one browsed week.
 *
 * Both only read published data. Each day is loaded through the repository's
 * date-scoped batch, so one day's view can never mix in another day's rows.
 */

import { campusPlaces } from "./campus-places.ts";
import type { Config } from "./config.ts";
import type { Repository } from "./repository.ts";
import { shiftIsoDate } from "./time.ts";
import { buildDayFeed } from "./viewmodel.ts";
import type { CardJson, DayFeedJson } from "./viewmodel.ts";

export const WEEK_LENGTH = 7;

/** Build the single-day feed for `date`. Storage errors propagate. */
export async function loadDayFeed(
  repository: Repository,
  config: Config,
  date: string,
  nowMs: number = Date.now(),
): Promise<DayFeedJson> {
  const snapshot = await repository.readFeed(date, { history: false });
  const aiState = config.gemini.apiKey ? await repository.readAiState(date).catch(()=>null) : null;
  return buildDayFeed(date, snapshot, { config, places: campusPlaces(), nowMs, aiState });
}

export type WeekJson = { start: string; days: { date: string; events: CardJson[] }[] };

/** Seven consecutive days starting at `start`, each bucketed under its own date. */
export async function loadWeek(
  repository: Repository,
  config: Config,
  start: string,
  nowMs: number = Date.now(),
): Promise<WeekJson> {
  const dates = Array.from({ length: WEEK_LENGTH }, (_, offset) => shiftIsoDate(start, offset));
  const feeds = await Promise.all(
    dates.map((date) => loadDayFeed(repository, config, date, nowMs)),
  );
  return {
    start,
    days: feeds.map((feed) => ({ date: feed.date, events: feed.events })),
  };
}
