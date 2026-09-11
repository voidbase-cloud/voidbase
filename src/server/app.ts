import { Hono, type Context } from "hono";
import { authenticate, fromToken, isSuperuser, provideAuthLookup, requireSuperuser } from "./auth-slot";
import { ensureBootstrapped } from "./bootstrap";
import { collectionToJSON, findCollection, invalidateCollections, listCollections, loadCollections, type Collection } from "./collections/model";
import type { Field } from "./collections/fields";
import { createRecord, deleteRecord, listRecords, updateRecord, viewRecord, type ListQuery, type RecordContext } from "./records/service";
import { fromColumn, toColumn } from "./records/values";
import { expandRecords } from "./records/expand";
import { globalHookMiddleware, hookGlobals, hookMiddleware, loadHooks, mountHookRoutes } from "./hooks";
import { requestHook, requestHookResult, trigger } from "./hooks/runtime";
import { PRESENCE_TOPIC, presenceEnabled, presenceMax, presenceTtlMs } from "./realtime/presence";
import { logger } from "#platform/log";
import { env as voidEnv } from "#platform/env";
import type { Settings } from "./settings";
import { applyPendingMigrations, withHookStore } from "./hooks/migrations";
import { RangeNotSatisfiable, resolveServedFile } from "./records/thumbs";
import { deletePrefix } from "./records/files";
import { mountSettingsApi } from "./settings-api";
import { mountFilesApi, protectedAccess } from "./files-api";
import { BATCH_CONTEXT_HEADER, batchContextToken, mountBatch } from "./batch";
import { mountLogsApi, requestLogger } from "./logs";
import { mountCronsApi } from "./crons";
import { createKernel, load, runBootstraps, using, whatLoaded } from "./kernel";
import { auth as authPlugin } from "./plugins/auth";
import { backups as backupsPlugin } from "./plugins/backups";
import { installer as installerPlugin, installerInfo } from "./plugins/installer";
import { openapi as openapiPlugin } from "./plugins/openapi";
import { mcp as mcpPlugin } from "./plugins/mcp";
import { seo as seoPlugin } from "./plugins/seo";
import { realtime as realtimePlugin } from "./plugins/realtime";
import { hardening as hardeningPlugin } from "./plugins/hardening";
import { SHIPPED } from "./plugins/shipped";
import { disabled as disabledPlugins, installed as installedPlugins } from "#platform/plugins";
import type { Auth, Hardening, Realtime } from "./interfaces";
import { VERSION } from "./version";
import { mountSqlApi } from "./sql";
import { realIPWith } from "./hardening";
import { backupActive } from "./backups";
import { maintenanceIfDue } from "./crons";
import { attachJobs } from "./jobs";
import { sendMail } from "./mail";
import { s3Bucket } from "./storage/s3";
import { installServices, RequestEvent, authToHookRecord, hookStore } from "./hooks/runtime";
import { CollectionRef, HookRecord } from "./hooks/record";
import { saveHookRecord } from "./records/service";
import { compileFilter, FilterError, renderJoin } from "./filter/compile";
import { FilterSyntaxError } from "./filter/lexer";
import { recordToJSON } from "./records/json";
import { connect as realtimeConnect, setSubscriptions as realtimeSetSubscriptions } from "./realtime";
import oauth2Providers from "./collections/oauth2-providers.json";
import scaffolds from "./collections/scaffolds.json";
import { all, ident, one } from "./db";
import { ApiError, badRequest, forbidden, notFound } from "./errors";
import { randomIdSuffix, randomString } from "./ids";
import { createCollection, deleteCollection, importCollections, inferViewFields, truncateCollection, updateCollection } from "./collections/service";
import { loadSettings, publicSettings } from "./settings";
import type { AppEnv, Row, Bindings } from "./types";
import { resolveSecretBindings } from "./secrets-store";
import { withFlags } from "./flags";

export const app = new Hono<AppEnv>();
let served = false; // onBootstrap / onServe fire once per isolate, on the first request

// The response policy (CORS, the security headers on every response, the files' Content-Security-Policy, the
// CSRF check) from whichever plugin provides hardening@1, first in the chain so it lands on every answer: errors,
// not-founds, preflights and files included. Middleware runs in registration order and the kernel loads after the
// routes, so the slot asks the provider at request time (the kernel is a const declared at the end of this module,
// fine here because this runs per request). No provider, no policy, and no CORS. The limits below share the slot.
const hardened = () => using<Hardening | undefined>(kernel, "hardening@1");
app.use("*", (c, next) => hardened()?.responsePolicy(c, next) ?? next());

app.use("*", async (c, next) => {
  // secrets from the account's Secrets Store become strings on env before anything reads them (secrets-store.ts)
  await resolveSecretBindings(c.env as unknown as Record<string, unknown>);
  await ensureBootstrapped(c.env.DB, (db) => applyPendingMigrations(db, hookGlobals(), c.env));
  // then what the plugins asked to do once with the bindings: creating the collections they own (kernel onBootstrap)
  await runBootstraps(kernel, c.env);
  // settings.s3 swaps the file storage for an S3 bucket; everything downstream keeps using c.env.STORAGE
  const s3 = (await loadSettings(c.env.DB)).s3;
  if (s3.enabled) c.env = { ...c.env, STORAGE: s3Bucket(s3) };
  attachJobs(c.env);
  // the realtime client for this request's bindings, from the plugin that provides realtime@1; the kernel below is
  // a const declared at the end of this module, which is fine here because this runs per request, long after it
  c.set("realtime", using<Realtime>(kernel, "realtime@1").for(c.env));
  // onBootstrap/onServe handlers may use $app (find/save records and collections) like PocketBase's, so they run inside a hook store
  if (!served) { served = true; await withHookStore(c.env.DB, c.env, async () => { await trigger("onBootstrap", { app: undefined as unknown, next: async () => undefined as unknown }, null, async () => undefined); await trigger("onServe", { app: undefined as unknown, router: app, next: async () => undefined as unknown }, null, async () => undefined); }); }
  // who is asking, from whoever provides auth@1 (the auth plugin, unless the project replaced it): nobody without one
  c.set("auth", await authenticate(c.req.raw, c.env));
  // the declared feature flags, evaluated for whoever this is (flags.ts): from here on env carries their values
  c.env = await withFlags(c.env, String(c.get("auth")?.row.id ?? c.req.header("cf-connecting-ip") ?? ""));
    // Not on the realtime stream: its invocation lives as long as the connection, and waitUntil work is cancelled
    // when that closes, so maintenance attached to it is dropped after having claimed the hour's slot. Let a short
    // request carry it instead.
    if (!c.req.path.startsWith("/api/realtime")) {
      try { maintenanceIfDue(c.env, (p) => c.executionCtx.waitUntil(p)); } catch { /* no execution context */ }
    }
  await next();
});
app.use("*", requestLogger());
// The limits, from the same provider: this is their place in the chain. No provider, no limits.
app.use("*", (c, next) => hardened()?.bodyLimit(c, next) ?? next());
app.use("*", (c, next) => hardened()?.rateLimit(c, next) ?? next());
app.use("*", hookMiddleware() as never);
// PocketBase's routerUse: the app's own global middleware, around every request (see src/adapter for Void's middleware/)
app.use("*", globalHookMiddleware() as never);

app.onError((err, c) => {
  if (err instanceof ApiError) return err.response();
  const details = { method: c.req.method, path: c.req.path, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), stack: err instanceof Error ? err.stack : undefined };
  logger.error("voidbase: unhandled error", details);
  const webhook = String((voidEnv as Record<string, unknown>).VOIDBASE_ALERT_WEBHOOK_URL ?? "").trim();
  if (webhook) {
    const alert = fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "voidbase", level: "error", message: "unhandled request error", status: 500, time: new Date().toISOString(), ...details }) }).catch((e) => console.error("voidbase: alert webhook failed", e));
    try { c.executionCtx.waitUntil(alert); } catch { /* no execution context (tests) */ }
  }
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

const COLLECTIONS_META: Collection = {
  id: "_collections", name: "_collections", type: "base", system: true, listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, indexes: [], options: {}, created: "", updated: "",
  fields: [
    { id: "text_id", name: "id", type: "text", system: true, required: true, hidden: false, presentable: false },
    { id: "text_name", name: "name", type: "text", system: true, required: false, hidden: false, presentable: false },
    { id: "text_type", name: "type", type: "text", system: true, required: false, hidden: false, presentable: false },
    { id: "bool_system", name: "system", type: "bool", system: true, required: false, hidden: false, presentable: false },
    { id: "date_created", name: "created", type: "date", system: true, required: false, hidden: false, presentable: false },
    { id: "date_updated", name: "updated", type: "date", system: true, required: false, hidden: false, presentable: false },
  ] as unknown as Collection["fields"],
};

// POST /api/collections/meta/dry-run-view (apis/collection.go collectionDryRunView): inferred fields + up to 10 sample rows
app.post("/api/collections/meta/dry-run-view", async (c) => {
  requireSuperuser(c);
  const body = await readJSON(c, "An error occurred while loading the submitted data.");
  const query = String(body.query ?? "");
  if (!query) throw new ApiError(400, "An error occurred while validating the submitted data.", { query: { code: "validation_required", message: "Cannot be blank." } } as never);
  if (query.length > 5000) throw new ApiError(400, "An error occurred while validating the submitted data.", { query: { code: "validation_length_too_long", message: "The length must be no more than 5000.", params: { max: 5000, min: 0 } } } as never);
  const collections = await listCollections(c.env.DB);
  let fields: Field[]; let rows: Row[];
  try {
    fields = await inferViewFields(c.env.DB, query, new Map(collections.flatMap((x) => [[x.id, x], [x.name, x]] as [string, Collection][])));
    rows = (await c.env.DB.prepare(`SELECT * FROM (${query.trim().replace(/;\s*$/, "")}) LIMIT 10`).all<Row>()).results;
  } catch (err) { throw badRequest("Invalid view query. Raw error: \n" + (err instanceof Error ? err.message : String(err))); }
  const tmpName = `temp_view_${randomString(5)}`;
  const tmp = { ...COLLECTIONS_META, id: tmpName, name: tmpName, type: "view", fields } as Collection;
  return c.json({ fields, sample: rows.map((r) => recordToJSON(tmp, r)) });
});

app.get("/api/collections", async (c) => {
  requireSuperuser(c);
  const { page, perPage, skipTotal } = paging(c);
  let items = await listCollections(c.env.DB);
  const filter = (c.req.query("filter") ?? "").trim();
  if (filter) {
    // search.NewSimpleFieldResolver("id", "created", "updated", "name", "system", "type") over the _collections table
    let compiled: { where: string; params: unknown[] };
    try { compiled = compileFilter(filter, { base: COLLECTIONS_META, baseTable: "_collections", collections: new Map(), request: { auth: null, method: "GET", query: {}, headers: {}, body: {}, context: "default" }, allowHiddenFields: true }); }
    catch (err) { if (err instanceof FilterError || err instanceof FilterSyntaxError) throw badRequest(); throw err; }
    const ids = new Set((await c.env.DB.prepare(`SELECT id FROM \`_collections\` WHERE ${compiled.where}`).bind(...compiled.params).all<{ id: string }>()).results.map((r) => r.id));
    items = items.filter((i) => ids.has(i.id));
  }
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
  const body = await readJSON(c, "Failed to load the collection type data due to invalid formatting.");
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
  const body = await readJSON(c, "An error occurred while loading the submitted data.");
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
// The auth routes (auth-with-password, OAuth2, refresh, methods, the flows, passkeys) are the auth plugin's
// (plugins/auth.ts), mounted when the kernel loads it below; nothing here knows how a session is made.

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
    realtime: c.get("realtime"),
    waitUntil: (p) => { try { c.executionCtx.waitUntil(p); } catch { void p; } },
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
    throw badRequest(); // PocketBase's RequestInfo body loading fails with the generic message
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

// --- presence: who is here now, and where their cursor is (src/server/realtime/presence.ts) ------------------
// Off unless the instance asks for it (VOIDBASE_PRESENCE=1): the endpoints are anonymous and public by design. The
// roster lives in the hub, never in the database, and only the members holding a slot may beat, so the write path
// is bounded by VOIDBASE_PRESENCE_MAX however many people are watching.
app.get("/api/presence", async (c) => {
  const realtime = c.get("realtime");
  if (!presenceEnabled(c.env) || !realtime.active()) return c.json({ enabled: false, max: 0, members: [] });
  const r = await realtime.presence("beat", { id: "" }, { max: presenceMax(), ttlMs: presenceTtlMs() });
  return c.json({ enabled: true, max: presenceMax(), ttl: Math.round(presenceTtlMs() / 1000), topic: PRESENCE_TOPIC, members: r?.members ?? [] });
});
app.post("/api/presence", async (c) => {
  const realtime = c.get("realtime");
  if (!presenceEnabled(c.env) || !realtime.active()) return c.json({ enabled: false, max: 0, members: [], holdsSlot: false });
  let body: Record<string, unknown> = {};
  try { body = (await c.req.json()) as Record<string, unknown>; } catch { body = {}; }
  const op = String(body.op ?? "beat");
  if (!["join", "beat", "leave"].includes(op)) throw badRequest("op must be join, beat or leave.");
  const r = await realtime.presence(op, body, { max: presenceMax(), ttlMs: presenceTtlMs() });
  return c.json({ enabled: true, max: presenceMax(), topic: PRESENCE_TOPIC, members: r?.members ?? [], holdsSlot: !!r?.holdsSlot });
});

// --- realtime -------------------------------------------------------------
app.get("/api/realtime", (c) => requestHook("onRealtimeConnectRequest", c, null, { client: null, idleTimeout: 300 }, () => realtimeConnect(c)));
app.post("/api/realtime", async (c) => {
  let body: { clientId?: string; subscriptions?: string[] } = {};
  try { const ct = c.req.header("content-type") ?? ""; body = ct.includes("json") ? await c.req.json() : (Object.fromEntries((await c.req.formData()).entries()) as unknown as typeof body); } catch { throw badRequest(); }
  return requestHook("onRealtimeSubscribeRequest", c, null, { client: { id: String(body.clientId ?? "") }, subscriptions: Array.isArray(body.subscriptions) ? body.subscriptions : [] }, (ev) => realtimeSetSubscriptions(c, { clientId: String(body.clientId ?? ""), subscriptions: ev.subscriptions as string[] }));
});

// --- files ----------------------------------------------------------------
app.get("/api/files/:collection/:recordId/:filename", async (c) => {
  const collection = await findCollection(c.env.DB, c.req.param("collection"));
  if (!collection) throw notFound("Missing or invalid collection context.");
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
  c.set("file", true); // the response policy (hardening@1) adds the files' Content-Security-Policy
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
async function readJSON(c: Context<AppEnv>, message = "Failed to load the submitted data due to invalid formatting."): Promise<Record<string, unknown>> {
  try {
    const v = await c.req.json();
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw badRequest(message);
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

mountSettingsApi(app);
mountFilesApi(app);
mountBatch(app);
mountLogsApi(app);
mountCronsApi(app);
// --- the plugin kernel (experiment: src/server/kernel.ts) ---------------------------------------------------
// Mounted here, at module scope, and not on the first request. Hono's default SmartRouter builds its matcher the
// first time it matches and refuses routes afterwards, so anything a plugin mounts has to be in place before the
// app serves anything. cordis applies a plugin on a later tick, which is why this awaits: top level await in an
// ES module is the only place both facts can be true at once.
export const kernel = createKernel(app);
// What ships, minus what the project turned off, minus what an installed plugin shadows by name; then what the
// project installed (pb_plugins, verified against voidbase.lock by the platform module). One graph, resolved once.
const shipped = [authPlugin, realtimePlugin, hardeningPlugin, backupsPlugin, installerPlugin(VERSION), openapiPlugin, mcpPlugin, seoPlugin];
if (shipped.map((p) => p.manifest.name).join() !== SHIPPED.join()) throw new Error("voidbase: src/server/plugins/shipped.ts disagrees with the plugins app.ts loads");
const shadowed = new Set(installedPlugins.map((p) => p.name));
const active = shipped.filter((p) => !disabledPlugins.includes(p.manifest.name) && !shadowed.has(p.manifest.name));
await load(kernel, [...active, ...installedPlugins.map((p) => p.plugin)], VERSION, {
  origins: Object.fromEntries([...active.map((p) => [p.manifest.name, "shipped"]), ...installedPlugins.map((p) => [p.name, `${p.marketplace} ${p.version}`])]),
  disabled: disabledPlugins,
});
// from here on the core asks whoever provides auth@1 who is signed in and what a superuser is (auth-slot.ts); looked
// up on every question rather than kept, because a provider can be replaced while the instance runs
provideAuthLookup(() => using<Auth | undefined>(kernel, "auth@1"));

// What this instance is running, which is the question a bare instance has to be able to answer about itself. For
// the superuser, like logs and settings: an inventory of what is installed is a map of the attack surface.
app.get("/api/plugins", (c) => {
  requireSuperuser(c);
  return c.json({ ...whatLoaded(kernel), installer: installerInfo(c.env) });
});
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
    const store = hookStore.getStore()!;
    const auth = await fromToken(token, store.env as unknown as Bindings, type);
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
  importCollections: async (items, deleteMissing) => {
    const store = hookStore.getStore()!;
    const ctx = await store.ctx();
    await importCollections(ctx.db, items, deleteMissing);
    await refreshStoreCollections(store, ctx.db);
  },
  truncateCollection: async (ref) => {
    const store = hookStore.getStore()!;
    const ctx = await store.ctx();
    const existing = ctx.collections.get(ref.id) ?? ctx.collections.get(ref.name);
    if (!existing) throw new Error(`sql: no rows in result set (collection "${ref.id || ref.name}")`);
    await truncateCollection(ctx.db, existing);
    try { await deletePrefix(ctx.storage, `${existing.id}/`); } catch (err) { console.error("voidbase: file cleanup failed", err); }
  },
  // $app.newMailClient().send(): synchronous like PocketBase's mailer, errors surface to the hook
  sendMail: async (msg) => { const ctx = await hookStore.getStore()!.ctx(); await sendMail(ctx.db, { from: msg.from, to: msg.to, cc: msg.cc, bcc: msg.bcc, subject: msg.subject, html: msg.html, text: msg.text, headers: msg.headers }, { inline: true }); },
});
loadHooks();
mountHookRoutes(app);
