// Logs (apis/logs.go + apis/middlewares.go logRequest): every API request writes a _logs row after the response,
// app-level messages go through appLog, and the superuser API lists, filters, views, aggregates and truncates them.
import type { Context, Hono, MiddlewareHandler } from "hono";
import { env as voidEnv, defaultLogMinLevel } from "#platform/env";
// the platform default for request logs, overridable per deployment (PocketBase levels: -4 debug, 0 info, 4 warn, 8 error)
const envLogMinLevel = () => { const v = (voidEnv as Record<string, unknown>).VOIDBASE_LOG_MIN_LEVEL; const n = v === undefined || v === "" ? NaN : Number(v); return Number.isFinite(n) ? n : defaultLogMinLevel; };
import type { Collection } from "./collections/model";
import { all, one, run, stmt } from "./db";
import { ApiError, badRequest, notFound } from "./errors";
import { compileFilter, compileSort, FilterError } from "./filter/compile";
import { FilterSyntaxError } from "./filter/lexer";
import { nowString, randomId } from "./ids";
import { loadSettings } from "./settings";
import type { AppEnv } from "./types";
import { requireSuperuser } from "./auth";

export const LEVEL = { debug: -4, info: 0, warn: 4, error: 8 } as const;
const cut = (s: string, max: number) => (s.length > max ? s.slice(0, max) + "..." : s);
const sorted = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export async function appLog(db: D1Database, level: number, message: string, data: Record<string, unknown> = {}): Promise<void> {
  const settings = await loadSettings(db);
  if (settings.logs.maxDays === 0 || level < settings.logs.minLevel) return;
  await run(db, "INSERT INTO `_logs` (id, created, data, message, level) VALUES (?, ?, ?, ?, ?)", [randomId(), nowString(), JSON.stringify(sorted(data)), message, level]);
}

const SKIP_PREFIXES = ["/api/logs", "/api/realtime"];

// Records the request after the response is written (PocketBase logs in a goroutine; here waitUntil).
export function requestLogger(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = Date.now();
    let thrown: unknown = null;
    try { await next(); } catch (err) { thrown = err; throw err; }
    finally {
      const path = new URL(c.req.url).pathname;
      const skip = SKIP_PREFIXES.some((p) => path.startsWith(p)) && !thrown;
      if (!skip) c.executionCtx.waitUntil(logRequest(c, started, thrown).catch((err) => console.error("voidbase: request log failed", err)));
    }
  };
}

async function logRequest(c: Context<AppEnv>, started: number, err: unknown): Promise<void> {
  const settings = await loadSettings(c.env.DB);
  if (settings.logs.maxDays === 0) return;
  const url = new URL(c.req.url);
  const requestUri = cut(url.pathname + url.search, 3000);
  const method = cut(c.req.method.toUpperCase(), 50);
  const data: Record<string, unknown> = { type: "request", execTime: Date.now() - started };
  let status = c.res?.status ?? 0;
  let failed = !!err;
  if (err) {
    if (err instanceof ApiError) { if (!status || status === 500) status = err.status; data.error = err.message; data.details = err.data ?? {}; }
    else data.error = err instanceof Error ? err.message : String(err);
  } else if (status >= 400 && c.res) {
    // handlers (hook routes among them) may answer an API error directly instead of throwing it
    failed = true;
    try { const body = (await c.res.clone().json()) as { message?: string; data?: unknown }; data.error = body.message ?? ""; data.details = body.data ?? {}; } catch { data.error = `${status}`; }
  }
  Object.assign(data, { url: requestUri, method, status, referer: cut(c.req.header("Referer") ?? "", 2000), userAgent: cut(c.req.header("User-Agent") ?? "", 2000) });
  const auth = c.get("auth");
  data.auth = auth ? auth.collection.name : "";
  if (auth && settings.logs.logAuthId) data.authId = String(auth.row.id);
  if (settings.logs.logIP) {
    data.userIP = c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "127.0.0.1";
    data.remoteIP = c.req.header("CF-Connecting-IP") ?? "127.0.0.1";
  }
  const level = failed ? LEVEL.error : LEVEL.info;
  if (level < Math.max(settings.logs.minLevel, envLogMinLevel())) return;
  let message = method + " ";
  try { message += decodeURIComponent(requestUri); } catch { message += requestUri; }
  await run(c.env.DB, "INSERT INTO `_logs` (id, created, data, message, level) VALUES (?, ?, ?, ?, ?)", [randomId(), nowString(), JSON.stringify(sorted(data)), message, level]);
}

export async function deleteOldLogs(db: D1Database, maxDays: number): Promise<void> {
  if (maxDays <= 0) return;
  const before = nowString(new Date(Date.now() - maxDays * 86400_000));
  await run(db, "DELETE FROM `_logs` WHERE created <= ?", [before]);
}

// the filter/sort compiler works on a collection shape; logs get a pseudo collection with their columns
const LOGS_COLLECTION: Collection = {
  id: "_logs", name: "_logs", type: "base", system: true, listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, indexes: [], options: {}, created: "", updated: "",
  fields: [
    { id: "text_id", name: "id", type: "text", system: true, required: true, hidden: false, presentable: false },
    { id: "date_created", name: "created", type: "date", system: true, required: false, hidden: false, presentable: false },
    { id: "text_message", name: "message", type: "text", system: true, required: false, hidden: false, presentable: false },
    { id: "number_level", name: "level", type: "number", system: true, required: false, hidden: false, presentable: false },
    { id: "json_data", name: "data", type: "json", system: true, required: false, hidden: false, presentable: false },
  ] as never,
} as Collection;
const toJSON = (r: Record<string, unknown>) => ({ id: r.id, created: r.created, data: typeof r.data === "string" ? JSON.parse(r.data) : r.data, message: r.message, level: r.level });

export function mountLogsApi(app: Hono<AppEnv>) {
  const sub = (c: Context<AppEnv>) => requireSuperuser(c);
  app.get("/api/logs", async (c) => {
    sub(c);
    const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
    const perPage = Math.min(1000, Math.max(1, Number(c.req.query("perPage") ?? 30) || 30));
    let where = "1=1", params: unknown[] = [];
    try {
      const filter = c.req.query("filter") ?? "";
      if (filter.trim()) { const f = compileFilter(filter, { base: LOGS_COLLECTION, baseTable: "_logs", collections: new Map(), request: { auth: null, method: "GET", query: {}, headers: {}, body: {}, context: "default" }, allowHiddenFields: true }); where = f.where; params = f.params; }
    } catch (err) { if (err instanceof FilterError || err instanceof FilterSyntaxError) throw badRequest("Invalid filter format."); throw err; }
    const sortParam = (c.req.query("sort") ?? "").trim();
    let order = "`_logs`.rowid DESC";
    if (sortParam) {
      order = sortParam.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
        const desc = s.startsWith("-"); const name = s.replace(/^[+-]/, "");
        if (name === "rowid" || name === "@rowid") return `\`_logs\`.rowid ${desc ? "DESC" : "ASC"}`; // the panel sorts by -@rowid
        if (name.startsWith("data.")) return `json_extract(\`_logs\`.data, '$.${name.slice(5).replace(/'/g, "")}') ${desc ? "DESC" : "ASC"}`;
        if (!["id", "created", "message", "level"].includes(name)) throw badRequest("Invalid sort format.");
        return `\`_logs\`.\`${name}\` ${desc ? "DESC" : "ASC"}`;
      }).join(", ");
    }
    void compileSort;
    const total = (await one<{ n: number }>(c.env.DB, `SELECT COUNT(*) AS n FROM \`_logs\` WHERE ${where}`, params))?.n ?? 0;
    const rows = await all<Record<string, unknown>>(c.env.DB, `SELECT * FROM \`_logs\` WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, perPage, (page - 1) * perPage]);
    return c.json({ page, perPage, totalItems: total, totalPages: Math.ceil(total / perPage), items: rows.map(toJSON) });
  });
  app.get("/api/logs/stats", async (c) => {
    sub(c);
    let where = "1=1", params: unknown[] = [];
    try {
      const filter = c.req.query("filter") ?? "";
      if (filter.trim()) { const f = compileFilter(filter, { base: LOGS_COLLECTION, baseTable: "_logs", collections: new Map(), request: { auth: null, method: "GET", query: {}, headers: {}, body: {}, context: "default" }, allowHiddenFields: true }); where = f.where; params = f.params; }
    } catch (err) { if (err instanceof FilterError || err instanceof FilterSyntaxError) throw badRequest("Invalid filter format."); throw err; }
    const rows = await all<{ total: number; date: string }>(c.env.DB, `SELECT COUNT(id) AS total, strftime('%Y-%m-%d %H:00:00', created) AS date FROM \`_logs\` WHERE ${where} GROUP BY date`, params);
    return c.json(rows.map((r) => ({ date: r.date.replace(" ", " ") + ".000Z", total: r.total })));
  });
  app.get("/api/logs/:id", async (c) => {
    sub(c);
    const row = await one<Record<string, unknown>>(c.env.DB, "SELECT * FROM `_logs` WHERE id = ? LIMIT 1", [c.req.param("id") ?? ""]);
    if (!row) throw notFound();
    return c.json(toJSON(row));
  });
  app.delete("/api/logs", async (c) => {
    sub(c);
    await c.env.DB.batch([stmt(c.env.DB, "DELETE FROM `_logs`", [])]);
    return c.body(null, 204);
  });
}
