// Backups (apis/backup*.go): zip archives kept in R2 under __backups__/. Three kinds of archive, all restorable here:
//   full  - data.jsonl (every D1 table: one JSON object per line, _collections first), settings.json (the settings
//           as GET /api/settings answers them, secrets left out), collections.json (every collection as the
//           collections API exports it), storage/<collection>/<record>/<file> for every uploaded file, and
//           manifest.json last (kind, version, tables, file count and bytes, a sha256 per entry and one over them).
//   data  - the rows of every non-system collection, their files, their definitions, and manifest.json. No
//           settings, no _superusers, no auth origins, OTPs, MFAs or external auths, no token secrets.
//   schema - collections.json (the non-system collections' definitions, views included) and manifest.json, nothing
//           else: no rows, no files. Restoring one imports the definitions, creating the collections the instance
//           lacks and updating the ones it has; the rows it has stay. What a preview instance is seeded with.
// Every archive opens with header.json (format, kind, voidbase, created, tables), the one entry a restore must
// read before it applies anything. Archives written before header.json hold data.json, one JSON document with
// every table's rows; they still restore, read whole as they always were. Archives written before the manifest
// existed (data.json and storage/ only) read as kind "legacy". PocketBase archives (SQLite files) cannot be
// restored here.
//
// Files are streamed into the zip one chunk at a time (fflate's streaming Zip), never held whole. The archive
// itself streams to R2 as a multipart upload in 10 MiB parts when the backups storage offers one (R2 does); a
// storage that does not (the S3 backups bucket from the settings, the Bun runtime's local store) takes the archive
// as one object, so it is buffered whole, capped at BUFFERED_MAX. After the write the archive is read back as a
// stream, every entry hashed and the manifest compared; the result and the off-site copy's outcome live in a
// sidecar (<name>.meta.json) next to the archive, which is what the listing reads.
//
// A restore of a format 2 archive is one streaming pass too (fflate's Unzip): entries arrive in the order they
// were written, data.jsonl is parsed line by line into batched inserts, and every storage/ entry goes straight
// from the zip into a storage put, so the peak does not scale with the archive.
import type { Hono } from "hono";
import { Unzip, UnzipInflate, Zip, ZipDeflate, ZipPassThrough, unzipSync } from "fflate";
import { env as voidEnv } from "#platform/env";
import { fromToken, requireSuperuser } from "./auth-slot";
import { ipInList, realIP } from "./hardening";
import { collectionToJSON, invalidateCollections, listCollections, loadCollections } from "./collections/model";
import { importCollections, planCreate } from "./collections/service";
import { createViewSQL } from "./collections/ddl";
import { all, ident, one, run, stmt } from "./db";
import { ApiError, badRequest, forbidden } from "./errors";
import { trigger } from "./hooks/runtime";
import { withHookStore } from "./hooks/migrations";
import { nowString } from "./ids";
import { dispatch, registerJobHandler } from "./jobs";
import { loadSettings, mergeSettings, publicSettings, saveSettings } from "./settings";
import { rfc3986, s3Bucket, signV4, withS3Storage } from "./storage/s3";
import { normalizeFilename } from "./records/files";
import type { AppEnv } from "./types";
import { VERSION } from "./version";

const PREFIX = "__backups__/";
const META_SUFFIX = ".meta.json";
const LOCK_KEY = "__activeBackup__";
const NAME_RE = /^[a-z0-9_-]+\.zip$/;
const INTERNAL_TABLES = /^(_cf_|__miniflare|__drizzle|_void|d1_migrations|sqlite_)/;
const SKIP_TABLES = new Set(["_changes", "_realtime_clients"]);
const PART_SIZE = 10 * 1024 * 1024;
/** the largest archive a storage without multipart uploads takes (it is held in memory before the single put) */
export const BUFFERED_MAX = 256 * 1024 * 1024;
const HEADER_JSON = "header.json", DATA_JSON = "data.json", DATA_JSONL = "data.jsonl", MANIFEST_JSON = "manifest.json";
const STORAGE_PREFIX = "storage/";
/** what a format 2 archive says it is: header.json first, the rows as data.jsonl. Format 1 is data.json whole. */
export const FORMAT = "voidbase-backup/2";
/** rows per db.batch, and the bytes that force one early. One statement per row keeps every statement inside D1's
 * ceiling of 100 bound parameters (a row binds one parameter per column). */
const BATCH_ROWS = 200, BATCH_BYTES = 256 * 1024;
/** the archive is pushed into the unzipper in slices this big, shrunk when one slice inflates to more than
 * SLICE_OUT, so what is held at once is one slice's output and not the archive */
const SLICE_MAX = 16 * 1024, SLICE_MIN = 1024, SLICE_OUT = 1024 * 1024;

export type BackupKind = "full" | "data" | "schema";
export const DEFAULT_KIND: BackupKind = "full";
export const KIND_VAR = "VOIDBASE_BACKUP_KIND";
export const KEEP_VAR = "VOIDBASE_BACKUP_KEEP";
export const OFFSITE_VARS = { endpoint: "VOIDBASE_BACKUP_S3_ENDPOINT", bucket: "VOIDBASE_BACKUP_S3_BUCKET", accessKey: "VOIDBASE_BACKUP_S3_ACCESS_KEY_ID", secret: "VOIDBASE_BACKUP_S3_SECRET_ACCESS_KEY", region: "VOIDBASE_BACKUP_S3_REGION" } as const;

interface Dump { format: "voidbase-backup"; version: number; created: string; tables: Record<string, { columns: string[]; rows: unknown[][] }>; files: string[] }
/** the first entry of a format 2 archive: everything a restore must know before it applies anything */
export interface BackupHeader { format: string; kind: BackupKind; voidbase: string; created: string; tables: string[] }
export interface Manifest {
  format: string;
  kind: BackupKind;
  voidbase: string;
  created: string;
  tables: string[];
  files: { count: number; bytes: number };
  /** sha256 over "<name>\n<sha256 of the entry>\n" for every entry but this file, names sorted */
  checksum: string;
  entries: Record<string, string>;
}
export interface VerifyResult { kind: BackupKind | "legacy"; verified: boolean; voidbase: string | null; created: string | null; checksum: string | null; entries: number; corrupted: string[]; missing: string[]; error?: string; tables?: string[]; files?: { count: number; bytes: number } }
export interface RestoreReport { at: string; kind: BackupKind | "legacy"; restored: string[]; created: string[]; skipped: { collection: string; reason: string }[]; settings: boolean }
/** the sidecar next to an archive: what the listing says about it without opening it */
export interface BackupMeta { kind: BackupKind | "legacy"; voidbase: string | null; created: string | null; checksum: string | null; verified: boolean; verifiedAt: string | null; verifyError?: string; corrupted?: string[]; offsite?: boolean; offsiteError?: string; tables?: string[]; files?: { count: number; bytes: number }; restore?: RestoreReport }
export interface BackupResult { name: string; kind: BackupKind; manifest: Manifest; verified: boolean; offsite?: boolean; offsiteError?: string }
export interface RestoreOptions { createMissing?: boolean }

const enc = new TextEncoder();
const dec = new TextDecoder();
const knob = (env: AppEnv["Bindings"], name: string) => String((env as unknown as Record<string, unknown>)[name] ?? (voidEnv as Record<string, unknown>)[name] ?? "").trim();
export const parseKind = (raw: string): BackupKind | null => (raw === "full" || raw === "data" || raw === "schema" ? raw : null);

// ---- sha256, incrementally: WebCrypto digests only whole buffers, and entries are streamed ------------------
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export class Sha256 {
  private h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private w = new Uint32Array(64);
  private buf = new Uint8Array(64);
  private n = 0;
  private len = 0;
  update(data: Uint8Array): this {
    this.len += data.length;
    let i = 0;
    if (this.n) {
      const take = Math.min(64 - this.n, data.length);
      this.buf.set(data.subarray(0, take), this.n); this.n += take; i = take;
      if (this.n < 64) return this;
      this.block(this.buf, 0); this.n = 0;
    }
    for (; i + 64 <= data.length; i += 64) this.block(data, i);
    if (i < data.length) { this.buf.set(data.subarray(i)); this.n = data.length - i; }
    return this;
  }
  private block(p: Uint8Array, o: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = (p[o + i * 4]! << 24) | (p[o + i * 4 + 1]! << 16) | (p[o + i * 4 + 2]! << 8) | p[o + i * 4 + 3]!;
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!, b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = this.h as unknown as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    const H = this.h;
    H[0] = (H[0]! + a) | 0; H[1] = (H[1]! + b) | 0; H[2] = (H[2]! + c) | 0; H[3] = (H[3]! + d) | 0;
    H[4] = (H[4]! + e) | 0; H[5] = (H[5]! + f) | 0; H[6] = (H[6]! + g) | 0; H[7] = (H[7]! + h) | 0;
  }
  /** the digest as lowercase hex; finishes the hash, so call it once */
  hex(): string {
    const bits = this.len * 8;
    const pad = new Uint8Array((this.n < 56 ? 56 - this.n : 120 - this.n) + 8);
    pad[0] = 0x80;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(pad.length - 4, bits >>> 0);
    this.len -= pad.length; this.update(pad);
    return Array.from(this.h).map((x) => x.toString(16).padStart(8, "0")).join("");
  }
}
export const sha256Hex = (data: Uint8Array | string) => new Sha256().update(typeof data === "string" ? enc.encode(data) : data).hex();
const checksumOf = (entries: Record<string, string>) => sha256Hex(Object.keys(entries).sort().map((n) => `${n}\n${entries[n]}\n`).join(""));

async function* chunksOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try { for (;;) { const { done, value } = await reader.read(); if (done) return; if (value?.length) yield value; } } finally { reader.releaseLock(); }
}
const concat = (parts: Uint8Array[], total: number) => { const out = new Uint8Array(total); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

// ---- names and the lock ---------------------------------------------------------------------------------------
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

// ---- where the archives live: settings.backups.s3 when enabled, otherwise next to the files ----------------------
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
const isMeta = (key: string) => key.endsWith(META_SUFFIX);
const metaKey = (name: string) => PREFIX + name + META_SUFFIX;
async function readMeta(bk: R2Bucket, name: string): Promise<BackupMeta | null> {
  try { const o = await bk.get(metaKey(name)); return o ? ((await o.json()) as BackupMeta) : null; } catch { return null; }
}
const writeMeta = (bk: R2Bucket, name: string, meta: BackupMeta) => bk.put(metaKey(name), JSON.stringify(meta), { httpMetadata: { contentType: "application/json" } });

// ---- the sink the zip streams into ----------------------------------------------------------------------------
interface Sink { write(chunk: Uint8Array): Promise<void>; finish(): Promise<void>; abort(): Promise<void>; bytes(): Uint8Array | null }
async function openSink(bucket: R2Bucket, key: string): Promise<Sink> {
  const httpMetadata = { contentType: "application/zip" };
  const multipart = (bucket as { createMultipartUpload?: unknown }).createMultipartUpload;
  if (typeof multipart === "function") {
    const upload = await bucket.createMultipartUpload(key, { httpMetadata });
    const parts: R2UploadedPart[] = [];
    let part = new Uint8Array(PART_SIZE); let filled = 0;
    const send = async (bytes: Uint8Array) => { parts.push(await upload.uploadPart(parts.length + 1, bytes)); };
    return {
      write: async (chunk) => {
        for (let i = 0; i < chunk.length;) {
          const take = Math.min(PART_SIZE - filled, chunk.length - i);
          part.set(chunk.subarray(i, i + take), filled); filled += take; i += take;
          if (filled === PART_SIZE) { await send(part); part = new Uint8Array(PART_SIZE); filled = 0; }
        }
      },
      finish: async () => { if (filled || parts.length === 0) await send(part.subarray(0, filled)); await upload.complete(parts); },
      abort: () => upload.abort(),
      bytes: () => null,
    };
  }
  const held: Uint8Array[] = []; let total = 0; let whole: Uint8Array | null = null;
  return {
    write: async (chunk) => {
      total += chunk.length;
      if (total > BUFFERED_MAX) throw new Error(`the archive exceeds ${BUFFERED_MAX / 1048576} MiB and this backups storage takes no multipart upload, so it cannot be written; keep the archives in R2 or take a data backup`);
      held.push(chunk);
    },
    finish: async () => { whole = concat(held, total); held.length = 0; await bucket.put(key, whole, { httpMetadata }); },
    abort: async () => undefined,
    bytes: () => whole,
  };
}

// ---- writing an archive ----------------------------------------------------------------------------------------
async function tableNames(db: D1Database): Promise<string[]> {
  return (await all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")).map((t) => t.name).filter((t) => !INTERNAL_TABLES.test(t) && !SKIP_TABLES.has(t));
}
async function dumpTable(db: D1Database, t: string): Promise<{ columns: string[]; rows: unknown[][] }> {
  const rows = await all<Record<string, unknown>>(db, `SELECT * FROM ${ident(t)}`);
  const columns = rows.length ? Object.keys(rows[0]!) : (await all<{ name: string }>(db, `PRAGMA table_info(${ident(t)})`)).map((c) => c.name);
  return { columns, rows: rows.map((r) => columns.map((c) => r[c] ?? null)) };
}
/** _collections first, the rest of the system tables next, the user ones last: a streaming restore rebuilds the
 * schema from _collections before any row of a user table arrives */
const orderTables = (ts: string[]) => {
  const rank = (t: string) => (t === "_collections" ? 0 : t.startsWith("_") ? 1 : 2);
  return [...ts].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
};
/** data.jsonl: a head line, then per table a {table, columns} line and one {row} line each, a chunk at a time */
async function* dataLines(db: D1Database, tables: string[], files: string[], created: string): AsyncGenerator<Uint8Array> {
  let buf = `${JSON.stringify({ format: "voidbase-backup", version: 2, created, files })}\n`;
  for (const t of tables) {
    const { columns, rows } = await dumpTable(db, t);
    buf += `${JSON.stringify({ table: t, columns })}\n`;
    for (const r of rows) {
      buf += `${JSON.stringify({ row: r })}\n`;
      if (buf.length >= 65536) { yield enc.encode(buf); buf = ""; }
    }
  }
  if (buf.length) yield enc.encode(buf);
}

/** streams one archive of the given kind into the sink and returns its manifest (the last entry written) */
export async function writeArchive(env: AppEnv["Bindings"], kind: BackupKind, sink: Sink): Promise<Manifest> {
  const db = env.DB;
  const pending: Uint8Array[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((err, chunk) => { if (err) zipError = err; else pending.push(chunk); });
  const flush = async () => { if (zipError) throw zipError; while (pending.length) await sink.write(pending.shift()!); };
  const entries: Record<string, string> = {};
  const add = async (name: string, data: Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, compress: boolean) => {
    const file = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    zip.add(file);
    const h = new Sha256();
    if (data instanceof Uint8Array) { h.update(data); file.push(data, true); }
    else { for await (const chunk of (data instanceof ReadableStream ? chunksOf(data) : data)) { h.update(chunk); file.push(chunk); await flush(); } file.push(new Uint8Array(0), true); }
    await flush();
    entries[name] = h.hex();
  };
  const json = (v: unknown) => enc.encode(JSON.stringify(v, null, 2));

  const collections = await listCollections(db);
  const dataCollections = collections.filter((c) => !c.system && c.type !== "view");
  const created = nowString();
  const existing = kind === "schema" ? [] : await tableNames(db);
  const tables = kind === "schema" ? [] : orderTables(kind === "full" ? existing : dataCollections.map((c) => c.name).filter((t) => existing.includes(t)));
  await add(HEADER_JSON, json({ format: FORMAT, kind, voidbase: VERSION, created, tables } satisfies BackupHeader), true);
  if (kind === "schema") {
    // the definitions alone: every non-system collection, views included, since a view is part of the schema
    await add("collections.json", json(collections.filter((c) => !c.system).map(collectionToJSON)), true);
    const manifest: Manifest = { format: FORMAT, kind, voidbase: VERSION, created, tables: [], files: { count: 0, bytes: 0 }, checksum: checksumOf(entries), entries: { ...entries } };
    await add(MANIFEST_JSON, json(manifest), true);
    zip.end(); await flush();
    return manifest;
  }
  const objects: R2Object[] = [];
  if (kind === "full") objects.push(...(await listAll(env.STORAGE, "")).filter((o) => !o.key.startsWith(PREFIX)));
  else for (const c of dataCollections) objects.push(...(await listAll(env.STORAGE, c.id + "/")));

  if (kind === "full") await add("settings.json", json(publicSettings(await loadSettings(db))), true);
  await add("collections.json", json((kind === "full" ? collections : dataCollections).map(collectionToJSON)), true);
  await add(DATA_JSONL, dataLines(db, tables, objects.map((o) => o.key), created), true);
  let count = 0, bytes = 0;
  for (const obj of objects) {
    const body = await env.STORAGE.get(obj.key);
    if (!body) continue;
    await add(STORAGE_PREFIX + obj.key, body.body, false);
    count++; bytes += body.size;
  }
  const manifest: Manifest = { format: FORMAT, kind, voidbase: VERSION, created, tables, files: { count, bytes }, checksum: checksumOf(entries), entries: { ...entries } };
  await add(MANIFEST_JSON, json(manifest), true);
  zip.end(); await flush();
  return manifest;
}

// ---- reading one back: every entry hashed as it streams, the manifest compared ----------------------------------
export async function verifyArchive(source: ReadableStream<Uint8Array> | Uint8Array): Promise<VerifyResult> {
  const hashes: Record<string, string> = {};
  let manifestParts: Uint8Array[] | null = null; let manifestBytes = 0;
  let hasData = false; let error: string | undefined;
  const u = new Unzip();
  u.register(UnzipInflate);
  u.onfile = (file) => {
    const h = new Sha256();
    const collect = file.name === MANIFEST_JSON ? ([] as Uint8Array[]) : null;
    if (file.name === DATA_JSON || file.name === DATA_JSONL) hasData = true;
    file.ondata = (err, chunk, final) => {
      if (err) { error ??= `${file.name}: ${err.message}`; return; }
      h.update(chunk);
      if (collect) { collect.push(chunk); manifestBytes += chunk.length; }
      if (final) { hashes[file.name] = h.hex(); if (collect) manifestParts = collect; }
    };
    file.start();
  };
  try {
    if (source instanceof Uint8Array) u.push(source, true);
    else { for await (const chunk of chunksOf(source)) u.push(chunk, false); u.push(new Uint8Array(0), true); }
  } catch (err) { error ??= err instanceof Error ? err.message : String(err); }
  const none = (extra: Partial<VerifyResult> = {}): VerifyResult => ({ kind: "legacy", verified: false, voidbase: null, created: null, checksum: null, entries: Object.keys(hashes).length, corrupted: [], missing: [], ...(error ? { error } : {}), ...extra });
  if (!manifestParts) return none(hasData ? {} : { error: error ?? "not a voidbase backup archive" });
  let manifest: Manifest;
  try { manifest = JSON.parse(dec.decode(concat(manifestParts, manifestBytes))) as Manifest; } catch { return none({ error: "manifest.json is not JSON" }); }
  delete hashes["manifest.json"];
  const corrupted = Object.keys(manifest.entries ?? {}).filter((n) => n in hashes && hashes[n] !== manifest.entries[n]);
  const missing = Object.keys(manifest.entries ?? {}).filter((n) => !(n in hashes));
  const extra = Object.keys(hashes).filter((n) => !(n in (manifest.entries ?? {})));
  const checksum = checksumOf(hashes);
  const verified = !error && checksum === manifest.checksum && corrupted.length === 0 && missing.length === 0 && extra.length === 0;
  if (!verified && !error) error = corrupted.length ? `corrupted: ${corrupted.join(", ")}` : missing.length ? `missing: ${missing.join(", ")}` : extra.length ? `not in the manifest: ${extra.join(", ")}` : "checksum mismatch";
  return { kind: parseKind(String(manifest.kind)) ?? "full", verified, voidbase: manifest.voidbase ?? null, created: manifest.created ?? null, checksum, entries: Object.keys(hashes).length, corrupted, missing, ...(error ? { error } : {}), tables: manifest.tables, files: manifest.files };
}
const metaFrom = (v: VerifyResult, prev: BackupMeta | null): BackupMeta => ({
  kind: v.kind, voidbase: v.voidbase, created: v.created, checksum: v.checksum, verified: v.verified, verifiedAt: nowString(),
  ...(v.error ? { verifyError: v.error } : {}), ...(v.corrupted.length ? { corrupted: v.corrupted } : {}), ...(v.tables ? { tables: v.tables } : {}), ...(v.files ? { files: v.files } : {}),
  ...(prev?.offsite !== undefined ? { offsite: prev.offsite } : {}), ...(prev?.offsiteError ? { offsiteError: prev.offsiteError } : {}), ...(prev?.restore ? { restore: prev.restore } : {}),
});

// ---- the off-site copy: one PUT to another S3-compatible bucket, signed by hand ----------------------------------
export interface OffsiteConfig { endpoint: string; bucket: string; accessKey: string; secret: string; region: string }
export function offsiteConfig(env: AppEnv["Bindings"]): OffsiteConfig | null {
  const cfg = { endpoint: knob(env, OFFSITE_VARS.endpoint), bucket: knob(env, OFFSITE_VARS.bucket), accessKey: knob(env, OFFSITE_VARS.accessKey), secret: knob(env, OFFSITE_VARS.secret), region: knob(env, OFFSITE_VARS.region) || "auto" };
  return cfg.endpoint && cfg.bucket && cfg.accessKey && cfg.secret ? cfg : null;
}
/** the signed PUT for one archive at the root of the bucket, path-style; UNSIGNED-PAYLOAD unless a hash is given */
export async function offsiteRequest(cfg: OffsiteConfig, key: string, size: number, opts: { payloadHash?: string; now?: Date } = {}): Promise<{ url: URL; headers: Record<string, string> }> {
  const ep = new URL(cfg.endpoint.includes("://") ? cfg.endpoint : `https://${cfg.endpoint}`);
  const url = new URL(`${ep.protocol}//${ep.host}/${rfc3986(cfg.bucket)}/${key.split("/").map(rfc3986).join("/")}`);
  const headers = await signV4({ method: "PUT", url, headers: { "content-length": String(size), "content-type": "application/zip" }, payloadHash: opts.payloadHash ?? "UNSIGNED-PAYLOAD" }, cfg, opts.now);
  return { url, headers };
}
export async function offsitePut(cfg: OffsiteConfig, key: string, body: Uint8Array | ReadableStream<Uint8Array>, size: number): Promise<void> {
  const { url, headers } = await offsiteRequest(cfg, key, size, body instanceof Uint8Array ? { payloadHash: sha256Hex(body) } : {});
  const res = await fetch(url, { method: "PUT", headers, body: body as unknown as BodyInit, ...(body instanceof Uint8Array ? {} : { duplex: "half" }) } as RequestInit);
  if (res.status >= 300) throw new Error(`PUT ${url.host}/${cfg.bucket}/${key}: HTTP ${res.status} ${(await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200)}`.trim());
}

// ---- create --------------------------------------------------------------------------------------------------
export async function createBackup(env: AppEnv["Bindings"], name: string, opts: { kind?: BackupKind } = {}): Promise<BackupResult> {
  const db = env.DB;
  const kind = opts.kind ?? DEFAULT_KIND;
  if (await activeBackup(db)) throw new Error("try again later - another backup/restore operation has already been started");
  const ev = { app: undefined as unknown, name, exclude: [] as string[], next: async () => undefined as unknown };
  let result: BackupResult | undefined;
  await trigger("onBackupCreate", ev, null, async () => {
    if (!ev.name) ev.name = await generateBackupName(db);
    await lock(db, ev.name);
    try {
      const bk = await backupsStorage(env);
      const key = PREFIX + ev.name;
      const sink = await openSink(bk, key);
      let manifest: Manifest;
      try { manifest = await writeArchive(env, kind, sink); await sink.finish(); } catch (err) { await sink.abort().catch(() => undefined); throw err; }
      // read it back
      const written = sink.bytes() ?? (await bk.get(key));
      if (!written) throw new Error("the archive is not readable after the write");
      const check = await verifyArchive(written instanceof Uint8Array ? written : written.body);
      if (!check.verified) console.error("voidbase: backup written but not verified", ev.name, check.error);
      // the copy that survives losing the account
      const meta = metaFrom(check, null);
      const off = offsiteConfig(env);
      if (off) {
        try {
          const source = sink.bytes() ?? (await bk.get(key));
          if (!source) throw new Error("the archive is not readable");
          const size = source instanceof Uint8Array ? source.length : source.size;
          await offsitePut(off, ev.name, source instanceof Uint8Array ? source : source.body, size);
          meta.offsite = true;
        } catch (err) {
          meta.offsite = false; meta.offsiteError = err instanceof Error ? err.message : String(err);
          console.error("voidbase: backup off-site copy failed", ev.name, meta.offsiteError);
        }
      }
      await writeMeta(bk, ev.name, meta);
      result = { name: ev.name, kind, manifest, verified: check.verified, ...(off ? { offsite: meta.offsite, ...(meta.offsiteError ? { offsiteError: meta.offsiteError } : {}) } : {}) };
    } finally { await unlock(db); }
  });
  if (!result) throw new Error("backup was not created");
  return result;
}

// ---- restore ------------------------------------------------------------------------------------------------
// Two ways in. A format 2 archive (header.json first, rows as data.jsonl) restores in one streaming pass, so the
// peak does not scale with the archive. An archive written before that (data.json, one JSON document with every
// table's rows) is read whole, exactly as it always was. Both are prepared first - the version refusal and "not a
// voidbase archive" have to be the answer to POST /restore, before anything is applied.
interface Opened { kind: BackupKind | "legacy"; entries: Record<string, Uint8Array>; dump: Dump; manifest: Manifest | null; collections: Record<string, unknown>[] | null; settings: unknown }
type Collection = Awaited<ReturnType<typeof listCollections>>[number];
export interface RestorePlan { kind: BackupKind | "legacy"; voidbase: string | null; restored: string[]; created: string[]; skipped: { collection: string; reason: string }[]; settings: boolean }
/** what a prepared archive is: the streaming pass needs only its header, the whole-read one its entries */
interface Prepared { kind: BackupKind | "legacy"; voidbase: string | null; header: BackupHeader | null; opened: Opened | null }

const majorMinor = (v: string): [number, number] => { const m = /^v?(\d+)\.(\d+)/.exec(v.trim()); return m ? [Number(m[1]), Number(m[2])] : [0, 0]; };
/** an archive from a newer major.minor than the instance cannot be restored on it */
export function newerThanInstance(archive: string, instance = VERSION): boolean {
  const [am, an] = majorMinor(archive), [im, iN] = majorMinor(instance);
  return am > im || (am === im && an > iN);
}
const tooNew = (voidbase: string) => new Error(`the archive was written by voidbase ${voidbase}, newer than this instance (${VERSION}); update the instance before restoring it`);

/** data.jsonl read whole, back into the shape data.json held (openArchive and the whole-read restore) */
function linesToDump(text: string, created: string): Dump {
  const dump: Dump = { format: "voidbase-backup", version: 2, created, tables: {}, files: [] };
  let head = true, current: { columns: string[]; rows: unknown[][] } | null = null;
  for (const raw of text.split("\n")) {
    if (!raw) continue;
    const v = JSON.parse(raw) as { format?: string; created?: string; files?: string[]; table?: string; columns?: string[]; row?: unknown[] };
    if (head) { head = false; dump.format = (v.format ?? "") as Dump["format"]; dump.created = v.created ?? created; dump.files = v.files ?? []; continue; }
    if (typeof v.table === "string") { current = { columns: v.columns ?? [], rows: [] }; dump.tables[v.table] = current; }
    else if (v.row) current?.rows.push(v.row);
  }
  return dump;
}

export function openArchive(bytes: Uint8Array): Opened {
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(bytes); } catch { throw new Error("missing or invalid backup file"); }
  const parse = <T>(name: string): T | null => (entries[name] ? (JSON.parse(dec.decode(entries[name])) as T) : null);
  const manifest = parse<Manifest>(MANIFEST_JSON);
  if (manifest && newerThanInstance(manifest.voidbase)) throw tooNew(manifest.voidbase);
  const kind: Opened["kind"] = manifest ? parseKind(String(manifest.kind)) ?? "full" : "legacy";
  // a schema archive carries no rows: its dump is empty by definition
  const raw = entries[DATA_JSON], rawLines = entries[DATA_JSONL];
  if (!raw && !rawLines && kind !== "schema") throw new Error("not a voidbase backup archive (PocketBase SQLite archives cannot be restored on this server)");
  const dump: Dump = rawLines ? linesToDump(dec.decode(rawLines), manifest?.created ?? nowString())
    : raw ? (JSON.parse(dec.decode(raw)) as Dump)
    : { format: "voidbase-backup", version: 1, created: manifest?.created ?? nowString(), tables: {}, files: [] };
  if (dump.format !== "voidbase-backup") throw new Error("unsupported backup format");
  const collections = parse<Record<string, unknown>[]>("collections.json");
  if (kind === "schema" && !collections) throw new Error("a schema archive without collections.json");
  return { kind, entries, dump, manifest, collections, settings: kind === "full" ? parse<unknown>("settings.json") : null };
}

/** the archive read only as far as it must be: a format 2 archive stops after header.json (a few hundred bytes),
 * anything older is read whole and opened the way it always was */
async function prepareRestore(env: AppEnv["Bindings"], key: string): Promise<Prepared> {
  const obj = await (await backupsStorage(env)).get(PREFIX + key);
  if (!obj) throw new Error("missing or invalid backup file");
  const u = new Unzip();
  u.register(UnzipInflate);
  let first: string | null = null, done = false, headLen = 0;
  const head: Uint8Array[] = [];
  u.onfile = (file) => {
    first ??= file.name;
    if (file.name === HEADER_JSON) file.ondata = (err, chunk, final) => { if (err) return; head.push(chunk); headLen += chunk.length; if (final) done = true; };
    else file.ondata = () => undefined;
    file.start();
  };
  const held: Uint8Array[] = [];
  let total = 0, readable = true;
  for await (const chunk of chunksOf(obj.body)) {
    if (readable && first !== null && first !== HEADER_JSON) readable = false;
    if (readable) { try { u.push(chunk, false); } catch { readable = false; } }
    if (done) break;
    held.push(chunk); total += chunk.length;
  }
  if (done) {
    await obj.body.cancel().catch(() => undefined);
    const header = JSON.parse(dec.decode(concat(head, headLen))) as BackupHeader;
    const kind = parseKind(String(header.kind));
    if (!kind) throw new Error("unsupported backup format");
    if (newerThanInstance(header.voidbase)) throw tooNew(header.voidbase);
    return { kind, voidbase: header.voidbase, header: { ...header, kind, tables: header.tables ?? [] }, opened: null };
  }
  const opened = openArchive(concat(held, total));
  return { kind: opened.kind, voidbase: opened.manifest?.voidbase ?? null, header: null, opened };
}

/** what a plan is decided from, whichever way the archive was read */
interface PlanInput { kind: BackupKind | "legacy"; collections: Record<string, unknown>[] | null; tables: string[]; fullNames: string[] }
async function planInto(db: D1Database, a: PlanInput, opts: RestoreOptions, plan: RestorePlan): Promise<void> {
  if (a.kind === "schema") {
    // the definitions land on the instance: a collection it has is updated to the archive's, one it lacks is created
    const have = new Map((await listCollections(db)).map((c) => [c.name.toLowerCase(), c]));
    for (const def of a.collections ?? []) {
      const name = String(def.name ?? ""); const c = have.get(name.toLowerCase());
      if (c?.system) plan.skipped.push({ collection: name, reason: "a system collection is never restored from a schema archive" });
      else if (c) plan.restored.push(name);
      else { plan.created.push(name); plan.restored.push(name); }
    }
    return;
  }
  if (a.kind !== "data") { plan.restored.push(...a.fullNames); return; }
  const instance = new Map((await listCollections(db)).map((c) => [c.name, c]));
  const defs = new Map((a.collections ?? []).map((j) => [String(j.name), j]));
  for (const table of a.tables) {
    const c = instance.get(table);
    if (c?.system) plan.skipped.push({ collection: table, reason: "a system collection is never restored from a data archive" });
    else if (c?.type === "view") plan.skipped.push({ collection: table, reason: "the instance's collection is a view" });
    else if (c) plan.restored.push(table);
    else if (opts.createMissing && defs.has(table)) { plan.created.push(table); plan.restored.push(table); }
    else plan.skipped.push({ collection: table, reason: opts.createMissing ? "the instance has no such collection and the archive carries no definition to create it from" : "the instance has no such collection (pass createMissing to create it from the archive's definition)" });
  }
}
export async function planRestore(db: D1Database, a: Opened, opts: RestoreOptions = {}): Promise<RestorePlan> {
  const plan: RestorePlan = { kind: a.kind, voidbase: a.manifest?.voidbase ?? null, restored: [], created: [], skipped: [], settings: a.settings != null };
  const cols = a.dump.tables["_collections"];
  const fullNames: string[] = [];
  if (cols) { const name = cols.columns.indexOf("name"), system = cols.columns.indexOf("system"); for (const r of cols.rows) if (!r[system]) fullNames.push(String(r[name])); }
  await planInto(db, { kind: a.kind, collections: a.collections, tables: Object.keys(a.dump.tables), fullNames }, opts, plan);
  return plan;
}

const insertSQL = (table: string, columns: string[]) => `INSERT OR REPLACE INTO ${ident(table)} (${columns.map(ident).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
const insertBatch = (db: D1Database, sql: string, rows: unknown[][]) => db.batch(rows.map((r) => stmt(db, sql, r.map((v) => (v === undefined ? null : v)))));
const insertRows = async (db: D1Database, table: string, columns: string[], rows: unknown[][]) => {
  const sql = insertSQL(table, columns);
  for (let i = 0; i < rows.length; i += BATCH_ROWS) await insertBatch(db, sql, rows.slice(i, i + BATCH_ROWS));
};

// ---- the whole-read restore (archives written before header.json) ---------------------------------------------
async function applyFull(env: AppEnv["Bindings"], a: Opened): Promise<void> {
  const db = env.DB;
  // 0. the settings (a full archive): merged over the current ones, the secrets the archive never held kept
  if (a.settings != null) await saveSettings(db, mergeSettings(await loadSettings(db), a.settings));
  // 1. drop every user collection table/view, 2. restore _collections and rebuild the tables, 3. rows, 4. files
  await dropUserTables(db);
  const coll = a.dump.tables["_collections"];
  if (coll) { await run(db, "DELETE FROM `_collections`"); await insertRows(db, "_collections", coll.columns, coll.rows); }
  await rebuildTables(db);
  for (const [table, data] of Object.entries(a.dump.tables)) {
    if (table === "_collections") continue;
    const exists = await one(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
    if (!exists) continue;
    await run(db, `DELETE FROM ${ident(table)}`);
    await insertRows(db, table, data.columns, data.rows);
  }
  for (const o of await listAll(env.STORAGE, "")) if (!o.key.startsWith(PREFIX)) await env.STORAGE.delete(o.key);
  for (const f of a.dump.files) { const bytes = a.entries[STORAGE_PREFIX + f]; if (bytes) await env.STORAGE.put(f, bytes); }
  invalidateCollections();
}

async function applySchema(env: AppEnv["Bindings"], a: Opened, plan: RestorePlan): Promise<void> {
  await importSchema(env.DB, a.collections, plan);
}

async function applyData(env: AppEnv["Bindings"], a: Opened, plan: RestorePlan): Promise<void> {
  const db = env.DB;
  if (plan.created.length) {
    const defs = (a.collections ?? []).filter((j) => plan.created.includes(String(j.name)));
    await importCollections(db, defs, false);
  }
  invalidateCollections();
  const instance = new Map((await listCollections(db)).map((c) => [c.name, c]));
  const archiveIds = new Map((a.collections ?? []).map((j) => [String(j.name), String(j.id)]));
  for (const table of plan.restored) {
    const c = instance.get(table);
    const data = a.dump.tables[table];
    if (!c || !data) continue;
    const have = new Set((await all<{ name: string }>(db, `PRAGMA table_info(${ident(table)})`)).map((x) => x.name));
    const keep = data.columns.map((col, i) => [col, i] as const).filter(([col]) => have.has(col));
    await run(db, `DELETE FROM ${ident(table)}`);
    if (keep.length) await insertRows(db, table, keep.map(([col]) => col), data.rows.map((r) => keep.map(([, i]) => r[i])));
    // the files: the archive's are keyed by its collection id, the instance's by its own
    const from = (archiveIds.get(table) ?? c.id) + "/", to = c.id + "/";
    for (const o of await listAll(env.STORAGE, to)) await env.STORAGE.delete(o.key);
    for (const f of a.dump.files) { if (!f.startsWith(from)) continue; const bytes = a.entries[STORAGE_PREFIX + f]; if (bytes) await env.STORAGE.put(to + f.slice(from.length), bytes); }
  }
  invalidateCollections();
}

// ---- the steps both ways share ---------------------------------------------------------------------------------
async function dropUserTables(db: D1Database): Promise<void> {
  const current = await loadCollections(db);
  const drops: D1PreparedStatement[] = [];
  for (const c of new Set(current.values())) if (!c.system) drops.push(stmt(db, c.type === "view" ? `DROP VIEW IF EXISTS ${ident(c.name)}` : `DROP TABLE IF EXISTS ${ident(c.name)}`, []));
  if (drops.length) await db.batch(drops);
}
/** the tables and views the restored _collections rows call for */
async function rebuildTables(db: D1Database): Promise<void> {
  invalidateCollections();
  const restored = await loadCollections(db);
  const creates: D1PreparedStatement[] = [];
  for (const c of new Set(restored.values())) {
    if (c.system) continue;
    if (c.type === "view") creates.push(db.prepare(createViewSQL(c.name, String(c.options.viewQuery ?? ""))));
    else for (const sql of planCreate(c)) creates.push(db.prepare(sql));
  }
  if (creates.length) await db.batch(creates);
}
async function importSchema(db: D1Database, collections: Record<string, unknown>[] | null, plan: RestorePlan): Promise<void> {
  const wanted = new Set(plan.restored.map((n) => n.toLowerCase()));
  const defs = (collections ?? []).filter((j) => wanted.has(String(j.name ?? "").toLowerCase()));
  if (defs.length) await importCollections(db, defs, false);
  invalidateCollections();
}

// ---- the streaming restore (format 2 archives) -----------------------------------------------------------------
/** one storage put fed from the zip entry as it arrives; ready() is the put's backpressure */
interface PutSink { write(chunk: Uint8Array): void; ready(): Promise<void>; close(): Promise<void> }
function openPut(bucket: R2Bucket, key: string): PutSink {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let wake: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; }, pull: () => { const w = wake; wake = null; w?.(); } });
  const done = bucket.put(key, stream as unknown as ReadableStream).then(() => undefined);
  const settled = done.catch(() => undefined);
  return {
    write: (chunk) => ctrl.enqueue(chunk),
    ready: async () => { const d = ctrl.desiredSize; if (d === null || d > 0) return; await Promise.race([new Promise<void>((r) => { wake = r; }), settled]); },
    close: async () => { ctrl.close(); await done; },
  };
}

/** what one push into the unzipper hands the restore, in the order the archive holds it */
type Op =
  | { t: "entry"; name: string; data: Uint8Array }
  | { t: "table"; name: string; columns: string[] }
  | { t: "rows"; rows: unknown[][] }
  | { t: "data-end" }
  | { t: "file"; name: string; chunk: Uint8Array | null };

const truncated = (key: string, why: string) =>
  new Error(`the backup archive ${key} could not be read to the end (${why}): the restore stopped part way, so the instance holds what had already been loaded`);

/** the whole restore of a format 2 archive in one pass over the zip; the plan is filled in as the archive says it */
async function streamRestore(env: AppEnv["Bindings"], key: string, header: BackupHeader, opts: RestoreOptions, plan: RestorePlan): Promise<Manifest | null> {
  const db = env.DB;
  const obj = await (await backupsStorage(env)).get(PREFIX + key);
  if (!obj) throw new Error("missing or invalid backup file");
  const kind = header.kind;
  const small = new Set([HEADER_JSON, "settings.json", "collections.json", MANIFEST_JSON]);

  // what the pass has learnt so far
  let manifest: Manifest | null = null;
  let defs: Record<string, unknown>[] | null = null;
  let instance = new Map<string, Collection>();
  let archiveIds = new Map<string, string>();
  const fileTargets: [string, string][] = [];
  let table: { sql: string; map: number[] | null } | null = null;
  let rebuilt = false, storageReady = false;
  let put: { name: string; sink: PutSink | null } | null = null;

  const prepareStorage = async () => {
    if (storageReady) return;
    storageReady = true;
    if (kind === "full") { for (const o of await listAll(env.STORAGE, "")) if (!o.key.startsWith(PREFIX)) await env.STORAGE.delete(o.key); return; }
    if (kind !== "data") return;
    for (const t of plan.restored) {
      const c = instance.get(t);
      if (!c) continue;
      fileTargets.push([(archiveIds.get(t) ?? c.id) + "/", c.id + "/"]);
      for (const o of await listAll(env.STORAGE, c.id + "/")) await env.STORAGE.delete(o.key);
    }
  };
  const targetKey = (rel: string): string | null => {
    if (kind === "full") return rel;
    for (const [from, to] of fileTargets) if (rel.startsWith(from)) return to + rel.slice(from.length);
    return null;
  };
  // collections.json is the last entry before the rows: the plan and everything the rows land on is decided here
  const beforeData = async () => {
    if (kind === "schema") { await planInto(db, { kind, collections: defs, tables: [], fullNames: [] }, opts, plan); await importSchema(db, defs, plan); return; }
    if (kind === "data") {
      await planInto(db, { kind, collections: defs, tables: header.tables, fullNames: [] }, opts, plan);
      if (plan.created.length) await importCollections(db, (defs ?? []).filter((j) => plan.created.includes(String(j.name))), false);
      invalidateCollections();
      instance = new Map((await listCollections(db)).map((c) => [c.name, c]));
      archiveIds = new Map((defs ?? []).map((j) => [String(j.name), String(j.id)]));
      return;
    }
    // full: the archive's own _collections rows decide the schema, and collections.json names what it restores
    plan.restored.push(...(defs ?? []).filter((j) => !j.system).map((j) => String(j.name)));
    await dropUserTables(db);
  };
  const onTable = async (name: string, columns: string[]) => {
    table = null;
    if (kind === "full") {
      if (name === "_collections") { await run(db, "DELETE FROM `_collections`"); table = { sql: insertSQL(name, columns), map: null }; return; }
      if (!rebuilt) { await rebuildTables(db); rebuilt = true; }
      if (!(await one(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]))) return;
      await run(db, `DELETE FROM ${ident(name)}`);
      table = { sql: insertSQL(name, columns), map: null };
      return;
    }
    if (kind !== "data" || !plan.restored.includes(name)) return;
    const c = instance.get(name);
    if (!c) return;
    const have = new Set((await all<{ name: string }>(db, `PRAGMA table_info(${ident(name)})`)).map((x) => x.name));
    const keep = columns.map((col, i) => [col, i] as const).filter(([col]) => have.has(col));
    await run(db, `DELETE FROM ${ident(name)}`);
    if (keep.length) table = { sql: insertSQL(name, keep.map(([col]) => col)), map: keep.map(([, i]) => i) };
  };
  const closePut = async () => { const open = put; put = null; if (open?.sink) await open.sink.close(); };
  const onFile = async (name: string, chunk: Uint8Array | null) => {
    await prepareStorage();
    if (put?.name !== name) {
      await closePut();
      const target = targetKey(name.slice(STORAGE_PREFIX.length));
      put = { name, sink: target ? openPut(env.STORAGE, target) : null };
    }
    const sink = put?.sink;
    if (!chunk) { await closePut(); return; }
    if (sink) { sink.write(chunk); await sink.ready(); }
  };
  const apply = async (op: Op): Promise<void> => {
    if (op.t === "entry") {
      if (op.name === "settings.json" && kind === "full") { plan.settings = true; await saveSettings(db, mergeSettings(await loadSettings(db), JSON.parse(dec.decode(op.data)) as unknown)); }
      else if (op.name === "collections.json") { defs = JSON.parse(dec.decode(op.data)) as Record<string, unknown>[]; await beforeData(); }
      else if (op.name === MANIFEST_JSON) manifest = JSON.parse(dec.decode(op.data)) as Manifest;
      return;
    }
    if (op.t === "table") return onTable(op.name, op.columns);
    if (op.t === "rows") { const t = table; if (!t) return; const map = t.map; await insertBatch(db, t.sql, map ? op.rows.map((r) => map.map((i) => r[i])) : op.rows); return; }
    if (op.t === "data-end") { table = null; if (kind === "full" && !rebuilt) { await rebuildTables(db); rebuilt = true; } await prepareStorage(); return; }
    return onFile(op.name, op.chunk);
  };

  // the pass: each slice of the archive is pushed into the unzipper, then what it produced is applied
  const ops: Op[] = [];
  let at = 0, produced = 0, readError: string | null = null, headLine = false, rest = "";
  let rows: unknown[][] = [], rowBytes = 0;
  const lines = new TextDecoder();
  const flushRows = () => { if (rows.length) { ops.push({ t: "rows", rows }); rows = []; rowBytes = 0; } };
  const u = new Unzip();
  u.register(UnzipInflate);
  u.onfile = (file) => {
    const name = file.name;
    if (small.has(name)) {
      const held: Uint8Array[] = [];
      let n = 0;
      file.ondata = (err, chunk, final) => {
        if (err) { readError ??= `${name}: ${err.message}`; return; }
        produced += chunk.length; held.push(chunk); n += chunk.length;
        if (final) ops.push({ t: "entry", name, data: concat(held, n) });
      };
    } else if (name === DATA_JSONL) {
      file.ondata = (err, chunk, final) => {
        if (err) { readError ??= `${name}: ${err.message}`; return; }
        produced += chunk.length;
        rest += lines.decode(chunk, { stream: !final });
        let from = 0, nl = rest.indexOf("\n");
        for (; nl >= 0; nl = rest.indexOf("\n", from)) {
          const line = rest.slice(from, nl);
          from = nl + 1;
          if (!line) continue;
          const v = JSON.parse(line) as { format?: string; table?: string; columns?: string[]; row?: unknown[] };
          if (!headLine) { headLine = true; if (v.format !== "voidbase-backup") readError ??= "unsupported backup format"; continue; }
          if (typeof v.table === "string") { flushRows(); ops.push({ t: "table", name: v.table, columns: v.columns ?? [] }); }
          else if (v.row) { rows.push(v.row); rowBytes += line.length; if (rows.length >= BATCH_ROWS || rowBytes >= BATCH_BYTES) flushRows(); }
        }
        rest = from ? rest.slice(from) : rest;
        if (final) { flushRows(); ops.push({ t: "data-end" }); }
      };
    } else if (name.startsWith(STORAGE_PREFIX)) {
      file.ondata = (err, chunk, final) => {
        if (err) { readError ??= `${name}: ${err.message}`; return; }
        produced += chunk.length;
        if (chunk.length) ops.push({ t: "file", name, chunk });
        if (final) ops.push({ t: "file", name, chunk: null });
      };
    } else file.ondata = (err, chunk) => { if (err) readError ??= `${name}: ${err.message}`; else produced += chunk.length; };
    file.start();
  };
  const drain = async () => {
    for (; at < ops.length; at++) await apply(ops[at]!);
    ops.length = 0; at = 0;
    if (readError) throw new Error(readError);
  };
  const push = (chunk: Uint8Array, final: boolean) => {
    try { u.push(chunk, final); } catch (err) { throw truncated(key, err instanceof Error ? err.message : String(err)); }
  };

  let slice = SLICE_MAX;
  for await (const chunk of chunksOf(obj.body)) {
    for (let i = 0; i < chunk.length;) {
      const n = Math.min(slice, chunk.length - i);
      produced = 0;
      push(chunk.subarray(i, i + n), false);
      i += n;
      await drain();
      if (produced > SLICE_OUT) slice = Math.max(SLICE_MIN, Math.floor((n * SLICE_OUT) / produced));
    }
  }
  push(new Uint8Array(0), true);
  await drain();
  await closePut();
  if (!manifest) throw truncated(key, `${MANIFEST_JSON} never arrived`);
  invalidateCollections();
  return manifest;
}

// ---- what a restore does, whichever way the archive was read ---------------------------------------------------
export async function restoreBackup(env: AppEnv["Bindings"], key: string, opts: RestoreOptions = {}): Promise<RestorePlan> {
  return runRestore(env, key, await prepareRestore(env, key), opts);
}
async function runRestore(env: AppEnv["Bindings"], key: string, prep: Prepared, opts: RestoreOptions): Promise<RestorePlan> {
  const db = env.DB;
  const a = prep.opened;
  let plan: RestorePlan = { kind: prep.kind, voidbase: prep.voidbase, restored: [], created: [], skipped: [], settings: false };
  if (a) plan = await planRestore(db, a, opts);
  let manifest: Manifest | null = a?.manifest ?? null;
  await lock(db, key);
  try {
    const ev = { app: undefined as unknown, name: key, exclude: [] as string[], next: async () => undefined as unknown };
    await trigger("onBackupRestore", ev, null, async () => {
      if (!a) { manifest = await streamRestore(env, key, prep.header!, opts, plan); return; }
      if (a.kind === "data") await applyData(env, a, plan);
      else if (a.kind === "schema") await applySchema(env, a, plan);
      else await applyFull(env, a);
    });
    const bk = await backupsStorage(env);
    const meta = (await readMeta(bk, key)) ?? { kind: plan.kind, voidbase: manifest?.voidbase ?? prep.voidbase, created: manifest?.created ?? null, checksum: manifest?.checksum ?? null, verified: false, verifiedAt: null };
    meta.restore = { at: nowString(), kind: plan.kind, restored: plan.restored, created: plan.created, skipped: plan.skipped, settings: plan.settings };
    await writeMeta(bk, key, meta).catch(() => undefined);
    if (plan.skipped.length) console.warn("voidbase: restore skipped", key, plan.skipped.map((s) => `${s.collection}: ${s.reason}`).join("; "));
  } finally { await unlock(db); }
  return plan;
}

// ---- the schedule: settings.backups.cron, the kind and the retention from the env ------------------------------
export async function autoBackup(env: AppEnv["Bindings"]): Promise<void> {
  const name = await generateBackupName(env.DB, "@auto_pb_backup_");
  await dispatch({ type: "backup", name }, { env });
}
/** the scheduled backup: create (VOIDBASE_BACKUP_KIND), then keep the newest n (VOIDBASE_BACKUP_KEEP, else
 * settings.backups.cronMaxKeep) only after a verified write */
export async function runScheduledBackup(env: AppEnv["Bindings"], name: string): Promise<BackupResult | null> {
  env = await withS3Storage(env);
  const settings = await loadSettings(env.DB);
  const kind = parseKind(knob(env, KIND_VAR)) ?? DEFAULT_KIND;
  let result: BackupResult;
  try { result = await withHookStore(env.DB, env, () => createBackup(env, name, { kind })); } catch (err) { console.error("voidbase: [Backup cron] Failed to create backup", name, err); return null; }
  const keepKnob = knob(env, KEEP_VAR);
  const maxKeep = keepKnob ? Math.max(0, Math.floor(Number(keepKnob)) || 0) : settings.backups.cronMaxKeep;
  if (maxKeep && result.verified) await pruneAutoBackups(env, maxKeep);
  return result;
}
export async function pruneAutoBackups(env: AppEnv["Bindings"], keep: number): Promise<string[]> {
  const bk = await backupsStorage(env);
  const autos = (await listAll(bk, PREFIX + "@auto_pb_backup_")).filter((o) => !isMeta(o.key)).sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime() || (a.key < b.key ? 1 : -1));
  const gone: string[] = [];
  for (const o of autos.slice(keep)) { await bk.delete(o.key); await bk.delete(o.key + META_SUFFIX).catch(() => undefined); gone.push(o.key.slice(PREFIX.length)); }
  return gone;
}
// runs from the jobs queue on Cloudflare (inline elsewhere)
registerJobHandler("backup", async (env, job) => { await runScheduledBackup(env, job.name); });

// ---- the routes ----------------------------------------------------------------------------------------------
const validation = (field: string, code: string, message: string, params?: Record<string, unknown>) => new ApiError(400, "An error occurred while validating the submitted data.", { [field]: { code, message, ...(params ? { params } : {}) } } as never);

export function mountBackupsApi(app: Hono<AppEnv>) {
  app.get("/api/backups", async (c) => {
    requireSuperuser(c);
    const bk = await backupsStorage(c.env);
    const objs = (await listAll(bk, PREFIX)).filter((o) => !isMeta(o.key)).sort((a, b) => (a.key < b.key ? -1 : 1));
    const items = await Promise.all(objs.map(async (o) => {
      const name = o.key.slice(PREFIX.length);
      const m = await readMeta(bk, name);
      return {
        key: name, modified: nowString(o.uploaded), size: o.size,
        kind: m?.kind ?? "legacy", verified: m?.verified ?? false, voidbase: m?.voidbase ?? null,
        ...(m?.verifyError ? { verifyError: m.verifyError } : {}),
        ...(m?.offsite !== undefined ? { offsite: m.offsite } : {}), ...(m?.offsiteError ? { offsiteError: m.offsiteError } : {}),
        ...(m?.restore ? { restore: m.restore } : {}),
      };
    }));
    return c.json(items);
  });
  app.post("/api/backups", async (c) => {
    requireSuperuser(c);
    if (await activeBackup(c.env.DB)) throw badRequest("Try again later - another backup/restore process has already been started");
    let body: Record<string, unknown> = {};
    try { body = (await c.req.json()) ?? {}; } catch { body = {}; }
    const name = String(body.name ?? "");
    if (name) {
      if (name.length > 150) throw validation("name", "validation_length_out_of_range", "The length must be between 1 and 150.", { max: 150, min: 1 });
      if (!NAME_RE.test(name)) throw validation("name", "validation_match_invalid", "Must be in a valid format.");
      if (await (await backupsStorage(c.env)).head(PREFIX + name)) throw validation("name", "validation_backup_name_exists", "The backup file name is invalid or already exists.");
    }
    const rawKind = body.kind === undefined || body.kind === null || body.kind === "" ? DEFAULT_KIND : String(body.kind);
    const kind = parseKind(rawKind);
    if (!kind) throw validation("kind", "validation_in_invalid", "Must be one of: full, data, schema.");
    try { await createBackup(c.env, name, { kind }); } catch (err) { console.error("voidbase: failed to create backup", name, err); throw badRequest("Failed to create backup."); }
    return c.body(null, 204);
  });
  app.post("/api/backups/upload", async (c) => {
    requireSuperuser(c);
    let file: File | null = null;
    try { const fd = await c.req.formData(); const f = fd.get("file"); if (f instanceof File) file = f; } catch { /* no multipart */ }
    if (!file) throw validation("file", "validation_required", "Cannot be blank.");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
    if (!isZip) throw validation("file", "validation_invalid_mime_type", `"${normalizeFilename(file.name, file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "")}" mime type must be one of: application/zip.`);
    const bk = await backupsStorage(c.env);
    if (await bk.head(PREFIX + file.name)) throw validation("file", "validation_backup_name_exists", "Backup file with the specified name already exists.");
    await bk.put(PREFIX + file.name, bytes, { httpMetadata: { contentType: "application/zip" } });
    // an uploaded archive is verified on arrival, so the listing knows its kind and version at once
    try { await writeMeta(bk, file.name, metaFrom(await verifyArchive(bytes), null)); } catch (err) { console.error("voidbase: could not verify the uploaded backup", file.name, err); }
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
    await bk.delete(metaKey(key)).catch(() => undefined);
    return c.body(null, 204);
  });
  app.post("/api/backups/:key/verify", async (c) => {
    requireSuperuser(c);
    const key = c.req.param("key") ?? "";
    const bk = await backupsStorage(c.env);
    const obj = await bk.get(PREFIX + key);
    if (!obj) throw badRequest("Missing or invalid backup file.");
    const check = await verifyArchive(obj.body);
    const meta = metaFrom(check, await readMeta(bk, key));
    await writeMeta(bk, key, meta);
    return c.json({ key, kind: check.kind, verified: check.verified, voidbase: check.voidbase, checksum: check.checksum, entries: check.entries, corrupted: check.corrupted, missing: check.missing, ...(check.error ? { error: check.error } : {}), ...(meta.offsite !== undefined ? { offsite: meta.offsite } : {}) });
  });
  app.post("/api/backups/:key/restore", async (c) => {
    requireSuperuser(c);
    if (await activeBackup(c.env.DB)) throw badRequest("Try again later - another backup/restore process has already been started.");
    const key = c.req.param("key") ?? "";
    if (!(await (await backupsStorage(c.env)).head(PREFIX + key))) throw badRequest("Missing or invalid backup file.");
    let body: Record<string, unknown> = {};
    try { body = (await c.req.json()) ?? {}; } catch { body = {}; }
    const opts: RestoreOptions = { createMissing: body.createMissing === true };
    // the archive is prepared here so a refusal (not a voidbase archive, written by a newer voidbase) is the answer
    let prep: Prepared;
    try { prep = await prepareRestore(c.env, key); } catch (err) { throw badRequest(`Failed to restore backup. Raw error: \n${err instanceof Error ? err.message : String(err)}`); }
    c.executionCtx.waitUntil(runRestore(c.env, key, prep, opts).catch((err) => console.error("voidbase: Failed to restore backup", key, err)));
    return c.body(null, 204);
  });
}
