// The backups plugin's archive writer and reader over an in-memory D1 (bun:sqlite) and an in-memory R2: what a
// full and a data archive hold and say in their manifest, verification catching a corrupted entry, the restore of
// each kind with its refusals, retention after a scheduled write, the hand-signed off-site PUT against AWS's
// published SigV4 vector, and a failed off-site copy leaving the backup intact. The routes are exercised through
// the plugin's Hono app the way the kernel mounts them.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { Zip, ZipDeflate, ZipPassThrough, unzipSync, zipSync } from "fflate";
import { d1 } from "../../src/node/d1";
import { provideAuthLookup } from "../../src/server/auth-slot";
import { provider } from "../../src/server/plugins/auth";
import { BUFFERED_MAX, Sha256, createBackup, mountBackupsApi, newerThanInstance, offsiteConfig, offsiteRequest, openArchive, planRestore, pruneAutoBackups, restoreBackup, runScheduledBackup, sha256Hex, verifyArchive, writeArchive, type Manifest } from "../../src/server/backups";
import { insertCollection } from "../../src/server/bootstrap";
import { invalidateCollections, listCollections } from "../../src/server/collections/model";
import { createCollection } from "../../src/server/collections/service";
import { systemCollections } from "../../src/server/collections/system";
import { ApiError } from "../../src/server/errors";
import { ensureSettingsRow, invalidateSettings, loadSettings, saveSettings } from "../../src/server/settings";
import { signV4 } from "../../src/server/storage/s3";
import type { AppEnv, AuthRecord, Bindings } from "../../src/server/types";
import { VERSION } from "../../src/server/version";

const ROOT = resolve(import.meta.dir, "../..");
const enc = new TextEncoder(), dec = new TextDecoder();
const text = (b: Uint8Array | undefined) => dec.decode(b ?? new Uint8Array());
const json = <T = Record<string, unknown>>(b: Uint8Array | undefined) => JSON.parse(text(b)) as T;
/** data.jsonl back into the one document data.json held, which is what a format 1 archive carries */
function dumpOf(entries: Record<string, Uint8Array>) {
  const out = { format: "voidbase-backup", version: 1, created: "", tables: {} as Record<string, { columns: string[]; rows: unknown[][] }>, files: [] as string[] };
  let head = true, current: { columns: string[]; rows: unknown[][] } | null = null;
  for (const line of text(entries["data.jsonl"]).split("\n")) {
    if (!line) continue;
    const v = JSON.parse(line) as { created?: string; files?: string[]; table?: string; columns?: string[]; row?: unknown[] };
    if (head) { head = false; out.created = v.created ?? ""; out.files = v.files ?? []; continue; }
    if (typeof v.table === "string") { current = { columns: v.columns ?? [], rows: [] }; out.tables[v.table] = current; }
    else if (v.row) current?.rows.push(v.row);
  }
  return out;
}

/** an in-memory R2: the subset the server uses, bodies as streams, optionally with multipart uploads */
function fakeR2(opts: { multipart?: boolean } = {}) {
  const objects = new Map<string, { bytes: Uint8Array; uploaded: Date; contentType?: string }>();
  const meta = (key: string, o: { bytes: Uint8Array; uploaded: Date; contentType?: string }) => ({ key, size: o.bytes.length, uploaded: o.uploaded, etag: "", httpMetadata: { contentType: o.contentType } });
  const toBytes = async (v: unknown): Promise<Uint8Array> => (v instanceof Uint8Array ? v : typeof v === "string" ? enc.encode(v) : v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(await new Response(v as BodyInit).arrayBuffer()));
  const parts: { key: string; sizes: number[] }[] = [];
  let clock = 0;
  const bucket = {
    objects, parts,
    put: async (key: string, value: unknown, o?: { httpMetadata?: { contentType?: string } }) => { const bytes = await toBytes(value); objects.set(key, { bytes, uploaded: new Date(1_700_000_000_000 + clock++ * 1000), contentType: o?.httpMetadata?.contentType }); return meta(key, objects.get(key)!); },
    get: async (key: string) => { const o = objects.get(key); if (!o) return null; return { ...meta(key, o), body: new Blob([o.bytes as BlobPart]).stream(), arrayBuffer: async () => o.bytes.slice().buffer as ArrayBuffer, text: async () => dec.decode(o.bytes), json: async () => JSON.parse(dec.decode(o.bytes)) }; },
    head: async (key: string) => { const o = objects.get(key); return o ? meta(key, o) : null; },
    delete: async (keys: string | string[]) => { for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k); },
    list: async (o: { prefix?: string } = {}) => ({ objects: [...objects.entries()].filter(([k]) => k.startsWith(o.prefix ?? "")).map(([k, v]) => meta(k, v)), truncated: false, delimitedPrefixes: [] }),
    ...(opts.multipart ? {
      createMultipartUpload: async (key: string, o?: { httpMetadata?: { contentType?: string } }) => {
        const record = { key, sizes: [] as number[] }; parts.push(record);
        const chunks: Uint8Array[] = [];
        return {
          key, uploadId: "u1",
          uploadPart: async (n: number, value: Uint8Array) => { chunks[n - 1] = value.slice(); record.sizes[n - 1] = value.length; return { partNumber: n, etag: `e${n}` }; },
          complete: async () => bucket.put(key, new Uint8Array(await new Blob(chunks as BlobPart[]).arrayBuffer()), o),
          abort: async () => undefined,
        };
      },
    } : {}),
  };
  return bucket;
}
type Fake = ReturnType<typeof fakeR2>;

/** the schema the migrations create, the system collections, the settings row, then posts (with a file) and users */
async function instance(opts: { multipart?: boolean } = {}) {
  const sqlite = new Database(":memory:");
  for (const f of readdirSync(`${ROOT}/db/migrations`).filter((f) => f.endsWith(".sql")).sort()) for (const s of readFileSync(`${ROOT}/db/migrations/${f}`, "utf8").split("--> statement-breakpoint")) if (s.trim()) sqlite.exec(s);
  const db = d1(sqlite);
  invalidateCollections(); invalidateSettings();
  for (const c of systemCollections()) await insertCollection(db, c);
  await ensureSettingsRow(db);
  const posts = await createCollection(db, { name: "posts", type: "base", fields: [{ name: "title", type: "text" }, { name: "cover", type: "file", maxSelect: 1, maxSize: 5242880 }] });
  const users = await createCollection(db, { name: "users", type: "auth", fields: [{ name: "name", type: "text" }] });
  sqlite.run("INSERT INTO posts (id, title, cover) VALUES ('p1', 'Hello', 'cover_p1.png'), ('p2', 'Second', '')");
  sqlite.run("INSERT INTO users (id, password, tokenKey, email, name) VALUES ('u1', 'hash', 'tk', 'u@example.com', 'Una')");
  sqlite.run("INSERT INTO _superusers (id, password, tokenKey, email) VALUES ('s1', 'hash', 'tks', 'admin@example.com')");
  sqlite.run("INSERT INTO _authOrigins (id, collectionRef, recordRef, fingerprint) VALUES ('o1', ?, 'u1', 'fp')", [users.id]);
  const storage = fakeR2(opts);
  await storage.put(`${posts.id}/p1/cover_p1.png`, new Uint8Array(70_000).map((_, i) => i % 251), { httpMetadata: { contentType: "image/png" } });
  await storage.put(`${users.id}/u1/avatar.png`, enc.encode("avatar bytes"));
  await storage.put("someone_else/x/stray.bin", enc.encode("not a collection's file"));
  const env = { DB: db, STORAGE: storage as unknown as R2Bucket } as Bindings;
  return { sqlite, db, env, storage, posts, users };
}
type Instance = Awaited<ReturnType<typeof instance>>;

/** the archive as one buffer through a buffering sink, the way a storage without multipart takes it */
async function archive(env: Bindings, kind: "full" | "data") {
  const held: Uint8Array[] = [];
  const manifest = await writeArchive(env, kind, { write: async (c) => { held.push(c); }, finish: async () => undefined, abort: async () => undefined, bytes: () => null });
  const bytes = new Uint8Array(await new Blob(held as BlobPart[]).arrayBuffer());
  return { manifest, bytes, entries: unzipSync(bytes) };
}
const archiveOf = (storage: Fake, name: string) => storage.objects.get(`__backups__/${name}`)!.bytes;
const metaOf = (storage: Fake, name: string) => json(storage.objects.get(`__backups__/${name}.meta.json`)?.bytes);

describe("sha256, incrementally", () => {
  test("matches WebCrypto whatever the chunking", async () => {
    for (const size of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 1000, 70_001]) {
      const data = new Uint8Array(size).map((_, i) => (i * 7 + 3) % 256);
      const expected = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data))).map((b) => b.toString(16).padStart(2, "0")).join("");
      expect(sha256Hex(data)).toBe(expected);
      const h = new Sha256();
      for (let i = 0; i < size;) { const n = 1 + ((i * 13) % 37); h.update(data.subarray(i, i + n)); i += n; }
      expect(h.hex()).toBe(expected);
    }
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("the archives", () => {
  test("a full archive: every table, every file, the settings redacted, the schema, and a manifest that adds up", async () => {
    const it = await instance();
    await saveSettings(it.db, { ...(await loadSettings(it.db)), smtp: { ...(await loadSettings(it.db)).smtp, password: "hunter2" }, meta: { ...(await loadSettings(it.db)).meta, appName: "Archive Co" } });
    const { manifest, entries } = await archive(it.env, "full");
    expect(Object.keys(entries).sort()).toEqual(["header.json", "collections.json", "data.jsonl", "manifest.json", "settings.json", `storage/${it.posts.id}/p1/cover_p1.png`, "storage/someone_else/x/stray.bin", `storage/${it.users.id}/u1/avatar.png`].sort());
    expect(json(entries["header.json"])).toEqual({ format: "voidbase-backup/2", kind: "full", voidbase: VERSION, created: manifest.created, tables: manifest.tables });
    expect(manifest.tables[0]).toBe("_collections"); // the streaming restore rebuilds the schema before any row lands
    const settings = json(entries["settings.json"]);
    expect((settings.meta as { appName: string }).appName).toBe("Archive Co");
    expect("password" in (settings.smtp as object)).toBe(false);
    expect("secret" in (settings.s3 as object)).toBe(false);
    expect("secret" in ((settings.backups as { s3: object }).s3)).toBe(false);
    const collections = json<{ name: string; system: boolean }[]>(entries["collections.json"]);
    expect(collections.map((c) => c.name).sort()).toEqual(["_authOrigins", "_externalAuths", "_mfas", "_otps", "_superusers", "posts", "users"]);
    const dump = dumpOf(entries);
    expect(JSON.parse(text(entries["data.jsonl"]).split("\n")[0]!).format).toBe("voidbase-backup");
    expect(Object.keys(dump.tables)).toEqual(manifest.tables);
    for (const t of ["_collections", "_params", "_superusers", "_authOrigins", "posts", "users"]) expect(manifest.tables).toContain(t);
    expect(manifest.tables).not.toContain("_changes");
    expect(dump.tables.posts!.rows.length).toBe(2);
    expect(dump.files.length).toBe(3);
    expect(entries[`storage/${it.posts.id}/p1/cover_p1.png`]!.length).toBe(70_000);
    // the manifest
    const m = json<Manifest>(entries["manifest.json"]);
    expect(m).toEqual(manifest);
    expect([m.format, m.kind, m.voidbase]).toEqual(["voidbase-backup/2", "full", VERSION]);
    expect(m.files).toEqual({ count: 3, bytes: 70_000 + 12 + 23 });
    expect(Object.keys(m.entries).sort()).toEqual(Object.keys(entries).filter((n) => n !== "manifest.json").sort());
    for (const [name, hash] of Object.entries(m.entries)) expect(hash).toBe(sha256Hex(entries[name]!));
    expect(m.checksum).toBe(sha256Hex(Object.keys(m.entries).sort().map((n) => `${n}\n${m.entries[n]}\n`).join("")));
    expect(m.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // reads back verified
    const v = await verifyArchive(new Blob([(await archive(it.env, "full")).bytes as BlobPart]).stream());
    expect(v.verified).toBe(true);
    expect([v.kind, v.voidbase, v.entries, v.corrupted, v.missing]).toEqual(["full", VERSION, 7, [], []]);
    it.sqlite.close();
  });

  test("a data archive: the non-system collections' rows and files, their definitions, nothing of the account", async () => {
    const it = await instance();
    const { manifest, entries } = await archive(it.env, "data");
    expect(Object.keys(entries).sort()).toEqual(["header.json", "collections.json", "data.jsonl", "manifest.json", `storage/${it.posts.id}/p1/cover_p1.png`, `storage/${it.users.id}/u1/avatar.png`].sort());
    expect(manifest.kind).toBe("data");
    expect(manifest.tables).toEqual(["posts", "users"]);
    expect(manifest.files).toEqual({ count: 2, bytes: 70_012 });
    const dump = dumpOf(entries);
    expect(Object.keys(dump.tables)).toEqual(["posts", "users"]);
    expect(dump.files).not.toContain("someone_else/x/stray.bin");
    expect(json<{ name: string }[]>(entries["collections.json"]).map((c) => c.name)).toEqual(["posts", "users"]);
    expect(text(entries["data.jsonl"])).not.toContain("admin@example.com");
    expect(text(entries["data.jsonl"])).not.toContain("tks");
    it.sqlite.close();
  });

  test("a schema archive: the non-system definitions, views included, and a manifest; no rows, no files", async () => {
    const it = await instance();
    await createCollection(it.db, { name: "recent", type: "view", fields: [], viewQuery: "SELECT id, title FROM posts" });
    const { manifest, entries } = await archive(it.env, "schema");
    expect(Object.keys(entries).sort()).toEqual(["collections.json", "header.json", "manifest.json"]);
    expect(manifest.kind).toBe("schema");
    expect(manifest.tables).toEqual([]);
    expect(manifest.files).toEqual({ count: 0, bytes: 0 });
    expect(json<{ name: string; type: string }[]>(entries["collections.json"]).map((c) => `${c.name}:${c.type}`).sort()).toEqual(["posts:base", "recent:view", "users:auth"]);
    expect(text(entries["collections.json"])).not.toContain("cover_p1.png"); // definitions, not rows
    it.sqlite.close();
  });

  test("verification catches a corrupted entry, a missing one, and an archive without a manifest", async () => {
    const it = await instance();
    const { bytes, entries } = await archive(it.env, "full");
    const stored = entries[`storage/${it.posts.id}/p1/cover_p1.png`]!;
    // the file is stored uncompressed: find its bytes inside the zip and flip one
    const marker = stored.subarray(1000, 1040);
    let at = -1;
    outer: for (let i = 0; i + marker.length <= bytes.length; i++) { for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker[j]) continue outer; at = i; break; }
    expect(at).toBeGreaterThan(0);
    const bad = bytes.slice(); bad[at + 5] = (bad[at + 5]! + 1) & 0xff;
    const v = await verifyArchive(bad);
    expect(v.verified).toBe(false);
    expect(v.corrupted).toEqual([`storage/${it.posts.id}/p1/cover_p1.png`]);
    expect(v.error).toContain("corrupted");
    expect(v.kind).toBe("full");
    // an entry the manifest lists that is gone
    const without = unzipSync(bytes); delete without["settings.json"];
    const v2 = await verifyArchive(zipSync(without));
    expect(v2.verified).toBe(false);
    expect(v2.missing).toEqual(["settings.json"]);
    // an archive from before the manifest
    const legacy = await verifyArchive(zipSync({ "data.json": enc.encode(JSON.stringify({ format: "voidbase-backup", version: 1, tables: {}, files: [] })) }));
    expect([legacy.kind, legacy.verified, legacy.voidbase, legacy.error]).toEqual(["legacy", false, null, undefined]);
    const notOne = await verifyArchive(zipSync({ "readme.txt": enc.encode("hello") }));
    expect([notOne.kind, notOne.verified, notOne.error]).toEqual(["legacy", false, "not a voidbase backup archive"]);
    it.sqlite.close();
  });

  test("createBackup writes, reads back, verifies, and keeps the outcome in the sidecar; multipart when the storage offers it", async () => {
    for (const multipart of [false, true]) {
      const it = await instance({ multipart });
      const r = await createBackup(it.env, "pb_backup_one.zip", { kind: "full" });
      expect([r.name, r.kind, r.verified, r.offsite]).toEqual(["pb_backup_one.zip", "full", true, undefined]);
      const meta = metaOf(it.storage, "pb_backup_one.zip");
      expect([meta.kind, meta.verified, meta.voidbase, meta.checksum]).toEqual(["full", true, VERSION, r.manifest.checksum]);
      expect(meta.offsite).toBeUndefined();
      const v = await verifyArchive(archiveOf(it.storage, "pb_backup_one.zip"));
      expect(v.verified).toBe(true);
      if (multipart) { expect(it.storage.parts.map((p) => p.key)).toEqual(["__backups__/pb_backup_one.zip"]); expect(it.storage.parts[0]!.sizes.length).toBe(1); }
      else expect(it.storage.parts).toEqual([]);
      expect((await createBackup(it.env, "", { kind: "data" })).name).toMatch(/^pb_backup_acme_\d{14}\.zip$/);
      it.sqlite.close();
    }
    expect(BUFFERED_MAX).toBe(256 * 1024 * 1024);
  });
});

describe("restore", () => {
  test("a full archive puts back the rows, the files, the settings and the schema", async () => {
    const it = await instance();
    await createBackup(it.env, "pb_backup_full.zip", { kind: "full" });
    // drift: a row, a settings change, a lost file, an extra collection, a changed field
    it.sqlite.run("INSERT INTO posts (id, title, cover) VALUES ('p3', 'After', '')");
    await saveSettings(it.db, { ...(await loadSettings(it.db)), meta: { ...(await loadSettings(it.db)).meta, appName: "Drifted" } });
    await it.storage.delete(`${it.posts.id}/p1/cover_p1.png`);
    await it.storage.put(`${it.posts.id}/p3/new.png`, enc.encode("new"));
    await createCollection(it.db, { name: "extra", type: "base", fields: [{ name: "x", type: "text" }] });
    const plan = await restoreBackup(it.env, "pb_backup_full.zip");
    expect([plan.kind, plan.voidbase, plan.settings, plan.restored.sort(), plan.skipped, plan.created]).toEqual(["full", VERSION, true, ["posts", "users"], [], []]);
    expect(it.sqlite.query("SELECT id FROM posts ORDER BY id").all()).toEqual([{ id: "p1" }, { id: "p2" }]);
    expect((await loadSettings(it.db)).meta.appName).toBe("Acme");
    expect((await listCollections(it.db)).map((c) => c.name)).not.toContain("extra");
    expect(it.sqlite.query("SELECT name FROM sqlite_master WHERE name = 'extra'").all()).toEqual([]);
    expect(it.storage.objects.has(`${it.posts.id}/p1/cover_p1.png`)).toBe(true);
    expect(it.storage.objects.has(`${it.posts.id}/p3/new.png`)).toBe(false);
    expect(it.storage.objects.has("__backups__/pb_backup_full.zip")).toBe(true);
    expect(metaOf(it.storage, "pb_backup_full.zip").restore).toMatchObject({ kind: "full", restored: ["posts", "users"], skipped: [] });
    it.sqlite.close();
  });

  test("a data archive lands on the existing schema; a collection the instance lacks is skipped, or created on request", async () => {
    const source = await instance();
    await createCollection(source.db, { name: "tags", type: "base", fields: [{ name: "label", type: "text" }] });
    source.sqlite.run("INSERT INTO tags (id, label) VALUES ('t1', 'news')");
    await createBackup(source.env, "pb_backup_data.zip", { kind: "data" });
    const bytes = archiveOf(source.storage, "pb_backup_data.zip");
    // a target with the same posts and users, its own superuser and settings, no tags
    const target = await instance();
    target.sqlite.run("DELETE FROM posts; INSERT INTO posts (id, title, cover) VALUES ('p9', 'Target', '')");
    target.sqlite.run("UPDATE _superusers SET email = 'other@example.com'");
    await target.storage.put(`${target.posts.id}/p9/t.png`, enc.encode("t"));
    await target.storage.put("__backups__/pb_backup_data.zip", bytes);
    const plan = await restoreBackup(target.env, "pb_backup_data.zip");
    expect(plan.kind).toBe("data");
    expect(plan.restored.sort()).toEqual(["posts", "users"]);
    expect(plan.created).toEqual([]);
    expect(plan.skipped).toEqual([{ collection: "tags", reason: "the instance has no such collection (pass createMissing to create it from the archive's definition)" }]);
    expect(target.sqlite.query("SELECT id, title FROM posts ORDER BY id").all()).toEqual([{ id: "p1", title: "Hello" }, { id: "p2", title: "Second" }]);
    expect(target.sqlite.query("SELECT email FROM _superusers").all()).toEqual([{ email: "other@example.com" }]);
    expect(target.sqlite.query("SELECT name FROM sqlite_master WHERE name = 'tags'").all()).toEqual([]);
    expect(target.storage.objects.has(`${target.posts.id}/p9/t.png`)).toBe(false);
    expect(target.storage.objects.get(`${target.posts.id}/p1/cover_p1.png`)?.bytes.length).toBe(70_000);
    expect(target.storage.objects.has("someone_else/x/stray.bin")).toBe(true);
    expect(metaOf(target.storage, "pb_backup_data.zip").restore).toMatchObject({ kind: "data", skipped: [{ collection: "tags" }] });
    // with createMissing the definition in the archive is used
    const plan2 = await restoreBackup(target.env, "pb_backup_data.zip", { createMissing: true });
    expect([plan2.created, plan2.skipped, plan2.restored.sort()]).toEqual([["tags"], [], ["posts", "tags", "users"]]);
    expect(target.sqlite.query("SELECT label FROM tags").all()).toEqual([{ label: "news" }]);
    expect((await listCollections(target.db)).find((c) => c.name === "tags")?.type).toBe("base");
    source.sqlite.close(); target.sqlite.close();
  });

  test("a schema archive creates the collections the instance lacks and updates the ones it has; the rows stay", async () => {
    const source = await instance();
    await createCollection(source.db, { name: "tags", type: "base", fields: [{ name: "label", type: "text" }] });
    source.sqlite.run("INSERT INTO tags (id, label) VALUES ('t1', 'news')");
    await createBackup(source.env, "pb_backup_schema.zip", { kind: "schema" });
    const bytes = archiveOf(source.storage, "pb_backup_schema.zip");
    expect(openArchive(bytes).kind).toBe("schema");
    // a fresh target: the same posts (with a row of its own) and users, no tags
    const target = await instance();
    target.sqlite.run("DELETE FROM posts; INSERT INTO posts (id, title, cover) VALUES ('p9', 'Target', '')");
    await target.storage.put("__backups__/pb_backup_schema.zip", bytes);
    const plan = await restoreBackup(target.env, "pb_backup_schema.zip");
    expect(plan.kind).toBe("schema");
    expect(plan.created).toEqual(["tags"]);
    expect(plan.restored.sort()).toEqual(["posts", "tags", "users"]);
    expect(plan.skipped).toEqual([]);
    expect(plan.settings).toBe(false);
    expect((await listCollections(target.db)).find((c) => c.name === "tags")?.type).toBe("base");
    expect(target.sqlite.query("SELECT id, title FROM posts ORDER BY id").all()).toEqual([{ id: "p9", title: "Target" }]);
    expect(target.sqlite.query("SELECT count(*) AS n FROM tags").get()).toEqual({ n: 0 });
    expect(target.sqlite.query("SELECT email FROM _superusers").all()).toEqual([{ email: "admin@example.com" }]);
    expect(metaOf(target.storage, "pb_backup_schema.zip").restore).toMatchObject({ kind: "schema", created: ["tags"] });
    source.sqlite.close(); target.sqlite.close();
  });

  test("refuses an archive written by a newer voidbase, with the reason; a legacy archive restores as before", async () => {
    expect(newerThanInstance("1.2.0", "1.1.9")).toBe(true);
    expect(newerThanInstance("2.0.0-beta.1", "1.9.0")).toBe(true);
    expect(newerThanInstance("1.1.5", "1.1.0")).toBe(false);
    expect(newerThanInstance("0.9.0-beta.30", "0.9.0-beta.29")).toBe(false);
    expect(newerThanInstance("0.8.0", "0.9.0")).toBe(false);
    const it = await instance();
    const { entries } = await archive(it.env, "full");
    const m = json<Manifest>(entries["manifest.json"]);
    const [major, minor] = VERSION.split(".").map(Number);
    entries["manifest.json"] = enc.encode(JSON.stringify({ ...m, voidbase: `${major}.${minor! + 1}.0` }));
    expect(() => openArchive(zipSync(entries))).toThrow(new RegExp(`written by voidbase ${major}\\.${minor! + 1}\\.0, newer than this instance \\(${VERSION.replace(/\./g, "\\.")}\\)`));
    expect(() => openArchive(zipSync({ "readme.txt": enc.encode("x") }))).toThrow(/not a voidbase backup archive/);
    expect(() => openArchive(enc.encode("not a zip"))).toThrow(/missing or invalid backup file/);
    // a legacy archive (data.json and storage/ only): today's restore, untouched
    const dump = dumpOf(entries);
    const legacy = zipSync({ "data.json": enc.encode(JSON.stringify(dump)), ...Object.fromEntries(Object.entries(entries).filter(([n]) => n.startsWith("storage/"))) });
    await it.storage.put("__backups__/old.zip", legacy);
    it.sqlite.run("INSERT INTO posts (id, title, cover) VALUES ('p3', 'After', '')");
    const opened = openArchive(legacy);
    expect(opened.kind).toBe("legacy");
    expect((await planRestore(it.db, opened)).restored.sort()).toEqual(["posts", "users"]);
    const plan = await restoreBackup(it.env, "old.zip");
    expect([plan.kind, plan.voidbase, plan.settings]).toEqual(["legacy", null, false]);
    expect(it.sqlite.query("SELECT id FROM posts ORDER BY id").all()).toEqual([{ id: "p1" }, { id: "p2" }]);
    it.sqlite.close();
  });
});

describe("restore reads the archive as a stream", () => {
  test("an archive from before header.json still restores: data.json, read whole", async () => {
    const source = await instance();
    await createCollection(source.db, { name: "tags", type: "base", fields: [{ name: "label", type: "text" }] });
    source.sqlite.run("INSERT INTO tags (id, label) VALUES ('t1', 'news')");
    await createBackup(source.env, "pb_backup_v1.zip", { kind: "data" });
    // the same archive as a format 1 one: no header.json, the rows as the one data.json document they used to be
    const entries = unzipSync(archiveOf(source.storage, "pb_backup_v1.zip"));
    const m = json<Manifest>(entries["manifest.json"]);
    const old: Record<string, Uint8Array> = { "data.json": enc.encode(JSON.stringify(dumpOf(entries))), "manifest.json": enc.encode(JSON.stringify({ ...m, format: "voidbase-backup" })) };
    for (const [n, b] of Object.entries(entries)) if (n !== "header.json" && n !== "data.jsonl" && n !== "manifest.json") old[n] = b;
    const bytes = zipSync(old);
    expect(openArchive(bytes).kind).toBe("data");
    const target = await instance();
    target.sqlite.run("DELETE FROM posts; INSERT INTO posts (id, title, cover) VALUES ('p9', 'Target', '')");
    await target.storage.put("__backups__/pb_backup_v1.zip", bytes);
    const plan = await restoreBackup(target.env, "pb_backup_v1.zip", { createMissing: true });
    expect([plan.kind, plan.voidbase, plan.created]).toEqual(["data", VERSION, ["tags"]]);
    expect(plan.restored.sort()).toEqual(["posts", "tags", "users"]);
    expect(target.sqlite.query("SELECT id, title FROM posts ORDER BY id").all()).toEqual([{ id: "p1", title: "Hello" }, { id: "p2", title: "Second" }]);
    expect(target.sqlite.query("SELECT label FROM tags").all()).toEqual([{ label: "news" }]);
    expect(target.storage.objects.get(`${target.posts.id}/p1/cover_p1.png`)?.bytes.length).toBe(70_000);
    expect(metaOf(target.storage, "pb_backup_v1.zip").restore).toMatchObject({ kind: "data", restored: ["posts", "tags", "users"] });
    source.sqlite.close(); target.sqlite.close();
  });

  test("a truncated archive says so and stops; the instance holds what had been loaded until a good one lands", async () => {
    const source = await instance();
    await createBackup(source.env, "pb_backup_cut.zip", { kind: "data" });
    const whole = archiveOf(source.storage, "pb_backup_cut.zip");
    const target = await instance();
    target.sqlite.run("DELETE FROM posts; INSERT INTO posts (id, title, cover) VALUES ('p9', 'Target', '')");
    await target.storage.put("__backups__/pb_backup_cut.zip", whole.slice(0, Math.floor(whole.length * 0.6)));
    await expect(restoreBackup(target.env, "pb_backup_cut.zip")).rejects.toThrow(/could not be read to the end[\s\S]*the restore stopped part way/);
    // nothing is recorded for a restore that did not finish, and the lock is released either way
    expect(target.storage.objects.has("__backups__/pb_backup_cut.zip.meta.json")).toBe(false);
    expect(target.sqlite.query("SELECT value FROM _params WHERE id = '__activeBackup__'").all()).toEqual([]);
    // it is a streaming restore, so what had already been loaded stays loaded: the rows are the source's and the
    // file the truncation cut off is missing. Restoring the whole archive is what puts it right.
    expect(target.sqlite.query("SELECT id FROM posts ORDER BY id").all()).toEqual([{ id: "p1" }, { id: "p2" }]);
    await target.storage.put("__backups__/pb_backup_cut.zip", whole);
    const plan = await restoreBackup(target.env, "pb_backup_cut.zip");
    expect(plan.restored.sort()).toEqual(["posts", "users"]);
    expect(target.storage.objects.get(`${target.posts.id}/p1/cover_p1.png`)?.bytes.length).toBe(70_000);
    source.sqlite.close(); target.sqlite.close();
  });

  // ~300 MB of rows, generated straight into the zip stream and never held in an array. The payload is drawn from a
  // small pool of tokens, so it deflates about 33:1 and the archive itself is a few MB: what is measured is that
  // the restore never holds the uncompressed side of it.
  const BIG_ROWS = 32_000, BIG_PAYLOAD = 10_000, BIG_BLOB = 2 * 1024 * 1024;
  /** the peak RSS the restore may add. Measured at 36-42 MB for these 306 MB of rows (the test logs what it saw);
   * the budget is a wide multiple of that, because the point is that it does not grow with the archive - a restore
   * that held the rows would be several hundred MB over it. */
  const BIG_BUDGET = 220 * 1024 * 1024;
  const POOL = Array.from({ length: 48 }, (_, i) => (Math.imul(i + 1, 2654435761) >>> 0).toString(36).padStart(7, "0").repeat(4).slice(0, 24));
  const payload = (seed: number) => {
    let s = "", x = (Math.imul(seed + 1, 2654435761) >>> 0) || 7;
    while (s.length < BIG_PAYLOAD) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; s += `${POOL[x % 48]} `; }
    return s.slice(0, BIG_PAYLOAD);
  };

  /** a format 2 data archive for `posts`, written the way the server writes one, its rows generated as it goes */
  function bigArchive(columns: string[], collections: Uint8Array, blob: Uint8Array, storageKey: string) {
    let parts: Uint8Array[] = [];
    let raw = 0;
    const zip = new Zip((err, chunk) => { if (err) throw err; parts.push(chunk); });
    const hashes: Record<string, string> = {};
    const created = "2026-09-11 00:00:00.000Z";
    const add = (name: string, compress: boolean, feed: (push: (b: Uint8Array) => void) => void) => {
      const f = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
      zip.add(f);
      const h = new Sha256();
      feed((b) => { h.update(b); f.push(b); });
      f.push(new Uint8Array(0), true);
      hashes[name] = h.hex();
    };
    const whole = (name: string, b: Uint8Array, compress = true) => add(name, compress, (push) => push(b));
    whole("header.json", enc.encode(JSON.stringify({ format: "voidbase-backup/2", kind: "data", voidbase: VERSION, created, tables: ["posts"] })));
    whole("collections.json", collections);
    const id = columns.indexOf("id"), title = columns.indexOf("title");
    add("data.jsonl", true, (push) => {
      let buf = `${JSON.stringify({ format: "voidbase-backup", version: 2, created, files: [storageKey] })}\n${JSON.stringify({ table: "posts", columns })}\n`;
      const send = () => { const b = enc.encode(buf); raw += b.length; push(b); buf = ""; };
      for (let i = 0; i < BIG_ROWS; i++) {
        const row: unknown[] = columns.map(() => "");
        row[id] = `big${i}`; row[title] = payload(i);
        buf += `${JSON.stringify({ row })}\n`;
        if (buf.length >= 262_144) send();
      }
      send();
    });
    whole(`storage/${storageKey}`, blob, false);
    const manifest: Manifest = { format: "voidbase-backup/2", kind: "data", voidbase: VERSION, created, tables: ["posts"], files: { count: 1, bytes: blob.length }, checksum: sha256Hex(Object.keys(hashes).sort().map((n) => `${n}\n${hashes[n]}\n`).join("")), entries: { ...hashes } };
    whole("manifest.json", enc.encode(JSON.stringify(manifest)));
    zip.end();
    let size = 0;
    for (const p of parts) size += p.length;
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { bytes.set(p, at); at += p.length; }
    parts = [];
    return { bytes, raw };
  }

  /** a D1 that counts the rows the restore hands it instead of storing them: what is measured here is the
   * restore's own footprint, not an in-memory SQLite holding 300 MB */
  function countingDb(real: D1Database) {
    const seen = { rows: 0, bytes: 0 };
    const sink = {
      bind: (...a: unknown[]) => { seen.rows++; for (const v of a) if (typeof v === "string") seen.bytes += v.length; return sink; },
      run: async () => ({ results: [], success: true }), all: async () => ({ results: [], success: true }), first: async () => null, raw: async () => [],
    } as unknown as D1PreparedStatement;
    const db = {
      prepare: (sql: string) => (sql.startsWith("INSERT OR REPLACE INTO `posts`") ? sink : real.prepare(sql)),
      batch: async (st: D1PreparedStatement[]) => (st[0] === sink ? [] : real.batch(st)),
    } as unknown as D1Database;
    return { db, seen };
  }

  /** the process's peak resident size while the restore runs, sampled from outside it (the restore itself never
   * lets a timer run). Falls back to 0 where /proc is not readable, leaving the before/after readings to decide. */
  function samplePeakRSS(): () => Promise<number> {
    let child: ReturnType<typeof Bun.spawn> | null = null;
    try { child = Bun.spawn(["sh", "-c", `while :; do read _ r _ < /proc/${process.pid}/statm; echo "$r"; sleep 0.02; done`], { stdout: "pipe", stderr: "ignore" }); } catch { child = null; }
    return async () => {
      if (!child) return 0;
      child.kill();
      const out = await new Response(child.stdout as ReadableStream).text().catch(() => "");
      let peak = 0;
      for (const line of out.split("\n")) { const n = Number(line.trim()); if (Number.isFinite(n) && n > peak) peak = n; }
      return peak * 4096;
    };
  }

  test("a 300 MB archive restores in a pass whose peak does not grow with it", async () => {
    const it = await instance();
    const base = await archive(it.env, "data");
    const columns = (JSON.parse(text(base.entries["data.jsonl"]).split("\n")[1]!) as { columns: string[] }).columns;
    const storageKey = `${it.posts.id}/big/blob.bin`;
    const blob = new Uint8Array(BIG_BLOB).map((_, i) => i % 251);
    const { bytes, raw } = bigArchive(columns, base.entries["collections.json"]!, blob, storageKey);
    await it.storage.put("__backups__/big.zip", bytes);
    expect(raw).toBeGreaterThan(300 * 1000 * 1000);
    const { db, seen } = countingDb(it.db);

    Bun.gc(true);
    const before = process.memoryUsage().rss;
    // The restore never yields to the timer queue (every await it makes is already resolved), so an in-process
    // setInterval would never fire: the peak is sampled from outside, and process.memoryUsage() around the call is
    // what the assertion falls back to where /proc is not readable.
    const sampler = samplePeakRSS();
    let plan: Awaited<ReturnType<typeof restoreBackup>>;
    try { plan = await restoreBackup({ ...it.env, DB: db } as Bindings, "big.zip"); } finally { /* measured below */ }
    const after = process.memoryUsage().rss;
    const peak = Math.max(before, after, await sampler());
    const growth = peak - before;
    const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
    console.log(`big archive: ${mb(raw)} of rows in a ${mb(bytes.length)} zip; rss ${mb(before)} -> peak ${mb(peak)} (+${mb(growth)}, budget ${mb(BIG_BUDGET)})`);

    expect(plan.restored).toEqual(["posts"]);
    expect(seen.rows).toBe(BIG_ROWS);
    expect(seen.bytes).toBeGreaterThanOrEqual(BIG_ROWS * BIG_PAYLOAD);
    expect(it.storage.objects.get(storageKey)?.bytes.length).toBe(BIG_BLOB);
    expect(it.storage.objects.has(`${it.posts.id}/p1/cover_p1.png`)).toBe(false); // the archive's files replace the instance's
    expect(metaOf(it.storage, "big.zip").restore).toMatchObject({ kind: "data", restored: ["posts"] });
    expect(growth).toBeLessThan(BIG_BUDGET);
    it.sqlite.close();
  }, 180_000);
});

describe("the schedule", () => {
  test("retention deletes the oldest automatic archives and their sidecars, never the named ones", async () => {
    const it = await instance();
    for (const n of ["@auto_pb_backup_a_1.zip", "@auto_pb_backup_a_2.zip", "@auto_pb_backup_a_3.zip", "@auto_pb_backup_a_4.zip"]) { await it.storage.put(`__backups__/${n}`, enc.encode("zip")); await it.storage.put(`__backups__/${n}.meta.json`, "{}"); }
    await it.storage.put("__backups__/pb_backup_named.zip", enc.encode("zip"));
    expect(await pruneAutoBackups(it.env, 2)).toEqual(["@auto_pb_backup_a_2.zip", "@auto_pb_backup_a_1.zip"]);
    expect([...it.storage.objects.keys()].filter((k) => k.startsWith("__backups__/")).sort()).toEqual(["__backups__/@auto_pb_backup_a_3.zip", "__backups__/@auto_pb_backup_a_3.zip.meta.json", "__backups__/@auto_pb_backup_a_4.zip", "__backups__/@auto_pb_backup_a_4.zip.meta.json", "__backups__/pb_backup_named.zip"]);
    it.sqlite.close();
  });

  test("the scheduled backup takes VOIDBASE_BACKUP_KIND and keeps VOIDBASE_BACKUP_KEEP after a verified write", async () => {
    const it = await instance();
    for (const n of ["@auto_pb_backup_old_1.zip", "@auto_pb_backup_old_2.zip"]) await it.storage.put(`__backups__/${n}`, enc.encode("zip"));
    const env = { ...it.env, VOIDBASE_BACKUP_KIND: "data", VOIDBASE_BACKUP_KEEP: "2" } as Bindings;
    const r = await runScheduledBackup(env, "@auto_pb_backup_new.zip");
    expect([r?.kind, r?.verified]).toEqual(["data", true]);
    expect([...it.storage.objects.keys()].filter((k) => k.startsWith("__backups__/") && !k.endsWith(".meta.json")).sort()).toEqual(["__backups__/@auto_pb_backup_new.zip", "__backups__/@auto_pb_backup_old_2.zip"]);
    // no knob: settings.backups.cronMaxKeep (3 by default) as today; a kind knob that means nothing is the default
    const r2 = await runScheduledBackup({ ...it.env, VOIDBASE_BACKUP_KIND: "weekly" } as Bindings, "@auto_pb_backup_newer.zip");
    expect(r2?.kind).toBe("full");
    expect([...it.storage.objects.keys()].filter((k) => k.startsWith("__backups__/@auto") && !k.endsWith(".meta.json")).length).toBe(3);
    it.sqlite.close();
  });
});

describe("the off-site copy", () => {
  const AWS = { accessKey: "AKIAIOSFODNN7EXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" };
  const AT = new Date("2013-05-24T00:00:00Z");
  afterEach(() => { (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.(); });

  test("the SigV4 signer reproduces AWS's published PUT and GET examples", async () => {
    // docs: "Examples: Signature Calculations in AWS Signature Version 4", examplebucket, 2013-05-24
    const put = await signV4({ method: "PUT", url: new URL("https://examplebucket.s3.amazonaws.com/test$file.text"), headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" }, payloadHash: "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072" }, AWS, AT);
    expect(put.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
    expect(put["x-amz-date"]).toBe("20130524T000000Z");
    expect(sha256Hex("Welcome to Amazon S3.")).toBe("44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
    const get = await signV4({ method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"), headers: { range: "bytes=0-9" }, payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }, AWS, AT);
    expect(get.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  });

  test("the archive's PUT: path-style at the bucket's root, unsigned payload for a stream, the body's hash for bytes", async () => {
    const cfg = { ...AWS, endpoint: "https://acct.r2.cloudflarestorage.com", bucket: "vb-offsite" };
    const stream = await offsiteRequest(cfg, "pb_backup_x.zip", 1234, { now: AT });
    expect(stream.url.toString()).toBe("https://acct.r2.cloudflarestorage.com/vb-offsite/pb_backup_x.zip");
    expect(stream.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(stream.headers["content-length"]).toBe("1234");
    expect(stream.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect((await offsiteRequest(cfg, "pb_backup_x.zip", 1234, { now: AT })).headers.authorization).toBe(stream.headers.authorization);
    const hashed = await offsiteRequest({ ...cfg, endpoint: "s3.eu-central-003.backblazeb2.com" }, "a b.zip", 3, { now: AT, payloadHash: sha256Hex("zip") });
    expect(hashed.url.toString()).toBe("https://s3.eu-central-003.backblazeb2.com/vb-offsite/a%20b.zip");
    expect(hashed.headers["x-amz-content-sha256"]).toBe(sha256Hex("zip"));
    expect(hashed.headers.authorization).not.toBe(stream.headers.authorization);
  });

  test("the knobs: all four or nothing, the region defaulting to auto, the request's env before the runtime's", () => {
    const base = { VOIDBASE_BACKUP_S3_ENDPOINT: "https://x.example", VOIDBASE_BACKUP_S3_BUCKET: "b", VOIDBASE_BACKUP_S3_ACCESS_KEY_ID: "k", VOIDBASE_BACKUP_S3_SECRET_ACCESS_KEY: "s" };
    expect(offsiteConfig(base as unknown as Bindings)).toEqual({ endpoint: "https://x.example", bucket: "b", accessKey: "k", secret: "s", region: "auto" });
    expect(offsiteConfig({ ...base, VOIDBASE_BACKUP_S3_REGION: "us-west-004" } as unknown as Bindings)?.region).toBe("us-west-004");
    expect(offsiteConfig({ ...base, VOIDBASE_BACKUP_S3_BUCKET: "" } as unknown as Bindings)).toBeNull();
    expect(offsiteConfig({} as Bindings)).toBeNull();
    process.env.VOIDBASE_BACKUP_S3_BUCKET = "from-runtime";
    try { expect(offsiteConfig({ ...base, VOIDBASE_BACKUP_S3_BUCKET: undefined } as unknown as Bindings)?.bucket).toBe("from-runtime"); expect(offsiteConfig(base as unknown as Bindings)?.bucket).toBe("b"); }
    finally { delete process.env.VOIDBASE_BACKUP_S3_BUCKET; }
  });

  test("a successful copy marks the backup offsite; a failed one is reported and never fails the backup", async () => {
    const it = await instance();
    const env = { ...it.env, VOIDBASE_BACKUP_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", VOIDBASE_BACKUP_S3_BUCKET: "vb-offsite", VOIDBASE_BACKUP_S3_ACCESS_KEY_ID: "k", VOIDBASE_BACKUP_S3_SECRET_ACCESS_KEY: "s" } as Bindings;
    const calls: { url: string; method: string; headers: Record<string, string>; size: number }[] = [];
    let status = 200;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const body = init?.body as Uint8Array | ReadableStream;
      const size = body instanceof Uint8Array ? body.length : new Uint8Array(await new Response(body).arrayBuffer()).length;
      calls.push({ url: String(input), method: String(init?.method), headers: { ...(init?.headers as Record<string, string>) }, size });
      return new Response(status === 200 ? "" : "<Error><Code>AccessDenied</Code></Error>", { status });
    });
    const ok = await createBackup(env, "pb_backup_copied.zip", { kind: "full" });
    expect([ok.verified, ok.offsite, ok.offsiteError]).toEqual([true, true, undefined]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://acct.r2.cloudflarestorage.com/vb-offsite/pb_backup_copied.zip");
    expect(calls[0]!.size).toBe(archiveOf(it.storage, "pb_backup_copied.zip").length);
    expect(calls[0]!.headers["x-amz-content-sha256"]).toBe(sha256Hex(archiveOf(it.storage, "pb_backup_copied.zip")));
    expect(calls[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=k\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=/);
    expect(metaOf(it.storage, "pb_backup_copied.zip")).toMatchObject({ kind: "full", verified: true, offsite: true });
    status = 403;
    const failed = await createBackup(env, "pb_backup_kept.zip", { kind: "data" });
    expect([failed.verified, failed.offsite]).toEqual([true, false]);
    expect(failed.offsiteError).toContain("HTTP 403");
    expect(it.storage.objects.has("__backups__/pb_backup_kept.zip")).toBe(true);
    expect(metaOf(it.storage, "pb_backup_kept.zip")).toMatchObject({ kind: "data", verified: true, offsite: false, offsiteError: failed.offsiteError });
    // a multipart write streams the copy from the storage instead of the buffer
    const mp = await instance({ multipart: true });
    status = 200; calls.length = 0;
    const streamed = await createBackup({ ...mp.env, VOIDBASE_BACKUP_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", VOIDBASE_BACKUP_S3_BUCKET: "vb-offsite", VOIDBASE_BACKUP_S3_ACCESS_KEY_ID: "k", VOIDBASE_BACKUP_S3_SECRET_ACCESS_KEY: "s" } as Bindings, "pb_backup_mp.zip");
    expect(streamed.offsite).toBe(true);
    expect(calls[0]!.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(calls[0]!.size).toBe(archiveOf(mp.storage, "pb_backup_mp.zip").length);
    fetchSpy.mockRestore();
    it.sqlite.close(); mp.sqlite.close();
  });
});

describe("the routes", () => {
  const superuser = { collection: { name: "_superusers", type: "auth" }, row: { id: "s1" } } as unknown as AuthRecord;
  function appOver(env: Bindings) {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("auth", c.req.header("x-as") === "superuser" ? superuser : null); await next(); });
    app.onError((err, c) => (err instanceof ApiError ? c.json({ message: err.message, data: err.data }, err.status as 400) : c.json({ message: String(err) }, 500)));
    mountBackupsApi(app);
    provideAuthLookup(() => provider);
    const waited: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waited.push(p); }, passThroughOnException: () => undefined } as unknown as ExecutionContext;
    const call = async (method: string, path: string, body?: unknown, as = "superuser") => {
      const form = body instanceof FormData;
      const r = await app.request(`http://vb.example${path}`, { method, headers: { "x-as": as, ...(body !== undefined && !form ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : form ? body : JSON.stringify(body) }, env, ctx);
      const text = await r.text();
      return { status: r.status, json: (text ? JSON.parse(text) : null) as Record<string, unknown> & unknown[] };
    };
    return { call, settle: async () => { await Promise.all(waited); waited.length = 0; } };
  }

  test("create per kind, list from the sidecars, verify on demand, restore with its refusals, delete with the sidecar", async () => {
    const it = await instance();
    const { call, settle } = appOver(it.env);
    expect((await call("GET", "/api/backups", undefined, "nobody")).status).toBe(401);
    expect((await call("POST", "/api/backups", { name: "pb_backup_a.zip", kind: "weekly" })).json.data).toEqual({ kind: { code: "validation_in_invalid", message: "Must be one of: full, data, schema." } });
    expect((await call("POST", "/api/backups", { name: "pb_backup_a.zip" })).status).toBe(204);
    expect((await call("POST", "/api/backups", { name: "pb_backup_b.zip", kind: "data" })).status).toBe(204);
    await it.storage.put("__backups__/pb_backup_old.zip", zipSync({ "data.json": enc.encode(JSON.stringify({ format: "voidbase-backup", version: 1, tables: {}, files: [] })) }));
    const list = await call("GET", "/api/backups");
    expect(list.status).toBe(200);
    expect((list.json as unknown as Record<string, unknown>[]).map((b) => [b.key, b.kind, b.verified, b.voidbase, "offsite" in b, typeof b.size, typeof b.modified])).toEqual([
      ["pb_backup_a.zip", "full", true, VERSION, false, "number", "string"],
      ["pb_backup_b.zip", "data", true, VERSION, false, "number", "string"],
      ["pb_backup_old.zip", "legacy", false, null, false, "number", "string"],
    ]);
    // verify on demand, after the archive changed under its sidecar
    const v = await call("POST", "/api/backups/pb_backup_b.zip/verify");
    expect(v.status).toBe(200);
    expect(v.json).toMatchObject({ key: "pb_backup_b.zip", kind: "data", verified: true, voidbase: VERSION, entries: 5, corrupted: [], missing: [] });
    const entries = unzipSync(archiveOf(it.storage, "pb_backup_b.zip"));
    entries["data.jsonl"] = enc.encode(`${text(entries["data.jsonl"])}${JSON.stringify({ tampered: true })}\n`);
    await it.storage.put("__backups__/pb_backup_b.zip", zipSync(entries));
    const v2 = await call("POST", "/api/backups/pb_backup_b.zip/verify");
    expect(v2.json).toMatchObject({ verified: false, corrupted: ["data.jsonl"] });
    expect((await call("GET", "/api/backups")).json[1]).toMatchObject({ key: "pb_backup_b.zip", verified: false, verifyError: "corrupted: data.jsonl" });
    expect((await call("POST", "/api/backups/pb_backup_none.zip/verify")).json.message).toBe("Missing or invalid backup file.");
    // restore: a newer archive is refused with the reason, before anything runs
    const m = json<Manifest>(entries["manifest.json"]);
    const [major, minor] = VERSION.split(".").map(Number);
    const future = `${major! + 1}.${minor}.0`;
    await it.storage.put("__backups__/pb_backup_future.zip", zipSync({ ...entries, "header.json": enc.encode(JSON.stringify({ ...json(entries["header.json"]), voidbase: future })), "manifest.json": enc.encode(JSON.stringify({ ...m, voidbase: future })) }));
    const refused = await call("POST", "/api/backups/pb_backup_future.zip/restore");
    expect(refused.status).toBe(400);
    expect(String(refused.json.message)).toContain(`written by voidbase ${major! + 1}.${minor}.0, newer than this instance (${VERSION})`);
    expect((await call("POST", "/api/backups/pb_backup_none.zip/restore")).json.message).toBe("Missing or invalid backup file.");
    // a restore of the full archive runs in the background and answers 204 as PocketBase does
    it.sqlite.run("INSERT INTO posts (id, title, cover) VALUES ('p3', 'After', '')");
    expect((await call("POST", "/api/backups/pb_backup_a.zip/restore")).status).toBe(204);
    await settle();
    expect(it.sqlite.query("SELECT id FROM posts ORDER BY id").all()).toEqual([{ id: "p1" }, { id: "p2" }]);
    expect((await call("GET", "/api/backups")).json[0]).toMatchObject({ key: "pb_backup_a.zip", restore: { kind: "full", restored: ["posts", "users"], skipped: [], settings: true } });
    // upload verifies on arrival; delete takes the sidecar along
    const fd = new FormData(); fd.append("file", new File([archiveOf(it.storage, "pb_backup_a.zip") as BlobPart], "pb_backup_up.zip", { type: "application/zip" }));
    expect((await call("POST", "/api/backups/upload", fd)).status).toBe(204);
    expect(metaOf(it.storage, "pb_backup_up.zip")).toMatchObject({ kind: "full", verified: true, voidbase: VERSION });
    expect((await call("DELETE", "/api/backups/pb_backup_a.zip")).status).toBe(204);
    expect(it.storage.objects.has("__backups__/pb_backup_a.zip")).toBe(false);
    expect(it.storage.objects.has("__backups__/pb_backup_a.zip.meta.json")).toBe(false);
    it.sqlite.close();
  });
});
