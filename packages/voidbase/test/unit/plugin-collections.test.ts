// A plugin creates what it owns, and only that, and an import that deletes what it does not name leaves it alone;
// bootstrap work runs once per isolate, in load order; and after-read work runs on every read, in load order, over the
// rows the response will carry.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createKernel, load, onAfterRead, onBootstrap, ownedCollections, runAfterRead, runBootstraps, type Kernel } from "../../src/server/kernel";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { insertCollection } from "../../src/server/bootstrap";
import { findCollection, invalidateCollections, loadCollections } from "../../src/server/collections/model";
import { createCollection, importCollections } from "../../src/server/collections/service";
import { systemCollections } from "../../src/server/collections/system";
import { d1 } from "../../src/node/d1";
import { $app, hookStore, type HookStore } from "../../src/server/hooks/runtime";
import { ensureCollections, reconcileDefinition } from "../../src/server/plugins/collections";
import type { Plugin } from "../../src/server/plugins/manifest";
import type { Settings } from "../../src/server/settings";
import type { Bindings } from "../../src/server/types";

const untouched = new Proxy({}, { get() { throw new Error("the database was touched"); } }) as unknown as D1Database;

describe("owning a collection", () => {
  test("a plugin may only create collections its manifest owns, and is refused before the database is touched", async () => {
    const plugin: Plugin = { manifest: { name: "shop", version: "1.0.0", tier: "community", voidbase: "*", collections: ["orders"] } };
    const err = await ensureCollections(plugin, untouched, [{ name: "orders", type: "base", fields: [] }, { name: "customers", type: "base", fields: [] }]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('creates the collection "customers" without owning it');
  });
});

// an instance on bun:sqlite behind the D1 shim: voidbase's migrations and its system collections, nothing else
const ROOT = resolve(import.meta.dir, "../..");
async function instance() {
  const sqlite = new Database(":memory:");
  for (const file of readdirSync(`${ROOT}/db/migrations`).filter((x) => x.endsWith(".sql")).sort()) for (const s of readFileSync(`${ROOT}/db/migrations/${file}`, "utf8").split("--> statement-breakpoint")) if (s.trim()) sqlite.run(s);
  const db = d1(sqlite);
  invalidateCollections();
  for (const c of systemCollections()) await insertCollection(db, c);
  return { sqlite, db };
}

describe("reconciling an owned collection", () => {
  const plugin: Plugin = { manifest: { name: "notes", version: "1.0.0", tier: "community", voidbase: "*", collections: ["notes"] } };
  const v1 = { name: "notes", type: "base", listRule: "user = @request.auth.id", viewRule: "user = @request.auth.id", createRule: null, updateRule: null, deleteRule: null, fields: [{ name: "user", type: "text" }, { name: "title", type: "text" }] };
  const v1i = { ...v1, indexes: ["CREATE INDEX `idx_notes_by` ON `notes` (`user`)"] };
  const v2 = { ...v1, listRule: "owner = @request.auth.id", viewRule: "owner = @request.auth.id", fields: [{ name: "owner", type: "text" }, { name: "user", type: "text" }], indexes: ["CREATE INDEX `idx_notes_owner` ON `notes` (`owner`)", "CREATE INDEX `idx_notes_by` ON `notes` (`owner`, `title`)"] };

  test("a newer definition adds its fields, indexes and rules to the collection an older version created; nothing is dropped", async () => {
    const { sqlite, db } = await instance();
    expect(await ensureCollections(plugin, db, [v1i])).toEqual(["notes"]);
    sqlite.run("INSERT INTO notes (id, user, title) VALUES ('n1', 'u1', 'kept')");
    expect(await ensureCollections(plugin, db, [v2])).toEqual([]);
    const c = (await findCollection(db, "notes"))!;
    expect(c.fields.map((f) => f.name)).toEqual(["id", "user", "title", "owner"]);
    expect(c.listRule).toBe("owner = @request.auth.id");
    // an index of a known name is replaced (its columns moved with the fields), a new name is added
    expect(c.indexes).toEqual(["CREATE INDEX `idx_notes_by` ON `notes` (`owner`, `title`)", "CREATE INDEX `idx_notes_owner` ON `notes` (`owner`)"]);
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notes' AND name LIKE 'idx_%' ORDER BY name").all()).toEqual([{ name: "idx_notes_by" }, { name: "idx_notes_owner" }]);
    expect(sqlite.query("SELECT title, owner FROM notes").all()).toEqual([{ title: "kept", owner: "" }]);
    expect(reconcileDefinition(c, v2)).toBeNull();
  });

  test("a collection the instance refuses to create is logged, not thrown: every other request still answers", async () => {
    const { db } = await instance();
    // a rule naming a collection that is not there: the demo went down this way on 2026-09-11
    const bad = { ...v1, name: "notes", listRule: "buyer.user = @request.auth.id" };
    await expect(ensureCollections(plugin, db, [bad])).resolves.toEqual([]);
    expect(await findCollection(db, "notes")).toBeNull();
  });

  test("a shape the instance refuses is logged, not thrown: the instance keeps running on the old shape", async () => {
    const { db } = await instance();
    await ensureCollections(plugin, db, [v1]);
    const bad = { ...v1, fields: [...v1.fields, { name: "user", type: "number" }, { name: "id", type: "text" }, { name: "", type: "text" }] };
    await expect(ensureCollections(plugin, db, [bad])).resolves.toEqual([]);
    expect((await findCollection(db, "notes"))!.fields.map((f) => f.name)).toEqual(["id", "user", "title"]);
  });

  test("a definition that matches touches nothing", async () => {
    const { db } = await instance();
    await ensureCollections(plugin, db, [v1]);
    const before = (await findCollection(db, "notes"))!;
    expect(reconcileDefinition(before, v1)).toBeNull();
    await ensureCollections(plugin, db, [v1]);
    expect((await findCollection(db, "notes"))!.updated).toBe(before.updated);
  });
});

describe("an import that deletes what it does not name", () => {
  // the shop owns two collections; its bootstrap has created only one of them (the other waits on a key, say)
  const shop: Plugin = { manifest: { name: "shop", version: "1.0.0", tier: "community", voidbase: "*", collections: ["orders", "refunds"] } };
  const base = (name: string) => ({ name, type: "base", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, fields: [{ name: "title", type: "text" }] });
  // a kernel that loaded no plugins: how a test forgets what an earlier load recorded, and how each one leaves it
  const forget = () => load(createKernel(new Hono() as never), [], "0.9.0");
  async function shopInstance() {
    const { db } = await instance();
    await load(createKernel(new Hono() as never), [shop], "0.9.0");
    await ensureCollections(shop, db, [base("orders")]);
    await createCollection(db, base("posts"));
    await createCollection(db, base("scratch"));
    return db;
  }

  test("the kernel records what the loaded plugins own when it loads", async () => {
    try {
      await load(createKernel(new Hono() as never), [shop, { manifest: { name: "plain", version: "1.0.0", tier: "community", voidbase: "*" } }], "0.9.0");
      expect([...ownedCollections()]).toEqual(["orders", "refunds"]);
      await load(createKernel(new Hono() as never), [], "0.9.0");
      expect([...ownedCollections()]).toEqual([]);
    } finally { await forget(); }
  });

  test("keeps a collection a loaded plugin owns, and still deletes one nobody owns", async () => {
    try {
      const db = await shopInstance();
      // the demo's reset, in miniature: its own list, deleteMissing on
      await importCollections(db, [base("posts")], true);
      expect(await findCollection(db, "orders")).not.toBeNull();
      expect(await findCollection(db, "posts")).not.toBeNull();
      expect(await findCollection(db, "scratch")).toBeNull();
      // nothing is spared once no plugin owns it: the same sweep with the shop gone deletes its collection
      await forget();
      await importCollections(db, [base("posts")], true);
      expect(await findCollection(db, "orders")).toBeNull();
    } finally { await forget(); }
  });

  test("a hook is handed the collections plugins own that exist here, of the types it names", async () => {
    try {
      const db = await shopInstance();
      const store: HookStore = { c: null, ctx: async () => { throw new Error("no record context in this test"); }, collections: await loadCollections(db), settings: {} as Settings, env: { DB: db } };
      hookStore.run(store, () => {
        // "refunds" is owned but was never created, so it is not handed over: every answer can be truncated
        expect($app.findPluginCollections().map((c) => c.name)).toEqual(["orders"]);
        expect($app.findPluginCollections("base", "auth").map((c) => c.name)).toEqual(["orders"]);
        expect($app.findPluginCollections("view")).toEqual([]);
      });
    } finally { await forget(); }
  });
});

describe("bootstrap work", () => {
  const plugin = (name: string, ran: string[], requires: ("payments@1")[] = []): Plugin => ({
    manifest: { name, version: "1.0.0", tier: "community", voidbase: "*", requires, ...(name === "stripe" ? { provides: ["payments@1"] } : {}) },
    apply(ctx: Kernel) { onBootstrap(ctx, async (env) => { ran.push(`${name}:${(env as unknown as { tag: string }).tag}`); }); if (name === "stripe") (ctx as unknown as { provide(n: string, v: unknown): void }).provide("payments@1", {}); },
  });

  test("runs once per isolate with the bindings, in load order, and is recorded under the plugin's name", async () => {
    const ran: string[] = [];
    const kernel = createKernel(new Hono() as never);
    await load(kernel, [plugin("checkout", ran, ["payments@1"]), plugin("stripe", ran)], "0.9.0");
    expect(kernel.bootstraps.map((b) => b.plugin)).toEqual(["stripe", "checkout"]);
    const env = { tag: "one" } as unknown as Bindings;
    await Promise.all([runBootstraps(kernel, env), runBootstraps(kernel, env)]);
    await runBootstraps(kernel, { tag: "two" } as unknown as Bindings);
    expect(ran).toEqual(["stripe:one", "checkout:one"]);
  });

  test("a failure is not remembered: the next request tries again", async () => {
    let attempts = 0;
    const kernel = createKernel(new Hono() as never);
    await load(kernel, [{ manifest: { name: "flaky", version: "1.0.0", tier: "community", voidbase: "*" }, apply(ctx) { onBootstrap(ctx, async () => { if (attempts++ === 0) throw new Error("not yet"); }); } }], "0.9.0");
    await expect(runBootstraps(kernel, {} as Bindings)).rejects.toThrow("not yet");
    await runBootstraps(kernel, {} as Bindings);
    expect(attempts).toBe(2);
  });
});

describe("after-read work", () => {
  test("runs on every read in load order, sees the rows in place, and is recorded under the plugin's name", async () => {
    const plugin = (name: string): Plugin => ({
      manifest: { name, version: "1.0.0", tier: "community", voidbase: "*" },
      apply(ctx: Kernel) { onAfterRead(ctx, (c, read) => { for (const row of read.rows) row.seen = `${String(row.seen ?? "")}${name}:${read.collection};`; c.header("x-seen-by", name); }); },
    });
    const app = new Hono() as never;
    const kernel = createKernel(app);
    await load(kernel, [plugin("first"), plugin("second")], "0.9.0");
    expect(kernel.afterReads.map((h) => h.plugin)).toEqual(["first", "second"]);
    const rows = [{ id: "a" }, { id: "b" }];
    const headers: Record<string, string> = {};
    const c = { header: (k: string, v: string) => { headers[k] = v; } } as never;
    await runAfterRead(kernel, c, { collection: "posts", rows });
    expect(rows).toEqual([{ id: "a", seen: "first:posts;second:posts;" }, { id: "b", seen: "first:posts;second:posts;" }]);
    expect(headers).toEqual({ "x-seen-by": "second" });
    // nothing registered: the rows are untouched
    const bare = createKernel(app);
    await load(bare, [], "0.9.0");
    const plain = [{ id: "a" }];
    await runAfterRead(bare, c, { collection: "posts", rows: plain });
    expect(plain).toEqual([{ id: "a" }]);
  });
});
