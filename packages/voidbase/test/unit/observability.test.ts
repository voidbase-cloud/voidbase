// The observability plugin: what it records per request, what it refuses to let fail, and what the two sources
// answer when a superuser asks the instance what it has been doing.
//
// The sampler runs through the slot app.ts holds for it, rebuilt here over a small app the way the hardening test
// rebuilds its own: the kernel loads after the routes, so a plugin cannot `use("*")` for itself and the app asks
// the provider at request time. The Analytics Engine binding is a `writeDataPoint` spy, the SQL API is a stubbed
// fetch, and the request-log fallback runs on the bun:sqlite D1 shim the other tests use.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { d1 } from "../../src/node/d1";
import { authenticate, provideAuthLookup } from "../../src/server/auth-slot";
import { ApiError } from "../../src/server/errors";
import type { Auth, Observability } from "../../src/server/interfaces";
import { createKernel, load, using } from "../../src/server/kernel";
import {
  credentials, dataPointOf, errorsFromLog, logsFromLog, observability, observabilityReport, observabilityWith,
  parseSince, patternOf, percentile, samplingRate, sqlApi, statusClassOf, summaryFromAnalytics, summaryFromLog,
  windowOf, type DataPoint, type Fetch,
} from "../../src/server/plugins/observability";
import { analyticsDataset, observabilityOn, sampleRateOf, workerObservability } from "../../src/server/plugins/observability-binding";
import { CORE, removalCost, resolve as resolvePlugins } from "../../src/server/plugins/resolve";
import { SHIPPED, SHIPPED_FACTS, shippedFacts } from "../../src/server/plugins/shipped";
import { invalidateSettings } from "../../src/server/settings";
import type { AppEnv, AuthRecord, Bindings } from "../../src/server/types";

// --- the fixtures ------------------------------------------------------------------------------------------------
const SUPER = { collection: { name: "_superusers" }, row: { id: "s1" } } as unknown as AuthRecord;
const USER = { collection: { name: "users" }, row: { id: "u1" } } as unknown as AuthRecord;
const TOKENS: Record<string, AuthRecord> = { "super-token": SUPER, "user-token": USER };
const fakeAuth: Auth = {
  authenticate: async (request) => TOKENS[request.headers.get("authorization") ?? ""] ?? null,
  fromToken: async () => null,
  schema: () => [],
  collections: async () => ["users"],
  isSuperuser: (record) => record?.collection.name === "_superusers",
};
provideAuthLookup(() => fakeAuth);

/** an Analytics Engine binding that remembers every data point, or throws instead of writing one */
function spyBinding(throws = false) {
  const points: DataPoint[] = [];
  return { points, writeDataPoint(point: DataPoint) { if (throws) throw new Error("dataset not enabled"); points.push(point); } };
}

/** the knobs a request's env carries, so nothing here depends on the process environment */
const envWith = (extra: Record<string, unknown> = {}): Bindings =>
  ({ DB: {} as D1Database, STORAGE: {} as R2Bucket, VOIDBASE_WORKER_NAME: "shop-backend", ...extra }) as unknown as Bindings;

/** the slot app.ts holds for observability@1, over a couple of routes with real patterns */
async function appWith(plugin = observability) {
  const app = new Hono<AppEnv>();
  const kernel = createKernel(app);
  const observing = () => using<Observability | undefined>(kernel, "observability@1");
  app.use("*", async (c, next) => { c.set("auth", await authenticate(c.req.raw, c.env)); await next(); });
  app.use("*", (c, next) => observing()?.sample(c, next) ?? next());
  await load(kernel, [plugin], "0.9.0");
  app.get("/api/collections/:collection/records/:id", (c) => c.json({ id: c.req.param("id") }));
  app.post("/api/collections/:collection/records", (c) => c.json({ ok: true }, 201));
  app.get("/api/sized", (c) => { c.header("Content-Length", "42"); return c.json({ ok: true }); });
  app.get("/api/boom", () => { throw new Error("boom"); });
  app.onError((err, c) => (err instanceof ApiError ? err.response() : c.json({ message: "Something went wrong." }, 500)));
  const call = (path: string, o: { method?: string; token?: string; env?: Bindings } = {}) =>
    app.request(`http://shop.example${path}`, { method: o.method ?? "GET", headers: o.token ? { authorization: o.token } : {} }, o.env ?? envWith());
  return { app, kernel, call };
}

// --- the data point ------------------------------------------------------------------------------------------------
describe("one data point per request", () => {
  test("the route is the matched pattern, not the path, so ids do not explode the cardinality", async () => {
    const analytics = spyBinding();
    const { call } = await appWith();
    const res = await call("/api/collections/posts/records/abc123def456789", { env: envWith({ LOGS_ANALYTICS: analytics }) });
    expect(res.status).toBe(200);
    expect(analytics.points).toHaveLength(1);
    const point = analytics.points[0]!;
    expect(point.blobs).toEqual(["/api/collections/:collection/records/:id", "GET", "2xx", "posts"]);
    expect(point.indexes).toEqual(["/api/collections/:collection/records/:id"]);
    expect(point.doubles).toHaveLength(2);
    expect(point.doubles[0]).toBeGreaterThanOrEqual(0);
    expect(point.doubles[1]).toBe(0); // no Content-Length on a c.json answer, and nothing is buffered to find out
  });

  test("the method, the status class and the response size when the answer declares one", async () => {
    const analytics = spyBinding();
    const { call } = await appWith();
    await call("/api/collections/posts/records", { method: "POST", env: envWith({ LOGS_ANALYTICS: analytics }) });
    await call("/api/sized", { env: envWith({ LOGS_ANALYTICS: analytics }) });
    expect(analytics.points[0]!.blobs).toEqual(["/api/collections/:collection/records", "POST", "2xx", "posts"]);
    expect(analytics.points[1]!.blobs).toEqual(["/api/sized", "GET", "2xx", ""]);
    expect(analytics.points[1]!.doubles[1]).toBe(42);
  });

  test("a request that threw is recorded as 5xx, and a path that matched no route falls back to the path with its ids collapsed", async () => {
    const analytics = spyBinding();
    const { call } = await appWith();
    const boom = await call("/api/boom", { env: envWith({ LOGS_ANALYTICS: analytics }) });
    expect(boom.status).toBe(500);
    expect(analytics.points[0]!.blobs[2]).toBe("5xx");
    await call("/nothing/here/999", { env: envWith({ LOGS_ANALYTICS: analytics }) });
    expect(analytics.points[1]!.blobs[0]).toBe("/nothing/here/:id");
  });

  test("without the binding nothing is written and the request is unchanged", async () => {
    const { call } = await appWith();
    const res = await call("/api/collections/posts/records/abc123def456789");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "abc123def456789" });
  });

  test("a write that throws does not fail the request", async () => {
    const analytics = spyBinding(true);
    const { call } = await appWith();
    const res = await call("/api/collections/posts/records/abc123def456789", { env: envWith({ LOGS_ANALYTICS: analytics }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "abc123def456789" });
  });

  test("the sampling rate is honoured: the knob decides which requests are recorded at all", async () => {
    const analytics = spyBinding();
    const rolls = [0.05, 0.5, 0.9, 0.01];
    let i = 0;
    const { call } = await appWith(observabilityWith({ random: () => rolls[i++] ?? 1 }));
    const env = envWith({ LOGS_ANALYTICS: analytics, VOIDBASE_OBSERVABILITY_SAMPLE: "0.1" });
    for (const _ of rolls) await call("/api/collections/posts/records/abc123def456789", { env });
    expect(analytics.points).toHaveLength(2); // 0.05 and 0.01 are under 0.1; 0.5 and 0.9 are not
    expect(samplingRate(env)).toBe(0.1);
  });

  test("the knob off records nothing, whatever is bound", async () => {
    const analytics = spyBinding();
    const { call } = await appWith();
    await call("/api/sized", { env: envWith({ LOGS_ANALYTICS: analytics, VOIDBASE_OBSERVABILITY: "0" }) });
    expect(analytics.points).toHaveLength(0);
    expect(samplingRate(envWith({ VOIDBASE_OBSERVABILITY: "0" }))).toBe(0);
  });

  test("the knobs read the same words on both sides of the deploy", () => {
    expect(observabilityOn(undefined)).toBe(true);
    expect(observabilityOn("")).toBe(true);
    expect(["0", "false", "off", "no"].map(observabilityOn)).toEqual([false, false, false, false]);
    expect(sampleRateOf(undefined)).toBe(1);
    expect(sampleRateOf("0.1")).toBe(0.1);
    expect(sampleRateOf("nonsense")).toBe(1);
    expect(sampleRateOf("5")).toBe(1);
    expect(sampleRateOf("0")).toBe(0);
    expect(analyticsDataset("shop-backend")).toBe("shop_backend_requests");
    expect(workerObservability(0.1)).toEqual({ enabled: true, head_sampling_rate: 0.1 });
  });

  test("the pieces of a data point on their own", () => {
    expect(statusClassOf(204)).toBe("2xx");
    expect(statusClassOf(404)).toBe("4xx");
    expect(statusClassOf(0)).toBe("0xx");
    expect(patternOf("/api/collections/posts/records/8f14e45fceea167")).toBe("/api/collections/posts/records/:id");
    expect(patternOf("/api/x/12/y/550e8400-e29b-41d4-a716-446655440000")).toBe("/api/x/:id/y/:id");
    expect(typeof dataPointOf).toBe("function");
  });
});

// --- the summary from Analytics Engine -------------------------------------------------------------------------------
/** the SQL API, scripted per query kind; every call is remembered so the SQL itself can be read back */
function fakeSql(rows: { totals?: Record<string, unknown>[]; statuses?: Record<string, unknown>[]; slowest?: Record<string, unknown>[] }, fail = false): { fetch: Fetch; calls: { url: string; sql: string; auth: string }[] } {
  const calls: { url: string; sql: string; auth: string }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, sql: init.body, auth: init.headers.Authorization ?? "" });
    if (fail) return { ok: false, status: 403, text: async () => "no permission", json: async () => ({}) };
    const data = init.body.includes("GROUP BY status") ? rows.statuses : init.body.includes("GROUP BY route") ? rows.slowest : rows.totals;
    return { ok: true, status: 200, text: async () => "", json: async () => ({ data: data ?? [] }) };
  };
  return { fetch, calls };
}

const ANALYTICS_ROWS = {
  totals: [{ requests: 1000, errors: 20, p50: 12, p95: 140, p99: 460 }],
  statuses: [{ status: "2xx", n: 900 }, { status: "4xx", n: 80 }, { status: "5xx", n: 20 }],
  slowest: [{ route: "/api/collections/:collection/records", n: 300, p95: 220.4 }, { route: "/api/health", n: 700, p95: 4 }],
};

describe("the summary from Analytics Engine", () => {
  test("three queries against the SQL API, with the numbers it answered", async () => {
    const { fetch, calls } = fakeSql(ANALYTICS_ROWS);
    const summary = await summaryFromAnalytics({ account: "acc123", token: "tok", dataset: "shop_backend_requests" }, "hour", 1, fetch);
    expect(summary).toEqual({
      source: "analytics-engine", window: "hour", requests: 1000, errors: 20, rate: 0.02, p50: 12, p95: 140, p99: 460,
      slowest: [{ route: "/api/collections/:collection/records", p95: 220, count: 300 }, { route: "/api/health", p95: 4, count: 700 }],
      statuses: { "2xx": 900, "4xx": 80, "5xx": 20 },
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]!.url).toBe(sqlApi("acc123"));
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/analytics_engine/sql");
    expect(calls[0]!.auth).toBe("Bearer tok");
    for (const c of calls) {
      expect(c.sql).toContain("FROM shop_backend_requests");
      expect(c.sql).toContain("_sample_interval"); // counts and percentiles are weighted by it, as the docs say
      expect(c.sql).toContain("NOW() - INTERVAL '1' HOUR");
      expect(c.sql).toContain("FORMAT JSON");
    }
  });

  test("a day window asks for a day, and our own sampling rate scales the counts back up", async () => {
    const { fetch, calls } = fakeSql(ANALYTICS_ROWS);
    const summary = await summaryFromAnalytics({ account: "acc123", token: "tok", dataset: "shop_backend_requests" }, "day", 0.1, fetch);
    expect(calls[0]!.sql).toContain("NOW() - INTERVAL '1' DAY");
    expect(summary.requests).toBe(10_000);
    expect(summary.errors).toBe(200);
    expect(summary.statuses).toEqual({ "2xx": 9000, "4xx": 800, "5xx": 200 });
    expect(summary.p95).toBe(140); // a percentile is not a count: it is not scaled
  });

  test("a dataset name that is not one never reaches the SQL text", async () => {
    const { fetch } = fakeSql(ANALYTICS_ROWS);
    await expect(summaryFromAnalytics({ account: "a", token: "t", dataset: "x; DROP TABLE y" }, "hour", 1, fetch)).rejects.toThrow("is not a dataset name");
  });

  test("the window parameter only knows two windows", () => {
    expect(windowOf("day")).toBe("day");
    expect(windowOf("hour")).toBe("hour");
    expect(windowOf(undefined)).toBe("hour");
    expect(windowOf("week")).toBe("hour");
  });

  test("the credentials are both or neither, and the account falls back to the one the deploy bakes", () => {
    expect(credentials(envWith())).toBeNull();
    expect(credentials(envWith({ VOIDBASE_OBSERVABILITY_TOKEN: "tok" }))).toBeNull();
    expect(credentials(envWith({ VOIDBASE_ACCOUNT_ID: "acc123", VOIDBASE_OBSERVABILITY_TOKEN: "tok" }))).toEqual({ account: "acc123", token: "tok", dataset: "shop_backend_requests" });
    expect(credentials(envWith({ VOIDBASE_ACCOUNT_ID: "acc123", VOIDBASE_OBSERVABILITY_ACCOUNT_ID: "other", VOIDBASE_OBSERVABILITY_TOKEN: "tok" }))!.account).toBe("other");
  });
});

// --- the summary from the request log ---------------------------------------------------------------------------------
const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString().replace("T", " ");

function logDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE `_logs` (`id` text PRIMARY KEY NOT NULL, `created` text DEFAULT '' NOT NULL, `data` text DEFAULT '{}' NOT NULL, `message` text DEFAULT '' NOT NULL, `level` integer DEFAULT 0 NOT NULL)");
  let n = 0;
  const add = (minutesAgo: number, data: Record<string, unknown>, level = 0, message = "GET /") =>
    sqlite.run("INSERT INTO `_logs` (id, created, data, message, level) VALUES (?, ?, ?, ?, ?)", [`l${++n}`, at(minutesAgo), JSON.stringify(data), message, level]);
  return { sqlite, db: d1(sqlite), add };
}

/** eight request rows inside the hour and one outside it, with the durations the percentiles are read from */
function seedRequests(add: ReturnType<typeof logDb>["add"]) {
  const rows: [string, number, number][] = [
    ["/api/collections/posts/records", 200, 5], ["/api/collections/posts/records", 200, 9],
    ["/api/collections/posts/records/8f14e45fceea167", 200, 11], ["/api/health", 200, 2],
    ["/api/collections/posts/records?page=2", 404, 7], ["/api/collections/posts/records", 500, 900],
    ["/api/collections/posts/records", 500, 700], ["/api/backups", 200, 300],
  ];
  rows.forEach(([url, status, execTime], i) => add(i + 1, { type: "request", url, method: "GET", status, execTime, ...(status >= 500 ? { error: "boom" } : {}) }, status >= 400 ? 8 : 0));
  add(120, { type: "request", url: "/api/health", method: "GET", status: 200, execTime: 1 }); // two hours ago
  add(3, { message: "not a request" }, 4, "something else"); // an app log line, not a request
}

describe("the summary from the D1 request log, which is always there", () => {
  test("the numbers, the status classes and the slowest routes, over the window only", async () => {
    const { db, add } = logDb();
    seedRequests(add);
    const summary = await summaryFromLog(db, "hour", NOW);
    expect(summary.source).toBe("request-log");
    expect(summary.window).toBe("hour");
    expect(summary.requests).toBe(8);
    expect(summary.errors).toBe(2);
    expect(summary.rate).toBe(0.25);
    expect(summary.statuses).toEqual({ "2xx": 5, "4xx": 1, "5xx": 2 });
    expect(summary.p50).toBe(9);
    expect(summary.p95).toBe(900);
    expect(summary.p99).toBe(900);
    expect(summary.slowest[0]).toEqual({ route: "/api/collections/posts/records", p95: 900, count: 5 }); // the query string is not part of the route
    expect(summary.slowest.map((s) => s.route)).toContain("/api/collections/posts/records/:id");
    expect(summary.hooks).toBeUndefined(); // hook CPU is not measured; the plugin says so rather than inventing one
  });

  test("a day window reaches the row an hour window does not", async () => {
    const { db, add } = logDb();
    seedRequests(add);
    expect((await summaryFromLog(db, "day", NOW)).requests).toBe(9);
  });

  test("an empty log answers zeroes rather than nothing", async () => {
    const { db } = logDb();
    expect(await summaryFromLog(db, "hour", NOW)).toEqual({ source: "request-log", window: "hour", requests: 0, errors: 0, rate: 0, p50: 0, p95: 0, p99: 0, slowest: [], statuses: {} });
  });

  test("percentiles over a known list", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 0.5)).toBe(5);
    expect(percentile(sorted, 0.95)).toBe(10);
    expect(percentile([], 0.5)).toBe(0);
  });

  test("errors are the 5xx answers and the exceptions the instance recorded", async () => {
    const { db, add } = logDb();
    seedRequests(add);
    add(2, { type: "request", url: "/api/x", method: "GET", status: 200, execTime: 1, error: "a handler answered but something went wrong" }, 8);
    const items = await errorsFromLog(db, at(60), 200);
    expect(items).toHaveLength(3);
    expect(items.every((i) => { const d = i.data as { status?: number; error?: string }; return (d.status ?? 0) >= 500 || !!d.error; })).toBe(true);
    expect((items[0]!.data as { error: string }).error).toBe("a handler answered but something went wrong"); // newest first
  });

  test("logs are the log, filtered by level and by when", async () => {
    const { db, add } = logDb();
    seedRequests(add);
    expect(await logsFromLog(db, at(60), null, 200)).toHaveLength(9); // the eight requests and the app line
    expect(await logsFromLog(db, at(60), 8, 200)).toHaveLength(3);
    expect(await logsFromLog(db, at(2), null, 200)).toHaveLength(2);
    const one = (await logsFromLog(db, at(60), 8, 1))[0]!;
    expect(Object.keys(one).sort()).toEqual(["created", "data", "id", "level", "message"]);
    expect(typeof one.data).toBe("object"); // the JSON column is parsed, as /api/logs does it
  });

  test("since is an ISO date, and anything else is a 400", () => {
    expect(parseSince(undefined, "hour", NOW)).toBe("2026-09-11 11:00:00.000Z");
    expect(parseSince("2026-09-11T09:30:00.000Z", "hour", NOW)).toBe("2026-09-11 09:30:00.000Z");
    expect(parseSince("2026-09-11 09:30:00.000Z", "hour", NOW)).toBe("2026-09-11 09:30:00.000Z");
    expect(() => parseSince("yesterday", "hour", NOW)).toThrow(ApiError);
  });
});

// --- the routes ---------------------------------------------------------------------------------------------------------
describe("the three routes, behind the superuser", () => {
  const dbEnv = () => { const { db, add } = logDb(); seedRequests(add); return { env: envWith({ DB: db }), db }; };

  test("anonymous is 401, a signed-in record is 403, a superuser is 200", async () => {
    const { call } = await appWith();
    const { env } = dbEnv();
    for (const path of ["/api/observability/summary", "/api/observability/errors", "/api/observability/logs"]) {
      expect((await call(path, { env })).status).toBe(401);
      expect((await call(path, { token: "user-token", env })).status).toBe(403);
      expect((await call(path, { token: "super-token", env })).status).toBe(200);
    }
  });

  test("the summary answers from the request log when no token is set, and says so", async () => {
    const { call } = await appWith(observabilityWith({ now: () => NOW }));
    const { env } = dbEnv();
    const body = (await (await call("/api/observability/summary", { token: "super-token", env })).json()) as { source: string; requests: number; errors: number; slowest: unknown[] };
    expect(body.source).toBe("request-log");
    expect(body.requests).toBe(8);
    expect(body.errors).toBe(2);
    expect(body.slowest.length).toBeGreaterThan(0);
  });

  test("the summary answers from Analytics Engine when the account and the token are there, and says so", async () => {
    const { fetch, calls } = fakeSql(ANALYTICS_ROWS);
    const { call } = await appWith(observabilityWith({ fetch, now: () => NOW }));
    const { db } = dbEnv();
    const env = envWith({ DB: db, VOIDBASE_ACCOUNT_ID: "acc123", VOIDBASE_OBSERVABILITY_TOKEN: "tok" });
    const body = (await (await call("/api/observability/summary?window=day", { token: "super-token", env })).json()) as { source: string; window: string; requests: number };
    expect(body.source).toBe("analytics-engine");
    expect(body.window).toBe("day");
    expect(body.requests).toBe(1000);
    expect(calls[0]!.sql).toContain("NOW() - INTERVAL '1' DAY");
  });

  test("a SQL API that refuses falls back to the request log rather than failing the route", async () => {
    const { fetch } = fakeSql(ANALYTICS_ROWS, true);
    const { call } = await appWith(observabilityWith({ fetch, now: () => NOW }));
    const { db } = dbEnv();
    const env = envWith({ DB: db, VOIDBASE_ACCOUNT_ID: "acc123", VOIDBASE_OBSERVABILITY_TOKEN: "tok" });
    const res = await call("/api/observability/summary", { token: "super-token", env });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { source: string }).source).toBe("request-log");
  });

  test("errors and logs answer the shape the panel reads", async () => {
    const { call } = await appWith(observabilityWith({ now: () => NOW }));
    const { env } = dbEnv();
    const errors = (await (await call("/api/observability/errors", { token: "super-token", env })).json()) as { source: string; since: string; items: unknown[]; totalItems: number };
    expect(errors.source).toBe("request-log");
    expect(errors.since).toBe("2026-09-11 11:00:00.000Z");
    expect(errors.totalItems).toBe(errors.items.length);
    expect(errors.totalItems).toBe(2);
    const logs = (await (await call("/api/observability/logs?level=8", { token: "super-token", env })).json()) as { level: number; items: unknown[]; totalItems: number };
    expect(logs.level).toBe(8);
    expect(logs.totalItems).toBe(3);
    const bad = await call("/api/observability/logs?level=loud", { token: "super-token", env });
    expect(bad.status).toBe(400);
  });

  test("the summary is never cached", async () => {
    const { call } = await appWith(observabilityWith({ now: () => NOW }));
    const { env } = dbEnv();
    expect((await call("/api/observability/summary", { token: "super-token", env })).headers.get("cache-control")).toBe("no-store");
  });
});

// --- what the instance says about itself -----------------------------------------------------------------------------------
describe("the plugin in the graph, and the /api/plugins field", () => {
  test("observability is a shipped core plugin providing observability@1", () => {
    expect(observability.manifest).toMatchObject({ name: "observability", tier: "core", provides: ["observability@1"] });
    expect(SHIPPED).toContain("observability");
    expect(SHIPPED_FACTS.observability).toEqual({ tier: "core", provides: ["observability@1"] });
  });

  test("it is the second core interface, and an instance without a provider says what it is missing", () => {
    expect(CORE).toEqual(["auth@1", "observability@1"]);
    const { missingCore, problems } = resolvePlugins([{ manifest: { name: "backups", version: "0.1.0", tier: "official", voidbase: "*" } }], "0.9.0");
    expect(problems).toEqual([]);
    expect(missingCore).toEqual(["auth@1", "observability@1"]);
  });

  test("removing it costs something a person has to be told before they do it", () => {
    const cost = removalCost(shippedFacts(), "observability")!;
    expect(cost.core).toBe(true);
    expect(cost.provides).toEqual(["observability@1"]);
    expect(cost.reason).toContain("observability is a core plugin: it provides observability@1");
    expect(cost.reason).toContain("/api/observability answers 404");
  });

  test("/api/plugins reports the source, the rate and whether the request log is being written", async () => {
    const { db, sqlite } = logDb();
    sqlite.run("CREATE TABLE `_params` (`id` text PRIMARY KEY NOT NULL, `value` text, `created` text, `updated` text)");
    invalidateSettings();
    expect(await observabilityReport(envWith({ DB: db }))).toEqual({ via: "request-log", sampling: 1, logs: true });
    expect(await observabilityReport(envWith({ DB: db, VOIDBASE_ACCOUNT_ID: "acc123", VOIDBASE_OBSERVABILITY_TOKEN: "tok", VOIDBASE_OBSERVABILITY_SAMPLE: "0.25" })))
      .toEqual({ via: "analytics-engine", sampling: 0.25, logs: true });
    // an instance whose settings cannot be read at all: the fallback is not known to be there, and it says so
    invalidateSettings();
    expect(await observabilityReport(envWith({ DB: logDb().db }))).toEqual({ via: "request-log", sampling: 1, logs: false });
  });

  test("the provider fills the interface the slot asks for", async () => {
    const kernel = createKernel(new Hono() as never);
    const loaded = await load(kernel, [observability], "0.9.0");
    expect(loaded.providers["observability@1"]).toBe("observability");
    const provided = using<Observability>(kernel, "observability@1");
    expect(typeof provided.sample).toBe("function");
    expect(typeof provided.report).toBe("function");
  });

  test("without a provider the slot passes through: nothing measured, nothing broken", async () => {
    const app = new Hono<AppEnv>();
    const kernel = createKernel(app);
    const observing = () => using<Observability | undefined>(kernel, "observability@1");
    app.use("*", (c, next) => observing()?.sample(c, next) ?? next());
    app.get("/api/health", (c) => c.json({ ok: true }));
    await load(kernel, [], "0.9.0");
    const analytics = spyBinding();
    const res = await app.request("http://shop.example/api/health", {}, envWith({ LOGS_ANALYTICS: analytics }));
    expect(res.status).toBe(200);
    expect(analytics.points).toHaveLength(0);
  });
});
