import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { authMethods, authRefresh, authWithPassword, findAuthRecordByToken, isSuperuser, loadAuth, requireSuperuser } from "./auth";
import { ensureBootstrapped } from "./bootstrap";
import { collectionToJSON, findCollection, invalidateCollections, listCollections, loadCollections, type Collection } from "./collections/model";
import type { Field } from "./collections/fields";
import { createRecord, deleteRecord, listRecords, updateRecord, viewRecord, type ListQuery, type RecordContext } from "./records/service";
import { fromColumn, toColumn } from "./records/values";
import { expandRecords } from "./records/expand";
import { hookGlobals, hookMiddleware, loadHooks, mountHookRoutes } from "./hooks";
import { requestHook, requestHookResult, trigger } from "./hooks/runtime";
import type { Settings } from "./settings";
import { applyPendingMigrations } from "./hooks/migrations";
import { RangeNotSatisfiable, resolveServedFile } from "./records/thumbs";
import { deletePrefix } from "./records/files";
import { mountWebAuthn } from "./webauthn";
import { authWithOAuth2, mountOAuth2Redirect } from "./oauth2";
import { mountSettingsApi } from "./settings-api";
import { mountAuthFlows } from "./auth-flows";
import { mountAuthExtra } from "./auth-extra";
import { mountFilesApi, protectedAccess } from "./files-api";
import { BATCH_CONTEXT_HEADER, batchContextToken, mountBatch } from "./batch";
import { mountLogsApi, requestLogger } from "./logs";
import { mountCronsApi } from "./crons";
import { mountBackupsApi } from "./backups";
import { mountSqlApi } from "./sql";
import { bodyLimitMiddleware, rateLimitMiddleware, realIPWith } from "./hardening";
import { backupActive } from "./backups";
import { installServices, RequestEvent, authToHookRecord, hookStore } from "./hooks/runtime";
import { CollectionRef, HookRecord } from "./hooks/record";
import { saveHookRecord } from "./records/service";
import { compileFilter, renderJoin } from "./filter/compile";
import { connect as realtimeConnect, setSubscriptions as realtimeSetSubscriptions } from "./realtime";
import oauth2Providers from "./collections/oauth2-providers.json";
import scaffolds from "./collections/scaffolds.json";
import { all, ident, one } from "./db";
import { ApiError, badRequest, forbidden, notFound } from "./errors";
import { randomIdSuffix } from "./ids";
import { createCollection, deleteCollection, importCollections, truncateCollection, updateCollection } from "./collections/service";
import { loadSettings, publicSettings } from "./settings";
import type { AppEnv, Row } from "./types";

export const app = new Hono<AppEnv>();
let served = false; // onBootstrap / onServe fire once per isolate, on the first request

app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS", "HEAD"] }));

// PocketBase's default security headers.
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "SAMEORIGIN");
  c.header("X-Xss-Protection", "1; mode=block");
  c.header("Cross-Origin-Opener-Policy", "same-origin");
});

app.use("*", async (c, next) => {
  await ensureBootstrapped(c.env.DB, (db) => applyPendingMigrations(db, hookGlobals(), c.env));
  if (!served) { served = true; await trigger("onBootstrap", { app: undefined as unknown, next: async () => undefined as unknown }, null, async () => undefined); await trigger("onServe", { app: undefined as unknown, router: app, next: async () => undefined as unknown }, null, async () => undefined); }
  c.set("auth", await loadAuth(c));
  await next();
});
app.use("*", requestLogger());
app.use("*", bodyLimitMiddleware());
app.use("*", rateLimitMiddleware());
app.use("*", hookMiddleware() as never);

app.onError((err, c) => {
  if (err instanceof ApiError) return err.response();
  console.error("voidbase: unhandled error", err);
  return c.json({ data: {}, message: "Something went wrong while processing your request.", status: 500 }, 500);
});

app.notFound((c) => c.json(notFound().toJSON(), 404));

// --- health ---------------------------------------------------------------
app.get("/api/health", async (c) => {
  const auth = c.get("auth");
  let data: Record<string, unknown> = {};
  if (isSuperuser(auth)) {
    const settings = await loadSettings(c.env.DB);
    // apis/health.go: remind superusers behind an unconfigured reverse proxy. On Workers CF-Connecting-IP is set
    // by the platform itself and already used as the real IP, so it is not a "possible" proxy header here.
    const headers = [...settings.trustedProxy.headers, "Fly-Client-IP", "X-Forwarded-For"];
    data = {
      canBackup: !(await backupActive(c.env.DB)),
      possibleProxyHeader: headers.find((h) => !!c.req.header(h)) ?? "",
      realIP: realIPWith(settings, c),
    };
  }
  return c.json({ message: "API is healthy.", code: 200, data });
});

// --- settings -------------------------------------------------------------
app.get("/api/settings", async (c) => {
  requireSuperuser(c);
  return requestHookResult("onSettingsListRequest", c, null, { settings: structuredClone(await loadSettings(c.env.DB)) }, async (ev) => publicSettings(ev.settings as Settings));
});

// --- collections ----------------------------------------------------------
app.get("/api/collections/meta/oauth2-providers", (c) => {
  requireSuperuser(c);
  return c.json(oauth2Providers);
});

// Scaffolds are returned as PocketBase returns them: default definitions without token secrets,
// and with a fresh random suffix on the default index names (PocketBase regenerates them per request).
app.get("/api/collections/meta/scaffolds", (c) => {
  requireSuperuser(c);
  const out = structuredClone(scaffolds) as Record<string, { indexes?: string[] }>;
  const suffix = randomIdSuffix();
  for (const scaffold of Object.values(out)) {
    scaffold.indexes = (scaffold.indexes ?? []).map((idx) => idx.replace(/_[a-z0-9]{10}`/, `_${suffix}\``));
  }
  return c.json(out);
});

app.get("/api/collections", async (c) => {
  requireSuperuser(c);
  const { page, perPage, skipTotal } = paging(c);
  let items = await listCollections(c.env.DB);
  const sort = c.req.query("sort") ?? "";
  if (sort) items = sortBy(items, sort, ["name", "type", "system", "created", "updated", "id"]);
  return requestHookResult("onCollectionsListRequest", c, null, { collections: items.map((i) => new CollectionRef(i)) }, async (ev) => {
    const list = (ev.collections as CollectionRef[]).map((r) => r.data);
    const total = list.length;
    return { items: list.slice((page - 1) * perPage, page * perPage).map(collectionToJSON), page, perPage, totalItems: skipTotal ? -1 : total, totalPages: skipTotal ? -1 : Math.ceil(total / perPage) };
  });
});

app.get("/api/collections/:collection", async (c) => {
  requireSuperuser(c);
  const collection = await mustFindCollection(c, c.req.param("collection"), true);
  return requestHookResult("onCollectionViewRequest", c, collection.name, { collection: new CollectionRef(collection) }, async (ev) => collectionToJSON((ev.collection as CollectionRef).data));
});

app.post("/api/collections", async (c) => {
  requireSuperuser(c);
  const body = await readJSON(c);
  return requestHookResult("onCollectionCreateRequest", c, String(body.name ?? ""), { collection: new CollectionRef(body) }, async (ev) => collectionToJSON(await createCollection(c.env.DB, (ev.collection as CollectionRef).toRaw())));
});

app.patch("/api/collections/:collection", async (c) => {
  requireSuperuser(c);
  const collection = await mustFindCollection(c, c.req.param("collection"), true);
  const body = await readJSON(c);
  return requestHookResult("onCollectionUpdateRequest", c, collection.name, { collection: new CollectionRef({ ...collectionToJSON(collection), ...body }) }, async (ev) => collectionToJSON(await updateCollection(c.env.DB, collection, (ev.collection as CollectionRef).toRaw())));
});

app.delete("/api/collections/:collection", async (c) => {
  requireSuperuser(c);
  const collection = await mustFindCollection(c, c.req.param("collection"), true);
  return requestHook("onCollectionDeleteRequest", c, collection.name, { collection: new CollectionRef(collection) }, async () => {
    await deleteCollection(c.env.DB, collection);
    try { await deletePrefix(c.env.STORAGE, `${collection.id}/`); } catch (err) { console.error("voidbase: file cleanup failed", err); }
    return c.body(null, 204);
  });
});

app.delete("/api/collections/:collection/truncate", async (c) => {
  requireSuperuser(c);
  const collection = await mustFindCollection(c, c.req.param("collection"), true);
  await truncateCollection(c.env.DB, collection);
  try { await deletePrefix(c.env.STORAGE, `${collection.id}/`); } catch (err) { console.error("voidbase: file cleanup failed", err); }
  return c.body(null, 204);
});

app.put("/api/collections/import", async (c) => {
  requireSuperuser(c);
  const body = await readJSON(c);
  const items = body.collections;
  if (!Array.isArray(items) || items.length === 0) {
    throw badRequest("An error occurred while validating the submitted data.", { collections: { code: "validation_required", message: "Cannot be blank." } });
  }
  return requestHook("onCollectionsImportRequest", c, null, { collections: items, deleteMissing: !!body.deleteMissing }, async (ev) => {
    await importCollections(c.env.DB, ev.collections as Record<string, unknown>[], !!ev.deleteMissing);
    return c.body(null, 204);
  });
});

// --- records: auth --------------------------------------------------------
app.post("/api/collections/:collection/auth-with-password", async (c) => {
  const collection = await mustFindCollection(c, c.req.param("collection"));
  return authWithPassword(c, collection);
});

app.post("/api/collections/:collection/auth-with-oauth2", async (c) => {
  const collection = await mustFindCollection(c, c.req.param("collection"));
  if (collection.type !== "auth") throw notFound("Missing or invalid auth collection context.");
  return authWithOAuth2(c, collection, await recordContext(c));
});

app.post("/api/collections/:collection/auth-refresh", async (c) => {
  const collection = await mustFindCollection(c, c.req.param("collection"));
  return authRefresh(c, collection);
});

app.get("/api/collections/:collection/auth-methods", async (c) => {
  const collection = await mustFindCollection(c, c.req.param("collection"));
  return authMethods(c, collection);
});

// --- records --------------------------------------------------------------
export async function recordContextFor(c: Context<AppEnv>): Promise<RecordContext> { return recordContext(c); }

async function recordContext(c: Context<AppEnv>): Promise<RecordContext> {
  const auth = c.get("auth");
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => { headers[k.toLowerCase().replace(/-/g, "_")] = v; });
  const query: Record<string, string> = {};
  new URL(c.req.url).searchParams.forEach((v, k) => { query[k] = v; });
  return {
    db: c.env.DB,
    storage: c.env.STORAGE,
    auth,
    superuser: isSuperuser(auth),
    request: { auth: auth ? { collection: auth.collection, row: auth.row } : null, method: c.req.method, query, headers, body: {}, context: c.req.header(BATCH_CONTEXT_HEADER) === batchContextToken() ? "batch" : "default" },
    collections: await loadCollections(c.env.DB),
    hookEvent: (record, collection) => Object.assign(new RequestEvent(c, authToHookRecord(auth)), { record, collection: new CollectionRef(collection) }),
  };
}

async function readRecordBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const ct = c.req.header("content-type") ?? "";
  try {
    if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
      const parsed = (await c.req.parseBody({ all: true })) as Record<string, unknown>;
      // PocketBase merges a "@jsonPayload" form field (JSON) with the other fields and files
      if (typeof parsed["@jsonPayload"] === "string") {
        const payload = JSON.parse(parsed["@jsonPayload"] as string) as Record<string, unknown>;
        delete parsed["@jsonPayload"];
        return { ...payload, ...parsed };
      }
      return parsed;
    }
    const text = await c.req.text();
    if (!text.trim()) return {};
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw badRequest("Failed to read the submitted data.");
  }
}

const listQuery = (c: Context<AppEnv>): ListQuery => ({
  page: Number(c.req.query("page") ?? 1) || 1,
  perPage: Number(c.req.query("perPage") ?? 30) || 30,
  skipTotal: c.req.query("skipTotal") === "1" || c.req.query("skipTotal") === "true",
  sort: c.req.query("sort") ?? "",
  filter: c.req.query("filter") ?? "",
  expand: c.req.query("expand") ?? "",
  fields: c.req.query("fields") ?? "",
});

app.get("/api/collections/:collection/records", async (c) => {
  const collection = await mustFindCollection(c, c.req.param("collection"));
  const ctx = await recordContext(c);
  return requestHookResult("onRecordsListRequest", c, collection.name, { collection: new CollectionRef(collection), records: null }, async () => listRecords(ctx, collection, listQuery(c)));
});

app.get("/api/collections/:collection/records/:id", async (c) => {
  const collection = await mustFindCollection(c, c.req.param("collection"));
  const ctx = await recordContext(c);
  return requestHookResult("onRecordViewRequest", c, collection.name, { collection: new CollectionRef(collection), record: null }, async () => viewRecord(ctx, collection, c.req.param("id"), { expand: c.req.query("expand"), fields: c.req.query("fields") }));
});

app.post("/api/collections/:collection/records", async (c) => {
  const collection = await mustFindCollection(c, c.req.param("collection"));
  const ctx = await recordContext(c);
  const body = await readRecordBody(c);
  return c.json(await createRecord(ctx, collection, body, { expand: c.req.query("expand"), fields: c.req.query("fields") }));
});

app.patch("/api/collections/:collection/records/:id", async (c) => {
  const collection = await mustFindCollection(c, c.req.param("collection"));
  const ctx = await recordContext(c);
  const body = await readRecordBody(c);
  return c.json(await updateRecord(ctx, collection, c.req.param("id"), body, { expand: c.req.query("expand"), fields: c.req.query("fields") }));
});

app.delete("/api/collections/:collection/records/:id", async (c) => {
  const collection = await mustFindCollection(c, c.req.param("collection"));
  const ctx = await recordContext(c);
  await deleteRecord(ctx, collection, c.req.param("id"));
  return c.body(null, 204);
});

// --- realtime -------------------------------------------------------------
app.get("/api/realtime", (c) => requestHook("onRealtimeConnectRequest", c, null, { client: null, idleTimeout: 300 }, () => realtimeConnect(c)));
app.post("/api/realtime", async (c) => {
  let body: { clientId?: string; subscriptions?: string[] } = {};
  try { const ct = c.req.header("content-type") ?? ""; body = ct.includes("json") ? await c.req.json() : (Object.fromEntries((await c.req.formData()).entries()) as unknown as typeof body); } catch { throw badRequest("Failed to read the submitted data."); }
  return requestHook("onRealtimeSubscribeRequest", c, null, { client: { id: String(body.clientId ?? "") }, subscriptions: Array.isArray(body.subscriptions) ? body.subscriptions : [] }, (ev) => realtimeSetSubscriptions(c, { clientId: String(body.clientId ?? ""), subscriptions: ev.subscriptions as string[] }));
});

// --- files ----------------------------------------------------------------
app.get("/api/files/:collection/:recordId/:filename", async (c) => {
  const collection = await findCollection(c.env.DB, c.req.param("collection"));
  if (!collection) throw notFound();
  const row = await one(c.env.DB, `SELECT * FROM ${ident(collection.name)} WHERE id = ? LIMIT 1`, [c.req.param("recordId")]);
  if (!row) throw notFound();
  const filename = c.req.param("filename");
  const field = (collection.fields as Field[]).find((f) => {
    if (f.type !== "file") return false;
    const v = fromColumn(f, row[f.name]);
    return Array.isArray(v) ? v.includes(filename) : v === filename;
  });
  if (!field) throw notFound();
  if (field.protected && !(await protectedAccess(c, await recordContext(c), collection, row))) throw notFound();
  const key = `${collection.id}/${row.id}/${filename}`;
  let served: Awaited<ReturnType<typeof resolveServedFile>>;
  try {
    served = await resolveServedFile(c.env.STORAGE, key, filename, c.req.query("thumb") ?? "", ((field.thumbs as string[] | null | undefined) ?? []), c.req.header("Range"));
  } catch (err) {
    if (err instanceof RangeNotSatisfiable) {
      const disposition = !parseBool(c.req.query("download")) && INLINE_SERVE_CONTENT_TYPES.includes(err.contentType) ? "inline" : "attachment";
      return new Response("invalid range: failed to overlap\n", { status: 416, headers: { "Content-Range": `bytes */${err.size}`, "Content-Disposition": `${disposition}; filename=${JSON.stringify(err.name)}`, "Content-Type": "text/plain; charset=utf-8" } });
    }
    throw err;
  }
  if (!served) throw notFound();
  return requestHook("onFileDownloadRequest", c, collection.name, { collection: new CollectionRef(collection), record: HookRecord.fromRow(collection, row), fileField: field, servedPath: key, servedName: served.name }, async (ev) => {
  served = { ...served!, name: String(ev.servedName ?? served!.name) };
  // PocketBase (tools/filesystem Serve): inline only for known-safe media types unless ?download=true,
  // a few extensions override the sniffed content type, filename quoted, then http.ServeContent semantics.
  const forceAttachment = parseBool(c.req.query("download"));
  const disposition = !forceAttachment && INLINE_SERVE_CONTENT_TYPES.includes(served.contentType) ? "inline" : "attachment";
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")).toLowerCase() : "";
  const contentType = MANUAL_EXTENSION_CONTENT_TYPES[ext] ?? served.contentType;
  const headers = new Headers();
  headers.set("Content-Disposition", `${disposition}; filename=${JSON.stringify(served.name)}`);
  headers.set("Content-Type", contentType);
  headers.set("Content-Security-Policy", "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  headers.set("Cache-Control", "max-age=2592000, stale-while-revalidate=86400");
  headers.set("Last-Modified", served.uploaded.toUTCString());
  headers.set("Accept-Ranges", "bytes");
  headers.set("Vary", "Origin");
  const ims = c.req.header("If-Modified-Since");
  if (ims && !c.req.header("Range")) {
    const since = Date.parse(ims);
    if (!Number.isNaN(since) && Math.floor(served.uploaded.getTime() / 1000) <= Math.floor(since / 1000)) return new Response(null, { status: 304, headers });
  }
  if (served.range) {
    headers.set("Content-Range", `bytes ${served.range.offset}-${served.range.offset + served.range.length - 1}/${served.size}`);
    headers.set("Content-Length", String(served.range.length));
    return new Response(served.body as BodyInit, { status: 206, headers });
  }
  headers.set("Content-Length", String(served.size));
  return new Response(served.body as BodyInit, { headers });
  });
});

// tools/filesystem/filesystem.go
const INLINE_SERVE_CONTENT_TYPES = [
  "image/png", "image/jpg", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/bmp",
  "video/webm", "video/mp4", "video/3gpp", "video/quicktime", "video/x-ms-wmv",
  "audio/basic", "audio/aiff", "audio/mpeg", "audio/midi", "audio/mp3", "audio/wave", "audio/wav", "audio/x-wav", "audio/x-mpeg", "audio/x-m4a", "audio/aac",
  "application/pdf", "application/x-pdf",
];
const MANUAL_EXTENSION_CONTENT_TYPES: Record<string, string> = {
  ".svg": "image/svg+xml", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
// strconv.ParseBool
const parseBool = (v: string | undefined) => v !== undefined && ["1", "t", "T", "TRUE", "true", "True"].includes(v);

// --- helpers --------------------------------------------------------------
async function readJSON(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const v = await c.req.json();
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw badRequest("Failed to load the submitted data due to invalid formatting.");
  }
}

function paging(c: Context<AppEnv>) {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const perPage = Math.min(500, Math.max(1, Number(c.req.query("perPage") ?? 30) || 30));
  const st = c.req.query("skipTotal");
  return { page, perPage, skipTotal: st === "1" || st === "true" };
}

// Record routes report "Missing collection context."; collection routes use the default 404 (as PocketBase does).
async function mustFindCollection(c: Context<AppEnv>, idOrName: string, collectionRoute = false): Promise<Collection> {
  const collection = await findCollection(c.env.DB, idOrName);
  if (!collection) throw collectionRoute ? notFound() : notFound("Missing collection context.");
  return collection;
}

function sortBy<T extends object>(items: T[], sort: string, allowed: string[]): T[] {
  const keys = sort.split(",").map((s) => s.trim()).filter(Boolean);
  const out = [...items];
  for (const k of keys.reverse()) {
    const desc = k.startsWith("-");
    const name = k.replace(/^[+-]/, "");
    if (!allowed.includes(name)) throw badRequest(`Invalid sort field "${name}".`);
    out.sort((a, b) => {
      const x = (a as Record<string, unknown>)[name] as string | number | boolean;
      const y = (b as Record<string, unknown>)[name] as string | number | boolean;
      const r = x < y ? -1 : x > y ? 1 : 0;
      return desc ? -r : r;
    });
  }
  return out;
}

// --- passkeys (the starter's Go webauthn routes, native here) ---------------
mountWebAuthn(app);
mountOAuth2Redirect(app);
mountSettingsApi(app);
const authDeps = {
  collection: async (c: Context<AppEnv>) => { const coll = await mustFindCollection(c, c.req.param("collection") ?? ""); if (coll.type !== "auth") throw notFound("Missing or invalid auth collection context."); return coll; },
  ctx: (c: Context<AppEnv>) => recordContext(c),
};
mountAuthFlows(app, authDeps);
mountAuthExtra(app, authDeps);
mountFilesApi(app);
mountBatch(app);
mountLogsApi(app);
mountCronsApi(app);
mountBackupsApi(app);
mountSqlApi(app);

// --- pb_hooks runtime ------------------------------------------------------
const valuesToRowFor = (c: Collection, values: Record<string, unknown>): Row => { const row: Row = {}; for (const f of c.fields as Field[]) row[f.name] = toColumn(f, values[f.name]); return row; };
// hook code that changes the schema must see the change in the same run ($app.findCollectionByNameOrId)
async function refreshStoreCollections(store: { collections: Map<string, Collection> }, db: D1Database) {
  invalidateCollections();
  const fresh = await loadCollections(db);
  store.collections.clear();
  for (const [k, v] of fresh) store.collections.set(k, v);
}
installServices({
  saveRecord: async (rec) => saveHookRecord(await hookStore.getStore()!.ctx(), rec),
  deleteRecord: async (rec) => { const ctx = await hookStore.getStore()!.ctx(); await deleteRecord({ ...ctx, superuser: true, hookEvent: undefined }, rec.collection().data, rec.id); },
  findRecordById: async (collection, id) => {
    const ctx = await hookStore.getStore()!.ctx();
    const coll = ctx.collections.get(collection);
    if (!coll) return null;
    const row = await one(ctx.db, `SELECT * FROM ${ident(coll.name)} WHERE id = ? LIMIT 1`, [id]);
    return row ? HookRecord.fromRow(coll, row) : null;
  },
  findRecordsByFilter: async (collection, filter, sort, limit, offset, params) => {
    const ctx = await hookStore.getStore()!.ctx();
    const coll = ctx.collections.get(collection);
    if (!coll) return [];
    let where = "1=1"; let ps: unknown[] = []; let joins = "";
    if (filter.trim()) {
      const bound = filter.replace(/\{:(\w+)\}/g, (_m, k: string) => JSON.stringify(params?.[k] ?? ""));
      const compiled = compileFilter(bound, { base: coll, collections: ctx.collections, request: ctx.request, allowHiddenFields: true });
      where = compiled.where; ps = compiled.params; joins = compiled.joins.map(renderJoin).join(" ");
    }
    const order = sort.trim() ? sort.split(",").map((s) => { const d = s.trim().startsWith("-"); const n = s.trim().replace(/^[+-]/, ""); return `${ident(coll.name)}.${ident(n)} ${d ? "DESC" : "ASC"}`; }).join(", ") : `${ident(coll.name)}.rowid ASC`;
    const rows = await all(ctx.db, `SELECT DISTINCT ${ident(coll.name)}.* FROM ${ident(coll.name)} ${joins} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...ps, limit > 0 ? limit : 1000, offset]);
    return rows.map((r: Row) => HookRecord.fromRow(coll, r));
  },
  countRecords: async (collection, where) => {
    const ctx = await hookStore.getStore()!.ctx();
    const coll = ctx.collections.get(collection);
    if (!coll) throw new Error(`sql: no rows in result set (collection "${collection}")`);
    let sql = "1=1"; let ps: unknown[] = []; let joins = "";
    if (typeof where === "string" && where.trim()) {
      const compiled = compileFilter(where, { base: coll, collections: ctx.collections, request: ctx.request, allowHiddenFields: true });
      sql = compiled.where; ps = compiled.params; joins = compiled.joins.map(renderJoin).join(" ");
    } else if (where && typeof where === "object") {
      // dbx expression: [[col]] quoting and {:name} params
      const params: unknown[] = [];
      sql = where.sql.replace(/\[\[(\w+)\]\]/g, (_m, col: string) => ident(col)).replace(/\{:(\w+)\}/g, (_m, k: string) => { params.push(where.params[k] ?? null); return "?"; });
      ps = params;
    }
    const row = await one<{ n: number }>(ctx.db, `SELECT COUNT(DISTINCT ${ident(coll.name)}.id) AS n FROM ${ident(coll.name)} ${joins} WHERE ${sql}`, ps);
    return Number(row?.n ?? 0);
  },
  findAuthRecordByEmail: async (collection, email) => {
    const ctx = await hookStore.getStore()!.ctx();
    const coll = ctx.collections.get(collection);
    if (!coll || coll.type !== "auth") return null;
    const row = await one(ctx.db, `SELECT * FROM ${ident(coll.name)} WHERE email = ? LIMIT 1`, [email]);
    return row ? HookRecord.fromRow(coll, row) : null;
  },
  findAuthRecordByToken: async (token, type) => {
    const ctx = await hookStore.getStore()!.ctx();
    const auth = await findAuthRecordByToken(ctx.db, token, type);
    return auth ? HookRecord.fromRow(auth.collection, auth.row) : null;
  },
  expandRecords: async (records, expands) => {
    if (!records.length || !expands.length) return;
    const ctx = await hookStore.getStore()!.ctx();
    const coll = records[0]!.collection().data;
    const rows = records.map((r) => valuesToRowFor(coll, r.fieldsData()));
    const map = await expandRecords({ db: ctx.db, collections: ctx.collections, auth: ctx.auth, superuser: true, request: ctx.request }, coll, rows, expands);
    for (const r of records) { const e = map.get(String(r.id)); if (e && Object.keys(e).length) r.expand = { ...(r.expand ?? {}), ...e }; }
  },
  saveCollection: async (ref) => {
    const store = hookStore.getStore()!;
    const ctx = await store.ctx();
    const raw = ref.toRaw();
    const existing = (raw.id ? ctx.collections.get(String(raw.id)) : undefined) ?? (raw.name ? ctx.collections.get(String(raw.name)) : undefined);
    const saved = existing ? await updateCollection(ctx.db, existing, raw) : await createCollection(ctx.db, raw);
    Object.assign(ref.data, saved);
    await refreshStoreCollections(store, ctx.db);
    return ref;
  },
  deleteCollection: async (ref) => {
    const store = hookStore.getStore()!;
    const ctx = await store.ctx();
    const existing = ctx.collections.get(ref.id) ?? ctx.collections.get(ref.name);
    if (!existing) throw new Error(`sql: no rows in result set (collection "${ref.id || ref.name}")`);
    await deleteCollection(ctx.db, existing);
    try { await deletePrefix(ctx.storage, `${existing.id}/`); } catch (err) { console.error("voidbase: file cleanup failed", err); }
    await refreshStoreCollections(store, ctx.db);
  },
  sendMail: async (msg) => { console.log("voidbase: mail (not delivered, mailer lands in milestone five):", msg.subject, "->", msg.to.map((t) => t.address).join(",")); },
});
loadHooks();
mountHookRoutes(app);
