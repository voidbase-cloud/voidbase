// GET /api/collections/:collection/records/:id/can-update: the answer the write path gives by writing, given
// without writing. One instance on bun:sqlite with real collections, real rows and real rules, so the verdict is
// the rule engine's and the field list is the one a PATCH would take.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { d1 } from "../../src/node/d1";
import { insertCollection } from "../../src/server/bootstrap";
import { invalidateCollections, loadCollections, type Collection } from "../../src/server/collections/model";
import { createCollection } from "../../src/server/collections/service";
import { systemCollections } from "../../src/server/collections/system";
import { ApiError } from "../../src/server/errors";
import type { RealtimeClient } from "../../src/server/interfaces";
import { canUpdateRecord, writableFields, type RecordContext } from "../../src/server/records/service";
import type { AppEnv, AuthRecord } from "../../src/server/types";

const ROOT = resolve(import.meta.dir, "../..");

/** an instance with four collections: public-read and rule-protected, owner-read, locked, and wide open */
async function instance() {
  const sqlite = new Database(":memory:");
  for (const file of readdirSync(`${ROOT}/db/migrations`).filter((x) => x.endsWith(".sql")).sort()) {
    for (const s of readFileSync(`${ROOT}/db/migrations/${file}`, "utf8").split("--> statement-breakpoint")) if (s.trim()) sqlite.run(s);
  }
  const db = d1(sqlite);
  invalidateCollections();
  for (const c of systemCollections()) await insertCollection(db, c);
  const users = await createCollection(db, { name: "users", type: "auth", listRule: "", viewRule: "", updateRule: "id = @request.auth.id", fields: [{ name: "name", type: "text" }] });
  await createCollection(db, {
    name: "posts", type: "base", listRule: "", viewRule: "", createRule: "", updateRule: "author = @request.auth.id", deleteRule: null,
    fields: [
      { name: "title", type: "text" }, { name: "body", type: "editor" }, { name: "cover", type: "file", maxSelect: 1 },
      { name: "author", type: "relation", collectionId: users.id, maxSelect: 1 },
      { name: "internal", type: "text", hidden: true },
      { name: "created", type: "autodate", onCreate: true }, { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
  });
  await createCollection(db, {
    name: "drafts", type: "base", listRule: "author = @request.auth.id", viewRule: "author = @request.auth.id", updateRule: "author = @request.auth.id",
    fields: [{ name: "title", type: "text" }, { name: "author", type: "relation", collectionId: users.id, maxSelect: 1 }],
  });
  await createCollection(db, { name: "locked", type: "base", listRule: "", viewRule: "", updateRule: null, fields: [{ name: "title", type: "text" }] });
  await createCollection(db, { name: "notes", type: "base", listRule: "", viewRule: "", updateRule: "", fields: [{ name: "title", type: "text" }] });
  await createCollection(db, { name: "signs", type: "base", listRule: "", viewRule: "", updateRule: 'title != ""', fields: [{ name: "title", type: "text" }] });
  sqlite.run("INSERT INTO users (id, password, tokenKey, email, name) VALUES ('u1', 'h', 'tk1', 'ada@example.com', 'Ada')");
  sqlite.run("INSERT INTO users (id, password, tokenKey, email, name) VALUES ('u2', 'h', 'tk2', 'bob@example.com', 'Bob')");
  sqlite.run("INSERT INTO posts (id, title, body, cover, author, internal, created, updated) VALUES ('p1', 'Hello', 'Body', '', 'u1', 'kept', '', '')");
  sqlite.run("INSERT INTO drafts (id, title, author) VALUES ('d1', 'Mine', 'u1')");
  sqlite.run("INSERT INTO locked (id, title) VALUES ('l1', 'Locked')");
  sqlite.run("INSERT INTO notes (id, title) VALUES ('n1', 'Open')");
  sqlite.run("INSERT INTO signs (id, title) VALUES ('s1', 'Signed')");
  const collections = await loadCollections(db);
  const ada = { collection: collections.get("users")!, row: { id: "u1" } } as AuthRecord;
  const bob = { collection: collections.get("users")!, row: { id: "u2" } } as AuthRecord;
  const su = { collection: collections.get("_superusers")!, row: { id: "s1" } } as AuthRecord;
  const ctx = (auth: AuthRecord | null, superuser = false): RecordContext => ({
    db,
    storage: {} as R2Bucket,
    auth,
    superuser,
    request: { auth: auth ? { collection: auth.collection, row: auth.row } : null, method: "GET", query: {}, headers: {}, body: {}, context: "default" },
    collections,
    realtime: { active: () => false } as unknown as RealtimeClient,
  });
  const can = (auth: AuthRecord | null, collection: string, id: string, superuser = false) => canUpdateRecord(ctx(auth, superuser), collections.get(collection)!, id);
  return { sqlite, db, collections, ada, bob, su, ctx, can };
}

const status = async (p: Promise<unknown>) => { const err = await p.catch((e: unknown) => e); expect(err).toBeInstanceOf(ApiError); return (err as ApiError).status; };

describe("the verdict follows the update rule", () => {
  test("an anonymous caller on a public-read, rule-protected collection: no, with a reason and no fields", async () => {
    const { can } = await instance();
    expect(await can(null, "posts", "p1")).toEqual({ allowed: false, fields: [], reason: "no session" });
  });

  test("the owner: yes, with the fields a PATCH would take", async () => {
    const { can, ada } = await instance();
    expect(await can(ada, "posts", "p1")).toEqual({ allowed: true, fields: ["title", "body", "cover", "author"], reason: null });
  });

  test("a signed-in caller the rule does not name: no", async () => {
    const { can, bob } = await instance();
    expect(await can(bob, "posts", "p1")).toEqual({ allowed: false, fields: [], reason: "the collection's update rule does not admit you" });
  });

  test("a superuser: yes on every record, the locked collection included", async () => {
    const { can, su } = await instance();
    expect(await can(su, "posts", "p1", true)).toEqual({ allowed: true, fields: ["title", "body", "cover", "author"], reason: null });
    expect(await can(su, "locked", "l1", true)).toEqual({ allowed: true, fields: ["title"], reason: null });
    expect(await can(su, "drafts", "d1", true)).toEqual({ allowed: true, fields: ["title", "author"], reason: null });
  });

  test("a null rule is superusers only; an empty rule admits anyone, signed in or not", async () => {
    const { can, ada } = await instance();
    expect(await can(ada, "locked", "l1")).toEqual({ allowed: false, fields: [], reason: "superusers only" });
    expect(await can(null, "locked", "l1")).toEqual({ allowed: false, fields: [], reason: "superusers only" });
    expect(await can(null, "notes", "n1")).toEqual({ allowed: true, fields: ["title"], reason: null });
    expect(await can(ada, "notes", "n1")).toEqual({ allowed: true, fields: ["title"], reason: null });
  });

  test("a rule that names no token is judged, not blamed on the missing session", async () => {
    const { can } = await instance();
    expect(await can(null, "signs", "s1")).toEqual({ allowed: true, fields: ["title"], reason: null });
  });
});

describe("what may be sent, and what may be asked about", () => {
  test("system, hidden and autodate fields never appear, whoever asks", async () => {
    const { can, ada, su, collections } = await instance();
    for (const answer of [await can(ada, "posts", "p1"), await can(su, "posts", "p1", true)]) {
      expect(answer.fields).toEqual(["title", "body", "cover", "author"]);
      for (const name of ["id", "internal", "created", "updated"]) expect(answer.fields).not.toContain(name);
    }
    // an auth collection: the five system fields and the hidden ones are the instance's, not a client's
    expect(writableFields(collections.get("users") as Collection)).toEqual(["name"]);
    expect(await can(ada, "users", "u1")).toEqual({ allowed: true, fields: ["name"], reason: null });
  });

  test("a record the caller cannot view answers 404, exactly as its GET does", async () => {
    const { can, ada, bob } = await instance();
    expect(await can(ada, "drafts", "d1")).toEqual({ allowed: true, fields: ["title", "author"], reason: null });
    expect(await status(can(bob, "drafts", "d1"))).toBe(404);
    expect(await status(can(null, "drafts", "d1"))).toBe(404);
    // and an id that does not exist is the same 404, so the route is no way to probe for ids
    expect(await status(can(ada, "drafts", "nope"))).toBe(404);
    expect(await status(can(ada, "posts", "nope"))).toBe(404);
  });
});

describe("the route", () => {
  /** the route as app.ts wires it, with the same ApiError mapping */
  async function appWith() {
    const inst = await instance();
    const app = new Hono<AppEnv>();
    app.onError((err, c) => (err instanceof ApiError ? c.json(err.toJSON(), err.status as 400) : c.json({ message: String(err) }, 500)));
    const who: Record<string, { auth: AuthRecord | null; superuser: boolean }> = {
      ada: { auth: inst.ada, superuser: false }, bob: { auth: inst.bob, superuser: false }, superuser: { auth: inst.su, superuser: true },
    };
    app.get("/api/collections/:collection/records/:id/can-update", async (c) => {
      const { auth, superuser } = who[c.req.header("x-as") ?? ""] ?? { auth: null, superuser: false };
      const collection = inst.collections.get(c.req.param("collection"));
      if (!collection) return c.json({ message: "The requested resource wasn't found." }, 404);
      return c.json(await canUpdateRecord(inst.ctx(auth, superuser), collection, c.req.param("id")));
    });
    return async (path: string, as = "") => {
      const r = await app.request(`http://shop.example${path}`, { headers: as ? { "x-as": as } : {} });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
  }

  test("a GET answers allowed, fields and reason; the 404 keeps the error envelope", async () => {
    const get = await appWith();
    expect(await get("/api/collections/posts/records/p1/can-update", "ada")).toEqual({ status: 200, body: { allowed: true, fields: ["title", "body", "cover", "author"], reason: null } });
    expect(await get("/api/collections/posts/records/p1/can-update")).toEqual({ status: 200, body: { allowed: false, fields: [], reason: "no session" } });
    expect(await get("/api/collections/posts/records/p1/can-update", "bob")).toEqual({ status: 200, body: { allowed: false, fields: [], reason: "the collection's update rule does not admit you" } });
    const hidden = await get("/api/collections/drafts/records/d1/can-update", "bob");
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ data: {}, message: "The requested resource wasn't found.", status: 404 });
  });
});
