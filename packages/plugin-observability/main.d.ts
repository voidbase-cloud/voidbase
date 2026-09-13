import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, Bindings } from "@voidbase-cloud/voidbase/types";
import { type Plugin } from "@voidbase-cloud/voidbase/plugins";
/** whether the plugin records anything at all: the same knob the deploy reads, off by the same words */
export declare const recording: (env?: object) => boolean;
/** how much of the request path is sampled: 1 unless the knob lowers it */
export declare const samplingRate: (env?: object) => number;
/** the dataset the summary queries: the knob, else the one this Worker's name derives */
export declare const datasetOf: (env?: object) => string;
/** the account and the token the SQL API needs, or null when either is missing */
export declare function credentials(env?: object): {
    account: string;
    token: string;
    dataset: string;
} | null;
/** Analytics Engine takes one index and caps it at 96 bytes; a blob is kept short for the same reason */
export declare const INDEX_LIMIT = 96;
export declare const BLOB_LIMIT = 256;
/** a path with its ids collapsed: what a route pattern would have said, for the paths no pattern was matched for */
export declare function patternOf(path: string): string;
/**
 * The route a request matched, as a pattern rather than a path.
 *
 * Hono matches the whole chain before any of it runs, so the matched routes are there for a middleware too. The
 * last one that is not a `use("*")` middleware is the handler that answered, and its registered path is what we
 * want: `/api/collections/:collection/records/:id`, not a million distinct record ids. pb_hooks routes are
 * dispatched from a single `all("*")` (src/server/hooks/index.ts), and a 404 matched no route at all; both fall
 * back to the path with its ids collapsed.
 */
export declare function routeOf(c: Context<AppEnv>): string;
/** the collection a route is about, when its pattern names one */
export declare function collectionOf(c: Context<AppEnv>): string;
export declare const statusClassOf: (status: number) => string;
export interface DataPoint {
    blobs: string[];
    doubles: number[];
    indexes: string[];
}
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
export declare function dataPointOf(c: Context<AppEnv>, startedAt: number, status: number, now: number): DataPoint;
/** the middleware app.ts holds a place for: measure, then record, and never let the recording touch the request */
export declare function sampler(now?: () => number, random?: () => number): MiddlewareHandler<AppEnv>;
/**
 * https://developers.cloudflare.com/analytics/analytics-engine/sql-api/ (checked 2026-09-11): the query text is
 * the body of a POST to this address, authorised with `Authorization: Bearer <token>` by a token carrying
 * Account Analytics | Read. `FORMAT JSON` answers ClickHouse's JSON envelope, whose `data` is the rows.
 */
export declare const sqlApi: (account: string) => string;
/** as much of `fetch` as the SQL API needs, so a test hands in a function rather than a whole runtime's Response */
export type Fetch = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
}) => Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
}>;
export declare function queryAnalytics(o: {
    account: string;
    token: string;
}, sql: string, f: Fetch): Promise<Record<string, unknown>[]>;
export type Window = "hour" | "day";
export declare const windowOf: (v: string | undefined) => Window;
export interface Summary {
    /** which of the two answered: what the instance was able to read, not what it would have preferred */
    source: "analytics-engine" | "request-log";
    window: Window;
    requests: number;
    errors: number;
    /** the share of requests that answered 5xx, 0 to 1 */
    rate: number;
    p50: number;
    p95: number;
    p99: number;
    slowest: {
        route: string;
        p95: number;
        count: number;
    }[];
    statuses: Record<string, number>;
    /** what each pb_hooks handler cost the CPU. Never filled: the file's header says why */
    hooks?: {
        name: string;
        count: number;
        ms: number;
    }[];
}
export declare const SLOWEST = 5;
/**
 * The summary from Analytics Engine: three queries, run together.
 *
 * `_sample_interval` is Analytics Engine's own downsampling weight, so a count is `SUM(_sample_interval)` and a
 * percentile is `quantileWeighted(q, column, _sample_interval)` (the sql-api page says so, and the aggregate
 * functions page documents `quantileWeighted` as the backwards-compatible spelling of `quantileExactWeighted`).
 * Our own sampling is a second factor on top of it and the dataset does not know about it, so counts are scaled
 * by 1/rate here, which is right while the rate has not changed inside the window and approximate when it has.
 */
export declare function summaryFromAnalytics(o: {
    account: string;
    token: string;
    dataset: string;
}, window: Window, rate: number, f: Fetch): Promise<Summary>;
/** how many request rows the fallback reads to compute its percentiles over; the newest ones */
export declare const LOG_SAMPLE = 20000;
export declare const percentile: (sorted: number[], q: number) => number;
/** the start of the window, in the format `_logs`.created is stored in */
export declare const sinceOf: (window: Window, now: number) => string;
/**
 * The summary from the request log.
 *
 * It is always available, which is the point of it, but it is not the same population: `_logs` keeps a row per
 * request only at or above `max(settings.logs.minLevel, VOIDBASE_LOG_MIN_LEVEL)`, and the Workers default is 4,
 * which is warnings and errors. So on a deployed instance without the Analytics Engine binding these numbers are
 * about what went wrong rather than about everything that happened, and `source` saying `request-log` is how the
 * caller knows that. The log records the path, not the route, so the route is the path with its ids collapsed.
 */
export declare function summaryFromLog(db: D1Database, window: Window, now: number): Promise<Summary>;
/** Analytics Engine when it can be read, the request log when it cannot: a summary always answers something */
export declare function summaryFor(env: Bindings, window: Window, f: Fetch, now: number): Promise<Summary>;
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
export declare const LOG_PAGE = 200;
export declare function parseSince(value: string | undefined, window: Window, now: number): string;
export declare function errorsFromLog(db: D1Database, since: string, limit: number): Promise<Record<string, unknown>[]>;
export declare function logsFromLog(db: D1Database, since: string, level: number | null, limit: number): Promise<Record<string, unknown>[]>;
/** where the numbers come from, how much of the path is sampled, and whether the fallback is being written */
export declare function observabilityReport(env: Bindings): Promise<{
    via: "analytics-engine" | "request-log";
    sampling: number;
    logs: boolean;
}>;
/** the plugin over a clock, a fetch and a source of randomness of its own: the tests hand in all three */
export declare const observabilityWith: (o?: {
    fetch?: Fetch;
    now?: () => number;
    random?: () => number;
}) => Plugin;
/** the shipped plugin */
declare const observability: Omit<Plugin, "manifest">;
export default observability;
