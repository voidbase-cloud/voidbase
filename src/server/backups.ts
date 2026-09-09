// Backups (apis/backup*.go): zip archives kept in R2 under __backups__/. A voidbase archive holds data.json
// (every D1 table: columns and rows) and storage/<key> for every uploaded file, so a restore can rebuild the
// collections, tables, rows and files. PocketBase archives (SQLite files) cannot be restored here.
import type { Context, Hono } from "hono";
import { unzipSync, zipSync } from "fflate";
import { fromToken, requireSuperuser } from "./auth-slot";
import { ipInList, realIP } from "./hardening";
import { invalidateCollections, loadCollections } from "./collections/model";
import { planCreate } from "./collections/service";
import { createViewSQL } from "./collections/ddl";
import { all, ident, one, run, stmt } from "./db";
import { ApiError, badRequest, forbidden } from "./errors";
import { trigger } from "./hooks/runtime";
import { withHookStore } from "./hooks/migrations";
import { nowString } from "./ids";
import { dispatch, registerJobHandler } from "./jobs";
import { loadSettings } from "./settings";
import { s3Bucket, withS3Storage } from "./storage/s3";
import { normalizeFilename } from "./records/files";
import type { AppEnv } from "./types";

const PREFIX = "__backups__/";
const LOCK_KEY = "__activeBackup__";
const NAME_RE = /^[a-z0-9_-]+\.zip$/;
const INTERNAL_TABLES = /^(_cf_|__drizzle|_void|d1_migrations|sqlite_)/;
const SKIP_TABLES = new Set(["_changes", "_realtime_clients"]);

interface Dump { format: "voidbase-backup"; version: 1; created: string; tables: Record<string, { columns: string[]; rows: unknown[][] }>; files: string[] }

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
export async function generateBackupName(db: D1Database, prefix = "pb_backup_"): Promise<string> {
  const appName = snake((await loadSettings(db)).meta.appName).slice(0, 50);
  const d = new Date(); const p = (n: number) => String(n).padStart(2, "0");
  return `${prefix}${appName}_${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}.zip`;
}

async function activeBackup(db: D1Database): Promise<string | null> {
  const row = await one<{ value: string }>(db, "SELECT value FROM `_params` WHERE id = ?", [LOCK_KEY]);
  if (!row) return null;
  const { name, at } = JSON.parse(row.value) as { name: string; at: number };
  if (Date.now() - at > 10 * 60_000) { await run(db, "DELETE FROM `_params` WHERE id = ?", [LOCK_KEY]); return null; }
  return name;
}
const lock = (db: D1Database, name: string) => run(db, "INSERT OR REPLACE INTO `_params` (id, value, created, updated) VALUES (?, ?, ?, ?)", [LOCK_KEY, JSON.stringify({ name, at: Date.now() }), nowString(), nowString()]);
const unlock = (db: D1Database) => run(db, "DELETE FROM `_params` WHERE id = ?", [LOCK_KEY]);
// apis/health.go canBackup: no backup or restore currently holds the lock
export async function backupActive(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM `_params` WHERE id = ?").bind(LOCK_KEY).first<{ value: string }>();
  if (!row) return false;
  try { const at = Number((JSON.parse(row.value) as { at?: number }).at ?? 0); return Date.now() - at < 30 * 60_000; } catch { return true; }
}

// where the archives live: settings.backups.s3 when enabled, otherwise next to the files
// PocketBase keeps archives at the root of a dedicated S3 backups bucket, so the __backups__/ prefix used inside
// the shared R2 bucket is stripped on the way to S3 and re-added on the way back.
async function backupsStorage(env: AppEnv["Bindings"]): Promise<R2Bucket> {
  const cfg = (await loadSettings(env.DB)).backups.s3;
  if (!cfg.enabled) return env.STORAGE;
  const s3 = s3Bucket(cfg);
  const strip = (k: string) => (k.startsWith(PREFIX) ? k.slice(PREFIX.length) : k);
  const view = {
    put: (k: string, v: unknown, o?: unknown) => s3.put(strip(k), v as never, o as never),
    get: async (k: string, o?: unknown) => { const r = await s3.get(strip(k), o as never); return r ? Object.assign(r, { key: PREFIX + r.key }) : null; },
    head: async (k: string) => { const r = await s3.head(strip(k)); return r ? Object.assign(r, { key: PREFIX + r.key }) : null; },
    delete: (k: string | string[]) => s3.delete(Array.isArray(k) ? k.map(strip) : strip(k)),
    list: async (o: { prefix?: string; cursor?: string; limit?: number } = {}) => { const r = await s3.list({ ...o, prefix: strip(o.prefix ?? "") }); return { ...r, objects: r.objects.map((x) => Object.assign(x, { key: PREFIX + x.key })) }; },
  };
  return view as unknown as R2Bucket;
}

async function listAll(storage: R2Bucket, prefix: string): Promise<R2Object[]> {
  const out: R2Object[] = []; let cursor: string | undefined;
  do { const l = await storage.list({ prefix, cursor }); out.push(...l.objects); cursor = l.truncated ? l.cursor : undefined; } while (cursor);
  return out;
}

export async function createBackup(env: AppEnv["Bindings"], name: string): Promise<string> {
  const db = env.DB;
  if (await activeBackup(db)) throw new Error("try again later - another backup/restore operation has already been started");
  const ev = { app: undefined as unknown, name, exclude: [] as string[], next: async () => undefined as unknown };
  await trigger("onBackupCreate", ev, null, async () => {
    if (!ev.name) ev.name = await generateBackupName(db);
    await lock(db, ev.name);
    try {
      const tables = (await all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((t) => t.name).filter((t) => !INTERNAL_TABLES.test(t) && !SKIP_TABLES.has(t));
      const dump: Dump = { format: "voidbase-backup", version: 1, created: nowString(), tables: {}, files: [] };
      for (const t of tables) {
        const rows = await all<Record<string, unknown>>(db, `SELECT * FROM ${ident(t)}`);
        const columns = rows.length ? Object.keys(rows[0]!) : (await all<{ name: string }>(db, `PRAGMA table_info(${ident(t)})`)).map((c) => c.name);
        dump.tables[t] = { columns, rows: rows.map((r) => columns.map((c) => r[c] ?? null)) };
      }
      const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
      for (const obj of await listAll(env.STORAGE, "")) {
        if (obj.key.startsWith(PREFIX)) continue;
        const body = await env.STORAGE.get(obj.key);
        if (!body) continue;
        dump.files.push(obj.key);
        entries[`storage/${obj.key}`] = [new Uint8Array(await body.arrayBuffer()), { level: 0 }];
      }
      entries["data.json"] = [new TextEncoder().encode(JSON.stringify(dump)), { level: 6 }];
      const zip = zipSync(entries);
      await (await backupsStorage(env)).put(PREFIX + ev.name, zip, { httpMetadata: { contentType: "application/zip" } });
    } finally { await unlock(db); }
  });
  return ev.name;
}

export async function restoreBackup(env: AppEnv["Bindings"], key: string): Promise<void> {
  const db = env.DB;
  const obj = await (await backupsStorage(env)).get(PREFIX + key);
  if (!obj) throw new Error("missing or invalid backup file");
  const files = unzipSync(new Uint8Array(await obj.arrayBuffer()));
  const raw = files["data.json"];
  if (!raw) throw new Error("not a voidbase backup archive (PocketBase SQLite archives cannot be restored on this server)");
  const dump = JSON.parse(new TextDecoder().decode(raw)) as Dump;
  if (dump.format !== "voidbase-backup") throw new Error("unsupported backup format");
  await lock(db, key);
  try {
    const ev = { app: undefined as unknown, name: key, exclude: [] as string[], next: async () => undefined as unknown };
    await trigger("onBackupRestore", ev, null, async () => {
      // 1. drop every user collection table/view, 2. restore _collections and rebuild the tables, 3. rows, 4. files
      const current = await loadCollections(db);
      const drops: D1PreparedStatement[] = [];
      for (const c of new Set(current.values())) if (!c.system) drops.push(stmt(db, c.type === "view" ? `DROP VIEW IF EXISTS ${ident(c.name)}` : `DROP TABLE IF EXISTS ${ident(c.name)}`, []));
      if (drops.length) await db.batch(drops);
      const insertRows = async (table: string, columns: string[], rows: unknown[][]) => {
        for (let i = 0; i < rows.length; i += 40) {
          const chunk = rows.slice(i, i + 40);
          await db.batch(chunk.map((r) => stmt(db, `INSERT OR REPLACE INTO ${ident(table)} (${columns.map(ident).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, r.map((v) => (v === undefined ? null : v)))));
        }
      };
      const coll = dump.tables["_collections"];
      if (coll) { await run(db, "DELETE FROM `_collections`"); await insertRows("_collections", coll.columns, coll.rows); }
      invalidateCollections();
      const restored = await loadCollections(db);
      const creates: D1PreparedStatement[] = [];
      for (const c of new Set(restored.values())) {
        if (c.system) continue;
        if (c.type === "view") creates.push(db.prepare(createViewSQL(c.name, String(c.options.viewQuery ?? ""))));
        else for (const sql of planCreate(c)) creates.push(db.prepare(sql));
      }
      if (creates.length) await db.batch(creates);
      for (const [table, data] of Object.entries(dump.tables)) {
        if (table === "_collections") continue;
        const exists = await one(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
        if (!exists) continue;
        await run(db, `DELETE FROM ${ident(table)}`);
        await insertRows(table, data.columns, data.rows);
      }
      for (const o of await listAll(env.STORAGE, "")) if (!o.key.startsWith(PREFIX)) await env.STORAGE.delete(o.key);
      for (const f of dump.files) { const bytes = files[`storage/${f}`]; if (bytes) await env.STORAGE.put(f, bytes); }
      invalidateCollections();
    });
  } finally { await unlock(db); }
}

// autobackup (core/backup.go registerAutobackupHooks): settings.backups.cron, keeping the newest cronMaxKeep
export async function autoBackup(env: AppEnv["Bindings"]): Promise<void> {
  const name = await generateBackupName(env.DB, "@auto_pb_backup_");
  await dispatch({ type: "backup", name }, { env });
}
// runs from the jobs queue on Cloudflare (inline elsewhere): create, then keep the newest cronMaxKeep
registerJobHandler("backup", async (env, job) => {
  env = await withS3Storage(env);
  const settings = await loadSettings(env.DB);
  try { await withHookStore(env.DB, env, () => createBackup(env, job.name)); } catch (err) { console.error("voidbase: [Backup cron] Failed to create backup", job.name, err); return; }
  const maxKeep = settings.backups.cronMaxKeep;
  if (!maxKeep) return;
  const bk = await backupsStorage(env);
  const autos = (await listAll(bk, PREFIX + "@auto_pb_backup_")).sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());
  for (const o of autos.slice(maxKeep)) await bk.delete(o.key);
});

export function mountBackupsApi(app: Hono<AppEnv>) {
  app.get("/api/backups", async (c) => {
    requireSuperuser(c);
    const objs = await listAll(await backupsStorage(c.env), PREFIX);
    return c.json(objs.sort((a, b) => (a.key < b.key ? -1 : 1)).map((o) => ({ key: o.key.slice(PREFIX.length), modified: nowString(o.uploaded), size: o.size })));
  });
  app.post("/api/backups", async (c) => {
    requireSuperuser(c);
    if (await activeBackup(c.env.DB)) throw badRequest("Try again later - another backup/restore process has already been started");
    let body: Record<string, unknown> = {};
    try { body = (await c.req.json()) ?? {}; } catch { body = {}; }
    const name = String(body.name ?? "");
    if (name) {
      if (name.length > 150) throw new ApiError(400, "An error occurred while validating the submitted data.", { name: { code: "validation_length_out_of_range", message: "The length must be between 1 and 150.", params: { max: 150, min: 1 } } } as never);
      if (!NAME_RE.test(name)) throw new ApiError(400, "An error occurred while validating the submitted data.", { name: { code: "validation_match_invalid", message: "Must be in a valid format." } } as never);
      if (await (await backupsStorage(c.env)).head(PREFIX + name)) throw new ApiError(400, "An error occurred while validating the submitted data.", { name: { code: "validation_backup_name_exists", message: "The backup file name is invalid or already exists." } } as never);
    }
    try { await createBackup(c.env, name); } catch (err) { throw badRequest("Failed to create backup."); void err; }
    return c.body(null, 204);
  });
  app.post("/api/backups/upload", async (c) => {
    requireSuperuser(c);
    let file: File | null = null;
    try { const fd = await c.req.formData(); const f = fd.get("file"); if (f instanceof File) file = f; } catch { /* no multipart */ }
    if (!file) throw new ApiError(400, "An error occurred while validating the submitted data.", { file: { code: "validation_required", message: "Cannot be blank." } } as never);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
    if (!isZip) throw new ApiError(400, "An error occurred while validating the submitted data.", { file: { code: "validation_invalid_mime_type", message: `"${normalizeFilename(file.name, file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "")}" mime type must be one of: application/zip.` } } as never);
    const bk = await backupsStorage(c.env);
    if (await bk.head(PREFIX + file.name)) throw new ApiError(400, "An error occurred while validating the submitted data.", { file: { code: "validation_backup_name_exists", message: "Backup file with the specified name already exists." } } as never);
    await bk.put(PREFIX + file.name, bytes, { httpMetadata: { contentType: "application/zip" } });
    return c.body(null, 204);
  });
  app.get("/api/backups/:key", async (c) => {
    const auth = await fromToken(c.req.query("token") ?? "", c.env, "file");
    if (!auth || auth.collection.name !== "_superusers") throw forbidden("Insufficient permissions to access the resource.");
    const allowed = (await loadSettings(c.env.DB)).superuserIPs;
    if (allowed.length && !ipInList(allowed, await realIP(c))) throw forbidden("Insufficient permissions to access the resource.");
    const key = c.req.param("key") ?? "";
    const obj = await (await backupsStorage(c.env)).get(PREFIX + key);
    if (!obj) throw new ApiError(404, "The requested resource wasn't found.", {});
    return new Response(obj.body, { headers: { "Content-Type": "application/zip", "Content-Length": String(obj.size), "Content-Disposition": `attachment; filename=${JSON.stringify(key.split("/").pop() ?? key)}`, "Content-Security-Policy": "default-src 'none'; media-src 'self'; style-src 'unsafe-inline'; sandbox" } });
  });
  app.delete("/api/backups/:key", async (c) => {
    requireSuperuser(c);
    const key = c.req.param("key") ?? "";
    if (key && (await activeBackup(c.env.DB)) === key) throw badRequest("The backup is currently being used and cannot be deleted.");
    const bk = await backupsStorage(c.env);
    if (!(await bk.head(PREFIX + key))) throw badRequest("Invalid or already deleted backup file. Raw error: \nbackup does not exist");
    await bk.delete(PREFIX + key);
    return c.body(null, 204);
  });
  app.post("/api/backups/:key/restore", async (c) => {
    requireSuperuser(c);
    if (await activeBackup(c.env.DB)) throw badRequest("Try again later - another backup/restore process has already been started.");
    const key = c.req.param("key") ?? "";
    if (!(await (await backupsStorage(c.env)).head(PREFIX + key))) throw badRequest("Missing or invalid backup file.");
    c.executionCtx.waitUntil(restoreBackup(c.env, key).catch((err) => console.error("voidbase: Failed to restore backup", key, err)));
    return c.body(null, 204);
  });
}
