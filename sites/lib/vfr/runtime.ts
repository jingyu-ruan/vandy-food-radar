/**
 * Worker runtime wiring.
 *
 * This is the only module that reaches for the Cloudflare environment, which
 * keeps every other module importable in a plain Node process for testing.
 */

import { env } from "cloudflare:workers";
import { configFromEnv } from "./config.ts";
import type { Config } from "./config.ts";
import type { D1Like } from "./d1.ts";
import { StorageError } from "./d1.ts";
import { Repository } from "./repository.ts";
import { WalkingRouter } from "./routing.ts";

/** Build the configuration from the Worker environment. */
export function getConfig(): Config {
  return configFromEnv(env as unknown as Record<string, unknown>);
}

/**
 * Build a repository over the `DB` binding.
 *
 * A missing binding is a configuration fault, surfaced as a storage error so the
 * routes report it honestly instead of rendering an empty page.
 */
export function getRepository(config: Config): Repository {
  const database = (env as unknown as { DB?: unknown }).DB;
  if (!database) {
    throw new StorageError(
      "the D1 binding `DB` is unavailable; confirm the database is attached to this Site",
      false,
    );
  }
  return new Repository(database as D1Like, config);
}

let router: { key: string; instance: WalkingRouter } | null = null;

/**
 * One walking router per isolate, so its bounded route cache is shared across
 * requests. Rebuilt only if the routing configuration itself changes.
 */
export function getRouter(config: Config): WalkingRouter {
  const key = JSON.stringify(config.routing);
  if (!router || router.key !== key) router = { key, instance: new WalkingRouter(config) };
  return router.instance;
}

/** JSON response helper with caching disabled. */
export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}
