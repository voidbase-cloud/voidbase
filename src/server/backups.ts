// Backups (apis/backup*.go): zip archives kept in R2 under __backups__/. Two kinds of archive, both restorable here:
//   full  - data.json (every D1 table: columns and rows, as the first archives held), settings.json (the settings
//           as GET /api/settings answers them, secrets left out), collections.json (every collection as the
//           collections API exports it), storage/<collection>/<record>/<file> for every uploaded file, and
//           manifest.json last (kind, version, tables, file count and bytes, a sha256 per entry and one over them).
//   data  - the rows of every non-system collection, their files, their definitions, and manifest.json. No
//           settings, no _superusers, no auth origins, OTPs, MFAs or external auths, no token secrets.
// Archives written before the manifest existed (data.json and storage/ only) read as kind "legacy" and restore as
// they always did. PocketBase archives (SQLite files) cannot be restored here.
//
// Files are streamed into the zip one chunk at a time (fflate's streaming Zip), never held whole. The archive
// itself streams to R2 as a multipart upload in 10 MiB parts when the backups storage offers one (R2 does); a
// storage that does not (the S3 backups bucket from the settings, the Bun runtime's local store) takes the archive
// as one object, so it is buffered whole, capped at BUFFERED_MAX. After the write the archive is read back as a
// stream, every entry hashed and the manifest compared; the result and the off-site copy's outcome live in a
// sidecar (<name>.meta.json) next to the archive, which is what the listing reads.
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
const INTERNAL_TABLES = /^(_cf_|__drizzle|_void|d1_migrations|sqlite_)/;
const SKIP_TABLES = new Set(["_changes", "_realtime_clients"]);
const PART_SIZE = 10 * 1024 * 1024;
/** the largest archive a storage without multipart uploads takes (it is held in memory before the single put) */
export const BUFFERED_MAX = 256 * 1024 * 1024;

export type BackupKind = "full" | "data";
export const DEFAULT_KIND: BackupKind = "full";
export const KIND_VAR = "VOIDBASE_BACKUP_KIND";
export const KEEP_VAR = "VOIDBASE_BACKUP_KEEP";
export const OFFSITE_VARS = { endpoint: "VOIDBASE_BACKUP_S3_ENDPOINT", bucket: "VOIDBASE_BACKUP_S3_BUCKET", accessKey: "VOIDBASE_BACKUP_S3_ACCESS_KEY_ID", secret: "VOIDBASE_BACKUP_S3_SECRET_ACCESS_KEY", region: "VOIDBASE_BACKUP_S3_REGION" } as const;

interface Dump { format: "voidbase-backup"; version: 1; created: string; tables: Record<string, { columns: string[]; rows: unknown[][] }>; files: string[] }
export interface Manifest {
  format: "voidbase-backup";
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
export const parseKind = (raw: string): BackupKind | null => (raw === "full" || raw === "data" ? raw : null);

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

/** streams one archive of the given kind into the sink and returns its manifest (the last entry written) */
export async function writeArchive(env: AppEnv["Bindings"], kind: BackupKind, sink: Sink): Promise<Manifest> {
  const db = env.DB;
  const pending: Uint8Array[] = [];
  let zipError: Error | null = null;
  const zip = new Zip((err, chunk) => { if (err) zipError = err; else pending.push(chunk); });
  const flush = async () => { if (zipError) throw zipError; while (pending.length) await sink.write(pending.shift()!); };
  const entries: Record<string, string> = {};
  const add = async (name: string, data: Uint8Array | ReadableStream<Uint8Array>, compress: boolean) => {
    const file = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    zip.add(file);
    const h = new Sha256();
    if (data instanceof Uint8Array) { h.update(data); file.push(data, true); }
    else { for await (const chunk of chunksOf(data)) { h.update(chunk); file.push(chunk); await flush(); } file.push(new Uint8Array(0), true); }
    await flush();
    entries[name] = h.hex();
  };
  const json = (v: unknown) => enc.encode(JSON.stringify(v, null, 2));

  const collections = await listCollections(db);
  const dataCollections = collections.filter((c) => !c.system && c.type !== "view");
  const existing = await tableNames(db);
  const tables = kind === "full" ? existing : dataCollections.map((c) => c.name).filter((t) => existing.includes(t));
  const objects: R2Object[] = [];
  if (kind === "full") objects.push(...(await listAll(env.STORAGE, "")).filter((o) => !o.key.startsWith(PREFIX)));
  else for (const c of dataCollections) objects.push(...(await listAll(env.STORAGE, c.id + "/")));
  const created = nowString();

  if (kind === "full") await add("settings.json", json(publicSettings(await loadSettings(db))), true);
  await add("collections.json", json((kind === "full" ? collections : dataCollections).map(collectionToJSON)), true);
  const dump: Dump = { format: "voidbase-backup", version: 1, created, tables: {}, files: objects.map((o) => o.key) };
  for (const t of tables) dump.tables[t] = await dumpTable(db, t);
  await add("data.json", enc.encode(JSON.stringify(dump)), true);
  let count = 0, bytes = 0;
  for (const obj of objects) {
    const body = await env.STORAGE.get(obj.key);
    if (!body) continue;
    await add(`storage/${obj.key}`, body.body, false);
    count++; bytes += body.size;
  }
  const manifest: Manifest = { format: "voidbase-backup", kind, voidbase: VERSION, created, tables, files: { count, bytes }, checksum: checksumOf(entries), entries: { ...entries } };
  await add("manifest.json", json(manifest), true);
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
    const collect = file.name === "manifest.json" ? ([] as Uint8Array[]) : null;
    if (file.name === "data.json") hasData = true;
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
interface Opened { kind: BackupKind | "legacy"; entries: Record<string, Uint8Array>; dump: Dump; manifest: Manifest | null; collections: Record<string, unknown>[] | null; settings: unknown }
export interface RestorePlan { kind: BackupKind | "legacy"; voidbase: string | null; restored: string[]; created: string[]; skipped: { collection: string; reason: string }[]; settings: boolean }

const majorMinor = (v: string): [number, number] => { const m = /^v?(\d+)\.(\d+)/.exec(v.trim()); return m ? [Number(m[1]), Number(m[2])] : [0, 0]; };
/** an archive from a newer major.minor than the instance cannot be restored on it */
export function newerThanInstance(archive: string, instance = VERSION): boolean {
  const [am, an] = majorMinor(archive), [im, iN] = majorMinor(instance);
  return am > im || (am === im && an > iN);
}
export function openArchive(bytes: Uint8Array): Opened {
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(bytes); } catch { throw new Error("missing or invalid backup file"); }
  const raw = entries["data.json"];
  if (!raw) throw new Error("not a voidbase backup archive (PocketBase SQLite archives cannot be restored on this server)");
  const dump = JSON.parse(dec.decode(raw)) as Dump;
  if (dump.format !== "voidbase-backup") throw new Error("unsupported backup format");
  const parse = <T>(name: string): T | null => (entries[name] ? (JSON.parse(dec.decode(entries[name])) as T) : null);
  const manifest = parse<Manifest>("manifest.json");
  if (manifest && newerThanInstance(manifest.voidbase)) throw new Error(`the archive was written by voidbase ${manifest.voidbase}, newer than this instance (${VERSION}); update the instance before restoring it`);
  const kind: Opened["kind"] = manifest ? parseKind(String(manifest.kind)) ?? "full" : "legacy";
  return { kind, entries, dump, manifest, collections: parse<Record<string, unknown>[]>("collections.json"), settings: kind === "full" ? parse<unknown>("settings.json") : null };
}
async function fetchArchive(env: AppEnv["Bindings"], key: string): Promise<Opened> {
  const obj = await (await backupsStorage(env)).get(PREFIX + key);
  if (!obj) throw new Error("missing or invalid backup file");
  return openArchive(new Uint8Array(await obj.arrayBuffer()));
}

export async function planRestore(db: D1Database, a: Opened, opts: RestoreOptions = {}): Promise<RestorePlan> {
  const plan: RestorePlan = { kind: a.kind, voidbase: a.manifest?.voidbase ?? null, restored: [], created: [], skipped: [], settings: a.settings != null };
  if (a.kind !== "data") {
    const cols = a.dump.tables["_collections"];
    if (cols) { const name = cols.columns.indexOf("name"), system = cols.columns.indexOf("system"); for (const r of cols.rows) if (!r[system]) plan.restored.push(String(r[name])); }
    return plan;
  }
  const instance = new Map((await listCollections(db)).map((c) => [c.name, c]));
  const defs = new Map((a.collections ?? []).map((j) => [String(j.name), j]));
  for (const table of Object.keys(a.dump.tables)) {
    const c = instance.get(table);
    if (c?.system) plan.skipped.push({ collection: table, reason: "a system collection is never restored from a data archive" });
    else if (c?.type === "view") plan.skipped.push({ collection: table, reason: "the instance's collection is a view" });
    else if (c) plan.restored.push(table);
    else if (opts.createMissing && defs.has(table)) { plan.created.push(table); plan.restored.push(table); }
    else plan.skipped.push({ collection: table, reason: opts.createMissing ? "the instance has no such collection and the archive carries no definition to create it from" : "the instance has no such collection (pass createMissing to create it from the archive's definition)" });
  }
  return plan;
}

const insertRows = async (db: D1Database, table: string, columns: string[], rows: unknown[][]) => {
  for (let i = 0; i < rows.length; i += 40) {
    const chunk = rows.slice(i, i + 40);
    await db.batch(chunk.map((r) => stmt(db, `INSERT OR REPLACE INTO ${ident(table)} (${columns.map(ident).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, r.map((v) => (v === undefined ? null : v)))));
  }
};

async function applyFull(env: AppEnv["Bindings"], a: Opened): Promise<void> {
  const db = env.DB;
  // 0. the settings (a full archive): merged over the current ones, the secrets the archive never held kept
  if (a.settings != null) await saveSettings(db, mergeSettings(await loadSettings(db), a.settings));
  // 1. drop every user collection table/view, 2. restore _collections and rebuild the tables, 3. rows, 4. files
  const current = await loadCollections(db);
  const drops: D1PreparedStatement[] = [];
  for (const c of new Set(current.values())) if (!c.system) drops.push(stmt(db, c.type === "view" ? `DROP VIEW IF EXISTS ${ident(c.name)}` : `DROP TABLE IF EXISTS ${ident(c.name)}`, []));
  if (drops.length) await db.batch(drops);
  const coll = a.dump.tables["_collections"];
  if (coll) { await run(db, "DELETE FROM `_collections`"); await insertRows(db, "_collections", coll.columns, coll.rows); }
  invalidateCollections();
  const restored = await loadCollections(db);
  const creates: D1PreparedStatement[] = [];
  for (const c of new Set(restored.values())) {
    if (c.system) continue;
    if (c.type === "view") creates.push(db.prepare(createViewSQL(c.name, String(c.options.viewQuery ?? ""))));
    else for (const sql of planCreate(c)) creates.push(db.prepare(sql));
  }
  if (creates.length) await db.batch(creates);
  for (const [table, data] of Object.entries(a.dump.tables)) {
    if (table === "_collections") continue;
    const exists = await one(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
    if (!exists) continue;
    await run(db, `DELETE FROM ${ident(table)}`);
    await insertRows(db, table, data.columns, data.rows);
  }
  for (const o of await listAll(env.STORAGE, "")) if (!o.key.startsWith(PREFIX)) await env.STORAGE.delete(o.key);
  for (const f of a.dump.files) { const bytes = a.entries[`storage/${f}`]; if (bytes) await env.STORAGE.put(f, bytes); }
  invalidateCollections();
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
    for (const f of a.dump.files) { if (!f.startsWith(from)) continue; const bytes = a.entries[`storage/${f}`]; if (bytes) await env.STORAGE.put(to + f.slice(from.length), bytes); }
  }
  invalidateCollections();
}

export async function restoreBackup(env: AppEnv["Bindings"], key: string, opts: RestoreOptions = {}): Promise<RestorePlan> {
  const a = await fetchArchive(env, key);
  return restoreOpened(env, key, a, opts);
}
async function restoreOpened(env: AppEnv["Bindings"], key: string, a: Opened, opts: RestoreOptions): Promise<RestorePlan> {
  const db = env.DB;
  const plan = await planRestore(db, a, opts);
  await lock(db, key);
  try {
    const ev = { app: undefined as unknown, name: key, exclude: [] as string[], next: async () => undefined as unknown };
    await trigger("onBackupRestore", ev, null, async () => { if (a.kind === "data") await applyData(env, a, plan); else await applyFull(env, a); });
    const bk = await backupsStorage(env);
    const meta = (await readMeta(bk, key)) ?? { kind: a.kind, voidbase: a.manifest?.voidbase ?? null, created: a.manifest?.created ?? null, checksum: a.manifest?.checksum ?? null, verified: false, verifiedAt: null };
    meta.restore = { at: nowString(), kind: a.kind, restored: plan.restored, created: plan.created, skipped: plan.skipped, settings: plan.settings };
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
    if (!kind) throw validation("kind", "validation_in_invalid", "Must be one of: full, data.");
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
    // the archive is opened here so a refusal (not a voidbase archive, written by a newer voidbase) is the answer
    let opened: Opened;
    try { opened = await fetchArchive(c.env, key); } catch (err) { throw badRequest(`Failed to restore backup. Raw error: \n${err instanceof Error ? err.message : String(err)}`); }
    c.executionCtx.waitUntil(restoreOpened(c.env, key, opened, opts).catch((err) => console.error("voidbase: Failed to restore backup", key, err)));
    return c.body(null, 204);
  });
}
