import { matchedRoutes } from "hono/route";
import { env as runtimeEnv, logger } from "@voidbase-cloud/voidbase/platform";
import { all, badRequest, loadSettings, nowString, requireSuperuser } from "@voidbase-cloud/voidbase/sdk";
import { serve } from "@voidbase-cloud/voidbase/kernel";
import { configKnob } from "@voidbase-cloud/voidbase/plugins";
import { ACCOUNT_ID_VAR, ACCOUNT_VAR, analyticsDataset, DATASET_VAR, OBSERVABILITY_VAR, observabilityOn, SAMPLE_VAR, sampleRateOf, TOKEN_VAR, WORKER_NAME_VAR, } from "@voidbase-cloud/voidbase/plugins/observability-binding";
// --- the knobs, read from the request's env first and the runtime's after, like seo's and hardening's -------------
const read = (name, env) => {
  try {
    return String(env?.[name] ?? runtimeEnv[name] ?? process.env?.[name] ?? configKnob(name) ?? "").trim();
  }
  catch {
    return "";
  }
};
/** whether the plugin records anything at all: the same knob the deploy reads, off by the same words */
export const recording = (env) => observabilityOn(read(OBSERVABILITY_VAR, env));
/** how much of the request path is sampled: 1 unless the knob lowers it */
export const samplingRate = (env) => (recording(env) ? sampleRateOf(read(SAMPLE_VAR, env)) : 0);
/** the dataset the summary queries: the knob, else the one this Worker's name derives */
export const datasetOf = (env) => read(DATASET_VAR, env) || analyticsDataset(read(WORKER_NAME_VAR, env));
/** the account and the token the SQL API needs, or null when either is missing */
export function credentials(env) {
  const account = read(ACCOUNT_VAR, env) || read(ACCOUNT_ID_VAR, env);
  const token = read(TOKEN_VAR, env);
  const dataset = datasetOf(env);
  return account && token && dataset ? { account, token, dataset } : null;
}
// --- the data point ------------------------------------------------------------------------------------------------
/** Analytics Engine takes one index and caps it at 96 bytes; a blob is kept short for the same reason */
export const INDEX_LIMIT = 96;
export const BLOB_LIMIT = 256;
const cut = (s, max) => (s.length > max ? s.slice(0, max) : s);
/** a path with its ids collapsed: what a route pattern would have said, for the paths no pattern was matched for */
export function patternOf(path) {
  return path.split("/").map((seg) => {
    if (!seg)
      return seg;
    if (/^\d+$/.test(seg))
      return ":id";
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg))
      return ":id";
    if (/^[a-z0-9]{15}$/.test(seg))
      return ":id"; // a PocketBase record id
    return seg;
  }).join("/") || "/";
}
/**
 * The route a request matched, as a pattern rather than a path.
 *
 * Hono matches the whole chain before any of it runs, so the matched routes are there for a middleware too. The
 * last one that is not a `use("*")` middleware is the handler that answered, and its registered path is what we
 * want: `/api/collections/:collection/records/:id`, not a million distinct record ids. pb_hooks routes are
 * dispatched from a single `all("*")` (src/server/hooks/index.ts), and a 404 matched no route at all; both fall
 * back to the path with its ids collapsed.
 */
export function routeOf(c) {
  try {
    const routes = matchedRoutes(c);
    for (let i = routes.length - 1; i >= 0; i--) {
      const r = routes[i];
      if (r && r.method !== "ALL" && r.path && r.path !== "*" && r.path !== "/*")
        return r.path;
    }
  }
  catch { /* no match result on this context */ }
  try {
    return patternOf(new URL(c.req.url).pathname);
  }
  catch {
    return "/";
  }
}
/** the collection a route is about, when its pattern names one */
export function collectionOf(c) {
  try {
    return String(c.req.param("collection") ?? "");
  }
  catch {
    return "";
  }
}
export const statusClassOf = (status) => (status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` : "0xx");
/**
 * One request as a data point: blobs for the route, the method, the status class and the collection; doubles for
 * the duration in milliseconds and the response size in bytes; the route as the index (the sampling key).
 *
 * The duration is elapsed time as the Worker can observe it, which advances only across I/O (the security model
 * link at the top of this file). That makes it a good measure of a slow endpoint, which is I/O, and no measure at
 * all of CPU. The size is what the answer declares in Content-Length and 0 when it declares none, which is most
 * JSON answers: nothing is buffered or cloned to find out, because that would be a real cost per request paid for
 * a number nobody asked for.
 */
export function dataPointOf(c, startedAt, status, now) {
  const route = routeOf(c);
  const size = Number(c.res?.headers.get("content-length") ?? 0);
  return {
    blobs: [cut(route, BLOB_LIMIT), c.req.method.toUpperCase(), statusClassOf(status), cut(collectionOf(c), 64)],
    doubles: [Math.max(0, now - startedAt), Number.isFinite(size) && size > 0 ? size : 0],
    indexes: [cut(route, INDEX_LIMIT)],
  };
}
/** the middleware app.ts holds a place for: measure, then record, and never let the recording touch the request */
export function sampler(now = Date.now, random = Math.random) {
  let warned = false; // one line per isolate: a broken binding must not become a log entry per request
  return async (c, next) => {
    const started = now();
    let thrown = false;
    try {
      await next();
    }
    catch (err) {
      thrown = true;
      throw err;
    }
    finally {
      const binding = c.env?.LOGS_ANALYTICS;
      const rate = samplingRate(c.env);
      if (binding && rate > 0 && (rate >= 1 || random() < rate)) {
        try {
          // a throw is on its way to app.onError, which has not written the 500 yet: it is a 5xx all the same
          binding.writeDataPoint(dataPointOf(c, started, thrown ? 500 : (c.res?.status ?? 0), now()));
        }
        catch (err) {
          if (!warned) {
            warned = true;
            logger.error("voidbase: observability could not write a data point; the request is unaffected and further failures in this isolate are silent", { error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    }
  };
}
// --- reading: Analytics Engine's SQL API -----------------------------------------------------------------------------
/**
 * https://developers.cloudflare.com/analytics/analytics-engine/sql-api/ (checked 2026-09-11): the query text is
 * the body of a POST to this address, authorised with `Authorization: Bearer <token>` by a token carrying
 * Account Analytics | Read. `FORMAT JSON` answers ClickHouse's JSON envelope, whose `data` is the rows.
 */
export const sqlApi = (account) => `https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`;
export async function queryAnalytics(o, sql, f) {
  const res = await f(sqlApi(o.account), { method: "POST", headers: { Authorization: `Bearer ${o.token}`, "Content-Type": "text/plain" }, body: sql });
  if (!res.ok)
    throw new Error(`analytics engine sql answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json());
  return Array.isArray(body.data) ? body.data : [];
}
export const windowOf = (v) => (String(v ?? "").trim().toLowerCase() === "day" ? "day" : "hour");
const interval = (w) => (w === "day" ? "INTERVAL '1' DAY" : "INTERVAL '1' HOUR");
/** a dataset name goes into the SQL text, so it is held to what a dataset name may be */
const table = (dataset) => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dataset))
  throw new Error(`"${dataset}" is not a dataset name`); return dataset; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round = (n, places = 0) => { const f = 10 ** places; return Math.round(n * f) / f; };
export const SLOWEST = 5;
/**
 * The summary from Analytics Engine: three queries, run together.
 *
 * `_sample_interval` is Analytics Engine's own downsampling weight, so a count is `SUM(_sample_interval)` and a
 * percentile is `quantileWeighted(q, column, _sample_interval)` (the sql-api page says so, and the aggregate
 * functions page documents `quantileWeighted` as the backwards-compatible spelling of `quantileExactWeighted`).
 * Our own sampling is a second factor on top of it and the dataset does not know about it, so counts are scaled
 * by 1/rate here, which is right while the rate has not changed inside the window and approximate when it has.
 */
export async function summaryFromAnalytics(o, window, rate, f) {
  const ds = table(o.dataset), since = `timestamp >= NOW() - ${interval(window)}`;
  const [totals, statuses, slowest] = await Promise.all([
    queryAnalytics(o, `SELECT SUM(_sample_interval) AS requests, sumIf(_sample_interval, blob3 = '5xx') AS errors, quantileWeighted(0.5, double1, _sample_interval) AS p50, quantileWeighted(0.95, double1, _sample_interval) AS p95, quantileWeighted(0.99, double1, _sample_interval) AS p99 FROM ${ds} WHERE ${since} FORMAT JSON`, f),
    queryAnalytics(o, `SELECT blob3 AS status, SUM(_sample_interval) AS n FROM ${ds} WHERE ${since} GROUP BY status ORDER BY status FORMAT JSON`, f),
    queryAnalytics(o, `SELECT blob1 AS route, SUM(_sample_interval) AS n, quantileWeighted(0.95, double1, _sample_interval) AS p95 FROM ${ds} WHERE ${since} GROUP BY route ORDER BY p95 DESC LIMIT ${SLOWEST} FORMAT JSON`, f),
  ]);
  const scale = rate > 0 ? 1 / rate : 1;
  const row = totals[0] ?? {};
  const requests = Math.round(num(row.requests) * scale);
  const errors = Math.round(num(row.errors) * scale);
  return {
    source: "analytics-engine", window, requests, errors,
    rate: requests ? round(errors / requests, 4) : 0,
    p50: round(num(row.p50)), p95: round(num(row.p95)), p99: round(num(row.p99)),
    slowest: slowest.map((r) => ({ route: String(r.route ?? ""), p95: round(num(r.p95)), count: Math.round(num(r.n) * scale) })),
    statuses: Object.fromEntries(statuses.map((r) => [String(r.status ?? "0xx"), Math.round(num(r.n) * scale)])),
  };
}
// --- reading: the D1 request log, which is always there ---------------------------------------------------------------
/** how many request rows the fallback reads to compute its percentiles over; the newest ones */
export const LOG_SAMPLE = 20_000;
export const percentile = (sorted, q) => {
  if (!sorted.length)
    return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i] ?? 0;
};
/** the start of the window, in the format `_logs`.created is stored in */
export const sinceOf = (window, now) => nowString(new Date(now - (window === "day" ? 86_400_000 : 3_600_000)));
/**
 * The summary from the request log.
 *
 * It is always available, which is the point of it, but it is not the same population: `_logs` keeps a row per
 * request only at or above `max(settings.logs.minLevel, VOIDBASE_LOG_MIN_LEVEL)`, and the Workers default is 4,
 * which is warnings and errors. So on a deployed instance without the Analytics Engine binding these numbers are
 * about what went wrong rather than about everything that happened, and `source` saying `request-log` is how the
 * caller knows that. The log records the path, not the route, so the route is the path with its ids collapsed.
 */
export async function summaryFromLog(db, window, now) {
  const rows = await all(db, "SELECT json_extract(`data`, '$.url') AS url, json_extract(`data`, '$.status') AS status, json_extract(`data`, '$.execTime') AS ms FROM `_logs` WHERE created >= ? AND json_extract(`data`, '$.type') = 'request' ORDER BY created DESC LIMIT ?", [sinceOf(window, now), LOG_SAMPLE]);
  const durations = [];
  const statuses = {};
  const byRoute = new Map();
  let errors = 0;
  for (const r of rows) {
    const status = num(r.status);
    const ms = num(r.ms);
    durations.push(ms);
    const klass = statusClassOf(status);
    statuses[klass] = (statuses[klass] ?? 0) + 1;
    if (status >= 500)
      errors++;
    const route = patternOf(String(r.url ?? "").split("?")[0] ?? "");
    const list = byRoute.get(route) ?? [];
    list.push(ms);
    byRoute.set(route, list);
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const slowest = [...byRoute.entries()]
    .map(([route, list]) => ({ route, p95: round(percentile([...list].sort((a, b) => a - b), 0.95)), count: list.length }))
    .sort((a, b) => b.p95 - a.p95 || b.count - a.count)
    .slice(0, SLOWEST);
  return {
    source: "request-log", window, requests: rows.length, errors,
    rate: rows.length ? round(errors / rows.length, 4) : 0,
    p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)), p99: round(percentile(sorted, 0.99)),
    slowest, statuses,
  };
}
/** Analytics Engine when it can be read, the request log when it cannot: a summary always answers something */
export async function summaryFor(env, window, f, now) {
  const creds = credentials(env);
  if (creds) {
    try {
      return await summaryFromAnalytics(creds, window, samplingRate(env) || 1, f);
    }
    catch (err) {
      logger.warn("voidbase: observability could not read Analytics Engine; answering from the request log", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return summaryFromLog(env.DB, window, now);
}
// --- reading: the log itself -------------------------------------------------------------------------------------------
/**
 * Workers Logs does have a public read API, and it is not one a Worker can use on itself for free: it is the
 * account-scoped `POST /accounts/{account_id}/workers/observability/telemetry/query`
 * (https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/),
 * so reading it needs the account id and a token with the observability read permission, exactly the credentials
 * the summary treats as optional. These two routes therefore read the D1 request log, which every instance has
 * and which needs no credentials at all. The telemetry query is the natural second source when somebody wants
 * the Worker's own log lines here too; its request body is not pinned in this file because it was not pinned from
 * the docs, and guessing at it would be worse than not having it.
 */
export const LOG_PAGE = 200;
export function parseSince(value, window, now) {
  const v = String(value ?? "").trim();
  if (!v)
    return sinceOf(window, now);
  const ms = Date.parse(v.includes("T") || !v.includes(" ") ? v : v.replace(" ", "T"));
  if (!Number.isFinite(ms))
    throw badRequest("since must be an ISO 8601 date.");
  return nowString(new Date(ms));
}
const logRow = (r) => ({
  id: r.id, created: r.created, level: r.level, message: r.message,
  data: typeof r.data === "string" ? JSON.parse(r.data) : r.data,
});
export async function errorsFromLog(db, since, limit) {
  return (await all(db, 
  // 5xx answers, plus anything the instance recorded an error for (a throw that never reached a status)
  "SELECT * FROM `_logs` WHERE created >= ? AND (CAST(json_extract(`data`, '$.status') AS INTEGER) >= 500 OR (json_extract(`data`, '$.error') IS NOT NULL AND json_extract(`data`, '$.error') != '')) ORDER BY `_logs`.rowid DESC LIMIT ?", [since, limit])).map(logRow);
}
export async function logsFromLog(db, since, level, limit) {
  const where = level === null ? "" : " AND level >= ?";
  const params = level === null ? [since, limit] : [since, level, limit];
  return (await all(db, `SELECT * FROM \`_logs\` WHERE created >= ?${where} ORDER BY \`_logs\`.rowid DESC LIMIT ?`, params)).map(logRow);
}
// --- what /api/plugins says ---------------------------------------------------------------------------------------------
/** where the numbers come from, how much of the path is sampled, and whether the fallback is being written */
export async function observabilityReport(env) {
  let logs = true;
  try {
    logs = (await loadSettings(env.DB)).logs.maxDays !== 0;
  }
  catch {
    logs = false;
  }
  return { via: credentials(env) ? "analytics-engine" : "request-log", sampling: samplingRate(env), logs };
}
// --- the routes --------------------------------------------------------------------------------------------------------
function mountRoutes(app, f, now) {
  app.get("/api/observability/summary", async (c) => {
    requireSuperuser(c);
    c.header("Cache-Control", "no-store");
    return c.json(await summaryFor(c.env, windowOf(c.req.query("window")), f, now()));
  });
  app.get("/api/observability/errors", async (c) => {
    requireSuperuser(c);
    c.header("Cache-Control", "no-store");
    const window = windowOf(c.req.query("window"));
    const since = parseSince(c.req.query("since"), window, now());
    const items = await errorsFromLog(c.env.DB, since, LOG_PAGE);
    return c.json({ source: "request-log", since, items, totalItems: items.length });
  });
  app.get("/api/observability/logs", async (c) => {
    requireSuperuser(c);
    c.header("Cache-Control", "no-store");
    const window = windowOf(c.req.query("window"));
    const since = parseSince(c.req.query("since"), window, now());
    const raw = String(c.req.query("level") ?? "").trim();
    if (raw && !Number.isFinite(Number(raw)))
      throw badRequest("level must be a number (-4 debug, 0 info, 4 warn, 8 error).");
    const level = raw ? Number(raw) : null;
    const items = await logsFromLog(c.env.DB, since, level, LOG_PAGE);
    return c.json({ source: "request-log", since, level, items, totalItems: items.length });
  });
}
/** the plugin over a clock, a fetch and a source of randomness of its own: the tests hand in all three */
export const observabilityWith = (o = {}) => {
  const now = o.now ?? Date.now;
  const f = o.fetch ?? ((url, init) => fetch(url, init));
  return {
    apply(ctx) {
      serve(ctx, "observability@1", { sample: sampler(now, o.random), report: observabilityReport });
      mountRoutes(ctx.app, f, now);
    },
  };
};
/** the shipped plugin */
const observability = observabilityWith();

// what the plugin does; its declaration is manifest.json beside this file, which the instance reads
export default observability;
