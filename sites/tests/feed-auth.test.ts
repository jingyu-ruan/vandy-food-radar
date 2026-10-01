/**
 * Read-path states and the refresh authorization boundary.
 *
 * The four read states must stay distinguishable, because conflating any of them
 * misleads the user about whether campus is quiet or the app is broken. The auth
 * cases check that the endpoint fails closed by default and that relying on the
 * owner-private deployment boundary still blocks a cross-site mutation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { authorizeLegacyCron, authorizeRefresh, originAllowed } from "../lib/vfr/auth.ts";
import { configFromEnv, defaultConfig } from "../lib/vfr/config.ts";
import { feedViewToJson, loadFeedView } from "../lib/vfr/feed.ts";
import { htmlToPlainText } from "../lib/vfr/text.ts";
import { Repository } from "../lib/vfr/repository.ts";
import { FakeDb } from "./helpers.ts";

const NOW = Date.UTC(2025, 2, 11, 18);
const TARGET = "2025-03-12";

function feedRow(publishedAt: string, eventCount: number) {
  return {
    target_date: TARGET,
    timezone: "America/Chicago",
    target_window: "next_day",
    event_count: eventCount,
    published_at: publishedAt,
    source_total: eventCount,
  };
}

test("a day that was never published reads as uninitialized", async () => {
  const repository = new Repository(new FakeDb(), defaultConfig());
  const view = await loadFeedView(repository, defaultConfig(), NOW);
  assert.equal(view.state, "uninitialized");
  assert.match(view.message, /No listing has been published/);
  assert.equal(view.publishedAt, null);
  assert.equal(view.stale, false);
});

test("a published day with no matches reads as genuinely empty", async () => {
  const db = new FakeDb({
    firstRows: [{ match: "FROM feeds WHERE target_date", row: feedRow("2025-03-11T17:30:00Z", 0) }],
  });
  const view = await loadFeedView(new Repository(db, defaultConfig()), defaultConfig(), NOW);
  assert.equal(view.state, "empty");
  assert.match(view.message, /no approved public AnchorLink events/i);
  assert.equal(view.stale, false);
  assert.equal(feedViewToJson(view).eventCount, 0);
});

test("a feed older than the staleness window is shown but flagged", async () => {
  const db = new FakeDb({
    firstRows: [{ match: "FROM feeds WHERE target_date", row: feedRow("2025-03-11T12:00:00Z", 0) }],
  });
  const view = await loadFeedView(new Repository(db, defaultConfig()), defaultConfig(), NOW);
  // Published six hours before "now", against a two-hour window.
  assert.equal(view.stale, true);
  assert.equal(view.ageMs, 6 * 3600000);
  // Still reported as a real publication, not discarded.
  assert.equal(view.state, "empty");
  assert.equal(view.publishedAt, "2025-03-11T12:00:00Z");
});

test("a storage failure reads as unavailable rather than as an empty day", async () => {
  const db = new FakeDb({ failOn: "FROM feeds", failWith: new Error("D1 network error") });
  const view = await loadFeedView(new Repository(db, defaultConfig()), defaultConfig(), NOW);
  assert.equal(view.state, "unavailable");
  assert.equal(view.schemaMissing, false);
  assert.match(view.message, /temporarily unavailable/);
  assert.equal(view.snapshot, null);
});

test("a missing table is reported to the visitor as a plain outage", async () => {
  const db = new FakeDb({
    failOn: "FROM feeds",
    failWith: new Error("D1_ERROR: no such table: feeds"),
  });
  const view = await loadFeedView(new Repository(db, defaultConfig()), defaultConfig(), NOW);
  assert.equal(view.state, "unavailable");
  // The cause is retained for the operator and the health route.
  assert.equal(view.schemaMissing, true);
  // The visitor is not told to apply a migration they cannot apply.
  assert.match(view.message, /temporarily unavailable/);
  assert.doesNotMatch(view.message, /migration|schema|storage is not initialized/i);
});

test("the JSON projection exposes the state and never fabricates events", async () => {
  const db = new FakeDb({ failOn: "FROM feeds", failWith: new Error("boom") });
  const json = feedViewToJson(
    await loadFeedView(new Repository(db, defaultConfig()), defaultConfig(), NOW),
  );
  assert.equal(json.state, "unavailable");
  assert.deepEqual(json.events, []);
  assert.equal(json.eventCount, 0);
});

function request(
  init: { method?: string; headers?: Record<string, string>; url?: string } = {},
): Request {
  return new Request(init.url ?? "https://example.sites.dev/api/refresh", {
    method: init.method ?? "POST",
    headers: init.headers,
  });
}

test("refresh fails closed when neither a token nor the private flag is set", async () => {
  const decision = await authorizeRefresh(request(), defaultConfig());
  assert.equal(decision.allowed, false);
  assert.ok(!decision.allowed && decision.status === 503);
  assert.ok(!decision.allowed && /not configured/.test(decision.reason));
});

test("a correct bearer token authorizes the refresh", async () => {
  const config = defaultConfig();
  config.refreshToken = "s3cret-value";
  const ok = await authorizeRefresh(
    request({ headers: { authorization: "Bearer s3cret-value" } }),
    config,
  );
  assert.deepEqual(ok, { allowed: true, via: "token" });

  const wrong = await authorizeRefresh(
    request({ headers: { authorization: "Bearer wrong" } }),
    config,
  );
  assert.equal(wrong.allowed, false);
  assert.ok(!wrong.allowed && wrong.status === 401);
});

test("the platform service header is never compared against the refresh token", async () => {
  const config = defaultConfig();
  config.refreshToken = "s3cret-value";
  // OAI-Sites-Authorization is dispatch's own service-access credential. Even
  // when its value happens to match, it is not this app's bearer token.
  const rejected = await authorizeRefresh(
    request({ headers: { "oai-sites-authorization": "Bearer s3cret-value" } }),
    config,
  );
  assert.equal(rejected.allowed, false);
  assert.ok(!rejected.allowed && rejected.status === 401);

  // Owner-private service access still works: dispatch has already authorized
  // the caller, and no Origin means it is not a browser.
  const privateConfig = defaultConfig();
  privateConfig.ownerPrivate = true;
  const allowed = await authorizeRefresh(
    request({ headers: { "oai-sites-authorization": "Bearer platform-credential" } }),
    privateConfig,
  );
  assert.deepEqual(allowed, { allowed: true, via: "owner_private" });
});

test("an owner-private deployment allows a service caller with no Origin", async () => {
  const config = defaultConfig();
  config.ownerPrivate = true;
  const decision = await authorizeRefresh(request(), config);
  assert.deepEqual(decision, { allowed: true, via: "owner_private" });
});

test("an owner-private deployment allows a same-origin browser mutation", async () => {
  const config = defaultConfig();
  config.ownerPrivate = true;
  const decision = await authorizeRefresh(
    request({ headers: { origin: "https://example.sites.dev" } }),
    config,
  );
  assert.deepEqual(decision, { allowed: true, via: "owner_private" });
});

test("an owner-private deployment rejects a cross-origin mutation", async () => {
  const config = defaultConfig();
  config.ownerPrivate = true;
  const decision = await authorizeRefresh(
    request({ headers: { origin: "https://attacker.example" } }),
    config,
  );
  assert.equal(decision.allowed, false);
  assert.ok(!decision.allowed && decision.status === 403);
});

test("a forwarded host is treated as the real deployment origin", () => {
  assert.equal(
    originAllowed(
      new Request("https://internal.worker.dev/api/refresh", {
        method: "POST",
        headers: {
          origin: "https://app.example.com",
          "x-forwarded-host": "app.example.com",
          "x-forwarded-proto": "https",
        },
      }),
    ),
    true,
  );
  assert.equal(
    originAllowed(
      new Request("https://internal.worker.dev/api/refresh", {
        method: "POST",
        headers: { origin: "http://app.example.com", "x-forwarded-host": "app.example.com" },
      }),
    ),
    false,
  );
});

test("the legacy cron route always requires the token", async () => {
  const privateConfig = defaultConfig();
  privateConfig.ownerPrivate = true;
  // The private boundary does not substitute for the token on this route.
  const unauthorized = await authorizeLegacyCron(request({ method: "GET" }), privateConfig);
  assert.equal(unauthorized.allowed, false);
  assert.ok(!unauthorized.allowed && unauthorized.status === 503);

  privateConfig.refreshToken = "tok";
  const missing = await authorizeLegacyCron(request({ method: "GET" }), privateConfig);
  assert.ok(!missing.allowed && missing.status === 401);

  const ok = await authorizeLegacyCron(
    request({ method: "GET", headers: { authorization: "Bearer tok" } }),
    privateConfig,
  );
  assert.deepEqual(ok, { allowed: true, via: "token" });
});

test("configuration reads secrets from the environment and clamps ranges", () => {
  const config = configFromEnv({
    VFR_TIMEZONE: "America/New_York",
    VFR_TARGET_WINDOW: "today",
    VFR_OWNER_PRIVATE: "true",
    CRON_SECRET: "from-env",
    VFR_ANCHORLINK_PAGE_SIZE: "5000",
    VFR_STALE_AFTER_HOURS: "3",
    VFR_TARGET_WINDOW_UNKNOWN: "nonsense",
  });
  assert.equal(config.timezone, "America/New_York");
  assert.equal(config.targetWindow, "today");
  assert.equal(config.ownerPrivate, true);
  assert.equal(config.refreshToken, "from-env");
  // Page size is clamped to the documented API maximum.
  assert.equal(config.anchorLink.pageSize, 100);
  assert.equal(config.staleAfterMs, 3 * 3600000);

  // An unrecognized value falls back to the default rather than throwing.
  assert.equal(configFromEnv({ VFR_TARGET_WINDOW: "yesterday" }).targetWindow, "next_day");
  // VFR_REFRESH_TOKEN takes precedence over CRON_SECRET.
  assert.equal(
    configFromEnv({ VFR_REFRESH_TOKEN: "explicit", CRON_SECRET: "fallback" }).refreshToken,
    "explicit",
  );
});

test("source HTML is reduced to plain text with no markup surviving", () => {
  assert.equal(
    htmlToPlainText('<p>Free <b>pizza</b> &amp; salad</p><script>alert(1)</script>'),
    "Free pizza & salad",
  );
  assert.equal(htmlToPlainText('<img src=x onerror="alert(1)">Snacks'), "Snacks");
  assert.equal(htmlToPlainText("<style>body{}</style>  "), null);
  assert.equal(htmlToPlainText("   "), null);
  assert.equal(htmlToPlainText(null), null);
  // Nothing that could be interpreted as a tag remains.
  const cleaned = htmlToPlainText("<div onclick='x'>a</div><iframe></iframe>b");
  assert.ok(cleaned !== null && !cleaned.includes("<") && !cleaned.includes(">"));
});
