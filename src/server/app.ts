import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { authMethods, authRefresh, authWithPassword, isSuperuser, loadAuth, requireSuperuser } from "./auth";
import { ensureBootstrapped } from "./bootstrap";
import { collectionToJSON, findCollection, listCollections, loadCollections, type Collection } from "./collections/model";
import type { Field } from "./collections/fields";
import { createRecord, deleteRecord, listRecords, updateRecord, viewRecord, type ListQuery, type RecordContext } from "./records/service";
import { fromColumn } from "./records/values";
import oauth2Providers from "./collections/oauth2-providers.json";
import scaffolds from "./collections/scaffolds.json";
import { ident, one } from "./db";
import { ApiError, badRequest, forbidden, notFound } from "./errors";
import { randomIdSuffix } from "./ids";
import { createCollection, deleteCollection, importCollections, truncateCollection, updateCollection } from "./collections/service";
import { loadSettings, publicSettings } from "./settings";
import type { AppEnv } from "./types";

export const app = new Hono<AppEnv>();

app.use("*", cors({ origin: "*", allowHeaders: ["Authorization", "Content-Type"], allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS", "HEAD"] }));

// PocketBase's default security headers.
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "SAMEORIGIN");
  c.header("X-Xss-Protection", "1; mode=block");
});

app.use("*", async (c, next) => {
  await ensureBootstrapped(c.env.DB);
  c.set("auth", await loadAuth(c));
  await next();
});

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
    const headers = [...settings.trustedProxy.headers, "CF-Connecting-IP", "Fly-Client-IP", "X-Forwarded-For"];
    data = {
      canBackup: false,
      possibleProxyHeader: headers.find((h) => !!c.req.header(h)) ?? "",
      realIP: c.req.header("CF-Connecting-IP") ?? c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ?? "",
    };
  }
  return c.json({ message: "API is healthy.", code: 200, data });
});

// --- settings -------------------------------------------------------------
app.get("/api/settings", async (c) => {
  requireSuperuser(c);
  return c.json(publicSettings(await loadSettings(c.env.DB)));
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
  const total = items.length;
  return c.json({
    items: items.slice((page - 1) * perPage, page * perPage).map(collectionToJSON),
    page,
    perPage,
    totalItems: skipTotal ? -1 : total,
    totalPages: skipTotal ? -1 : Math.ceil(total / perPage),
  });
});

app.get("/api/collections/:collection", async (c) => {
  requireSuperuser(c);
  const collection = await mustFindCollection(c, c.req.param("collection"), true);
  return c.json(collectionToJSON(collection));
});

app.post("/api/collections", async (c) => {
  requireSuperuser(c);
  const body = await readJSON(c);
  return c.json(collectionToJSON(await createCollection(c.env.DB, body)));
});

app.patch("/api/collections/:collection", async (c) => {
  requireSuperuser(c);
  const collection = await mustFindCollection(c, c.req.param("collection"), true);
  const body = await readJSON(c);
  return c.json(collectionToJSON(await updateCollection(c.env.DB, collection, body)));
});

app.delete("/api/collections/:collection", async (c) => {
  requireSuperuser(c);
  const collection = await mustFindCollection(c, c.req.param("collection"), true);
  await deleteCollection(c.env.DB, collection);
  return c.body(null, 204);
});

app.delete("/api/collections/:collection/truncate", async (c) => {
  requireSuperuser(c);
  const collection = await mustFindCollection(c, c.req.param("collection"), true);
  await truncateCollection(c.env.DB, collection);
  return c.body(null, 204);
});

app.put("/api/collections/import", async (c) => {
  requireSuperuser(c);
  const body = await readJSON(c);
  const items = body.collections;
  if (!Array.isArray(items) || items.length === 0) {
    throw badRequest("An error occurred while validating the submitted data.", { collections: { code: "validation_required", message: "Cannot be blank." } });
  }
  await importCollections(c.env.DB, items as Record<string, unknown>[], !!body.deleteMissing);
  return c.body(null, 204);
});

// --- records: auth --------------------------------------------------------
app.post("/api/collections/:collection/auth-with-password", async (c) => {
  const collection = await mustFindCollection(c, c.req.param("collection"));
  return authWithPassword(c, collection);
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
    request: { auth: auth ? { collection: auth.collection, row: auth.row } : null, method: c.req.method, query, headers, body: {}, context: "default" },
    collections: await loadCollections(c.env.DB),
  };
}

async function readRecordBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const ct = c.req.header("content-type") ?? "";
  try {
    if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
      return (await c.req.parseBody({ all: true })) as Record<string, unknown>;
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
  return c.json(await listRecords(ctx, collection, listQuery(c)));
});

app.get("/api/collections/:collection/records/:id", async (c) => {
  const collection = await mustFindCollection(c, c.req.param("collection"));
  const ctx = await recordContext(c);
  return c.json(await viewRecord(ctx, collection, c.req.param("id"), { expand: c.req.query("expand"), fields: c.req.query("fields") }));
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
  if (field.protected && !isSuperuser(c.get("auth"))) {
    // protected files require a file token (milestone five); superusers may always fetch
    throw notFound();
  }
  const obj = await c.env.STORAGE.get(`${collection.id}/${row.id}/${filename}`);
  if (!obj) throw notFound();
  const headers = new Headers();
  headers.set("Content-Type", obj.httpMetadata?.contentType ?? "application/octet-stream");
  headers.set("Content-Length", String(obj.size));
  headers.set("Content-Disposition", `${c.req.query("download") ? "attachment" : "inline"}; filename=${filename}`);
  headers.set("Cache-Control", "max-age=2592000, stale-while-revalidate=86400");
  headers.set("Last-Modified", obj.uploaded.toUTCString());
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Security-Policy", "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  headers.set("Vary", "Origin");
  return new Response(obj.body, { headers });
});

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
