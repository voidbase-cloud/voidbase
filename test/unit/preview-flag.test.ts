// The flagged preview shape at the records level (src/server/records/preview.ts): the mark a flagged write leaves,
// the filter every read carries, the refusal that keeps a preview from editing production, and the removal.
//
// One instance on bun:sqlite with real collections, real rows, real rules and the real records service, so what is
// measured is the SQL the read path builds and not a description of it. The seam under test is `selectSQL` in
// records/service.ts, which is behind the list, its count, the view route and the write path's own fetch, and the
// two queries records/expand.ts runs for an expanded record; the realtime feed reaches the same two.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { d1 } from "../../src/node/d1";
import { insertCollection } from "../../src/server/bootstrap";
import { invalidateCollections, listCollections, loadCollections, type Collection } from "../../src/server/collections/model";
import { createCollection } from "../../src/server/collections/service";
import { systemCollections } from "../../src/server/collections/system";
import { ApiError } from "../../src/server/errors";
import type { RealtimeClient } from "../../src/server/interfaces";
import { flaggedBranches, previewsInfo, removeFlagged } from "../../src/server/plugins/previews";
import { hasPreviewField, PREVIEW_FIELD, PREVIEW_HEADER, previewOf, visibleInPreview } from "../../src/server/records/preview";
import { createRecord, deleteRecord, fetchRecord, listRecords, updateRecord, viewRecord, type ListQuery, type RecordContext } from "../../src/server/records/service";
import { parseSubscription } from "../../src/server/realtime";
import type { AuthRecord, Bindings, Row } from "../../src/server/types";

const ROOT = resolve(import.meta.dir, "../..");
const PREVIEW_OF_VAR = "VOIDBASE_PREVIEW_OF", PREVIEW_VAR = "VOIDBASE_PREVIEW";

/** an R2 that holds nothing: the removal asks it to clean up after the rows it deleted */
const storage = { list: async () => ({ objects: [], truncated: false }), delete: async () => undefined } as unknown as R2Bucket;

/** posts with an author and comments on them, plus a view over posts and a collection nothing ever previews */
async function instance() {
  const sqlite = new Database(":memory:");
  for (const file of readdirSync(`${ROOT}/db/migrations`).filter((x) => x.endsWith(".sql")).sort()) {
    for (const s of readFileSync(`${ROOT}/db/migrations/${file}`, "utf8").split("--> statement-breakpoint")) if (s.trim()) sqlite.run(s);
  }
  const db = d1(sqlite);
  invalidateCollections();
  for (const c of systemCollections()) await insertCollection(db, c);
  const users = await createCollection(db, { name: "users", type: "auth", listRule: "", viewRule: "", fields: [{ name: "name", type: "text" }] });
  const posts = await createCollection(db, {
    name: "posts", type: "base", listRule: "", viewRule: "", createRule: "", updateRule: "", deleteRule: "",
    fields: [{ name: "title", type: "text" }, { name: "author", type: "relation", collectionId: users.id, maxSelect: 1 }],
  });
  await createCollection(db, {
    name: "comments", type: "base", listRule: "", viewRule: "", createRule: "", updateRule: "", deleteRule: "",
    fields: [{ name: "body", type: "text" }, { name: "post", type: "relation", collectionId: posts.id, maxSelect: 1 }],
  });
  await createCollection(db, { name: "settings", type: "base", listRule: "", viewRule: "", createRule: "", fields: [{ name: "key", type: "text" }] });
  sqlite.run("INSERT INTO users (id, password, tokenKey, email, name) VALUES ('uaaaaaaaaaaaaa1', 'h', 'tk1', 'ada@example.com', 'Ada')");
  sqlite.run("INSERT INTO posts (id, title, author) VALUES ('paaaaaaaaaaaaa1', 'Production', 'uaaaaaaaaaaaaa1')");
  sqlite.run("INSERT INTO comments (id, body, post) VALUES ('caaaaaaaaaaaaa1', 'on production', 'paaaaaaaaaaaaa1')");
  sqlite.run("INSERT INTO settings (id, key) VALUES ('saaaaaaaaaaaaa1', 'theme')");
  const env = { DB: db, STORAGE: storage } as unknown as Bindings;
  /** a context for a request, in a branch's lane or production's; `spelling` is how a header key reached it */
  const ctx = async (branch = "", spelling: "route" | "subscription" | "query" = "route"): Promise<RecordContext> => ({
    db, storage, auth: null, superuser: false,
    request: {
      auth: null, method: "GET",
      query: branch && spelling === "query" ? { preview: branch } : {},
      headers: branch && spelling === "route" ? { x_voidbase_preview: branch } : branch && spelling === "subscription" ? { "x-voidbase-preview": branch } : {},
      body: {}, context: "default",
    },
    collections: await loadCollections(db),
    realtime: { active: () => false } as unknown as RealtimeClient,
  });
  const fresh = async (name: string): Promise<Collection> => (await loadCollections(db)).get(name)!;
  return { sqlite, db, env, ctx, fresh };
}

const query = (over: Partial<ListQuery> = {}): ListQuery => ({ page: 1, perPage: 30, skipTotal: false, sort: "", filter: "", expand: "", fields: "", ...over });
const ids = (r: { items: Record<string, unknown>[] }) => r.items.map((i) => String(i.id)).sort();
const status = async (p: Promise<unknown>) => { const err = await p.catch((e: unknown) => e); expect(err).toBeInstanceOf(ApiError); return err as ApiError; };

describe("the mark", () => {
  test("the column is added on the first flagged write to a collection, and on no other", async () => {
    const { ctx, fresh } = await instance();
    expect(hasPreviewField(await fresh("posts"))).toBe(false);
    const made = await createRecord((await ctx("feature/login")), await fresh("posts"), { title: "Draft" }, {});
    const posts = await fresh("posts");
    expect(hasPreviewField(posts)).toBe(true);
    // it is a system, hidden field, so the API's own answer never carries it, and a PATCH would not take it
    const field = (posts.fields as { name: string; type: string; system: boolean; hidden: boolean }[]).find((f) => f.name === PREVIEW_FIELD)!;
    expect(field).toMatchObject({ type: "text", system: true, hidden: true });
    expect(PREVIEW_FIELD in made).toBe(false);
    // a collection nothing flagged has written to is untouched: no column, no migration, nothing to filter
    expect(hasPreviewField(await fresh("comments"))).toBe(false);
    expect(hasPreviewField(await fresh("settings"))).toBe(false);
    await createRecord((await ctx()), await fresh("settings"), { key: "locale" }, {});
    expect(hasPreviewField(await fresh("settings"))).toBe(false);
  });

  test("the mark comes from the request, never from the body, and a row never changes lane", async () => {
    const { ctx, db, fresh } = await instance();
    // a body naming the column is ignored: the header decides, and on a production write the mark is empty
    const mine = await createRecord((await ctx("feature/login")), await fresh("posts"), { title: "Mine", [PREVIEW_FIELD]: "someone-else" }, {});
    const theirs = await createRecord((await ctx()), await fresh("posts"), { title: "Theirs", [PREVIEW_FIELD]: "feature/login" }, {});
    const markOf = async (id: string) => String((await db.prepare(`SELECT ${PREVIEW_FIELD} AS m FROM posts WHERE id = ?`).bind(id).first<{ m: string }>())!.m);
    expect(await markOf(String(mine.id))).toBe("feature/login");
    expect(await markOf(String(theirs.id))).toBe("");
    await updateRecord((await ctx("feature/login")), await fresh("posts"), String(mine.id), { title: "Still mine", [PREVIEW_FIELD]: "" }, {});
    expect(await markOf(String(mine.id))).toBe("feature/login");
  });

  test("the branch is read from the header the routes pass, the one a subscription passes, and ?preview=", async () => {
    expect(previewOf({ headers: { x_voidbase_preview: "feature/login" }, query: {} })).toBe("feature/login");
    expect(previewOf({ headers: { "x-voidbase-preview": "feature/login" }, query: {} })).toBe("feature/login");
    expect(previewOf({ headers: {}, query: { preview: "feature/login" } })).toBe("feature/login");
    expect(previewOf({ headers: {}, query: {} })).toBe("");
    // a value that is not a branch name is not a branch: the request is production's
    for (const bad of ["", " ", "-x", "a b", "'; DROP TABLE posts--", "x".repeat(120)]) expect(previewOf({ headers: {}, query: { preview: bad } })).toBe("");
    // and the wire form a realtime subscription uses reaches it as the same branch
    const sub = parseSubscription(`posts/*?options=${encodeURIComponent(JSON.stringify({ headers: { [PREVIEW_HEADER]: "feature/login" } }))}`)!;
    expect(previewOf({ headers: sub.headers, query: sub.query })).toBe("feature/login");
  });
});

describe("the filter", () => {
  test("a list without the header sees production's rows only; with it, those and its own branch's", async () => {
    const { ctx, fresh } = await instance();
    await createRecord((await ctx("feature/login")), await fresh("posts"), { title: "Login draft" }, {});
    await createRecord((await ctx("feature/search")), await fresh("posts"), { title: "Search draft" }, {});
    const posts = await fresh("posts");
    const plain = await listRecords((await ctx()), posts, query());
    expect(ids(plain)).toEqual(["paaaaaaaaaaaaa1"]);
    expect(plain.totalItems).toBe(1); // the count is the same SQL, so the page and the total agree
    const login = await listRecords((await ctx("feature/login")), posts, query());
    expect(login.items.map((i) => i.title).sort()).toEqual(["Login draft", "Production"]);
    expect(login.totalItems).toBe(2);
    const search = await listRecords((await ctx("feature/search")), posts, query());
    expect(search.items.map((i) => i.title).sort()).toEqual(["Production", "Search draft"]);
    // ?preview= is the same lane as the header, which is what the pull request comment's address carries
    expect((await listRecords((await ctx("feature/login", "query")), posts, query())).totalItems).toBe(2);
  });

  test("a filter and a sort agree with it: they narrow the lane, they do not widen it", async () => {
    const { ctx, fresh } = await instance();
    await createRecord((await ctx("feature/login")), await fresh("posts"), { title: "Zeta draft" }, {});
    const posts = await fresh("posts");
    expect(ids(await listRecords((await ctx()), posts, query({ filter: 'title ~ "draft"' })))).toEqual([]);
    expect((await listRecords((await ctx("feature/login")), posts, query({ filter: 'title ~ "draft"' }))).totalItems).toBe(1);
    const sorted = await listRecords((await ctx("feature/login")), posts, query({ sort: "-title" }));
    expect(sorted.items.map((i) => i.title)).toEqual(["Zeta draft", "Production"]);
    expect((await listRecords((await ctx()), posts, query({ sort: "-title" }))).items.map((i) => i.title)).toEqual(["Production"]);
  });

  test("the view route and the write path's own fetch: a flagged row is not there without the header", async () => {
    const { ctx, fresh } = await instance();
    const draft = String((await createRecord((await ctx("feature/login")), await fresh("posts"), { title: "Draft" }, {})).id);
    const posts = await fresh("posts");
    expect((await status(viewRecord((await ctx()), posts, draft, {}))).status).toBe(404);
    expect((await viewRecord((await ctx("feature/login")), posts, draft, {})).title).toBe("Draft");
    expect((await status(viewRecord((await ctx("feature/search")), posts, draft, {}))).status).toBe(404);
    // fetchRecord is what the realtime feed calls for a create and an update, so the feed sees the same rows
    expect(await fetchRecord((await ctx()), posts, draft, posts.viewRule)).toBeNull();
    expect(await fetchRecord((await ctx("feature/login")), posts, draft, posts.viewRule)).not.toBeNull();
    // and the feed's delete event, whose row is gone from the table, is judged on the event's own copy
    const row = { id: draft, [PREVIEW_FIELD]: "feature/login" } as Row;
    expect(visibleInPreview(posts, row, "")).toBe(false);
    expect(visibleInPreview(posts, row, "feature/search")).toBe(false);
    expect(visibleInPreview(posts, row, "feature/login")).toBe(true);
    expect(visibleInPreview(posts, { id: "paaaaaaaaaaaaa1", [PREVIEW_FIELD]: "" } as Row, "feature/login")).toBe(true);
  });

  test("an expanded record is a read too: the relation and the back-relation both honour the lane", async () => {
    const { ctx, fresh } = await instance();
    const draft = String((await createRecord((await ctx("feature/login")), await fresh("posts"), { title: "Draft" }, {})).id);
    const onDraft = String((await createRecord((await ctx("feature/login")), await fresh("comments"), { body: "on the draft", post: draft }, {})).id);
    const onProduction = String((await createRecord((await ctx("feature/login")), await fresh("comments"), { body: "flagged, on production", post: "paaaaaaaaaaaaa1" }, {})).id);
    const comments = await fresh("comments"), posts = await fresh("posts");
    // forward: the comment flagged onto a production post expands to nothing without the header
    const plain = await listRecords((await ctx()), comments, query({ expand: "post" }));
    expect(ids(plain)).toEqual(["caaaaaaaaaaaaa1"]);
    const login = await listRecords((await ctx("feature/login")), comments, query({ expand: "post" }));
    expect(ids(login)).toEqual([onDraft, onProduction, "caaaaaaaaaaaaa1"].sort());
    expect((login.items.find((i) => i.id === onDraft)!.expand as { post: { title: string } }).post.title).toBe("Draft");
    // back: production's own post expands only production's comment, the branch's sees both
    const backPlain = await listRecords((await ctx()), posts, query({ expand: "comments_via_post" }));
    expect((backPlain.items[0]!.expand as { comments_via_post: unknown[] }).comments_via_post.map((x) => (x as Row).id)).toEqual(["caaaaaaaaaaaaa1"]);
    const backLogin = await listRecords((await ctx("feature/login")), posts, query({ expand: "comments_via_post" }));
    const onP1 = (backLogin.items.find((i) => i.id === "paaaaaaaaaaaaa1")!.expand as { comments_via_post: Row[] }).comments_via_post.map((x) => String(x.id)).sort();
    expect(onP1).toEqual([onProduction, "caaaaaaaaaaaaa1"].sort());
  });

  test("a view collection that carries the mark filters with it; one that does not is answered as before", async () => {
    const { ctx, db, fresh } = await instance();
    await createRecord((await ctx("feature/login")), await fresh("posts"), { title: "Draft" }, {});
    await createCollection(db, { name: "titles", type: "view", listRule: "", viewRule: "", viewQuery: `SELECT posts.id, posts.title, posts.${PREVIEW_FIELD} FROM posts` });
    await createCollection(db, { name: "blind", type: "view", listRule: "", viewRule: "", viewQuery: "SELECT posts.id, posts.title FROM posts" });
    const titles = await fresh("titles"), blind = await fresh("blind");
    expect(hasPreviewField(titles)).toBe(true);
    expect((await listRecords((await ctx()), titles, query())).totalItems).toBe(1);
    expect((await listRecords((await ctx("feature/login")), titles, query())).totalItems).toBe(2);
    // a view that does not select the column has no lane and says so by showing everything, as it did before
    expect(hasPreviewField(blind)).toBe(false);
    expect((await listRecords((await ctx()), blind, query())).totalItems).toBe(2);
  });
});

describe("the honest limit", () => {
  test("a flagged write to a row production already has is refused, not applied", async () => {
    const { ctx, db, fresh } = await instance();
    await createRecord((await ctx("feature/login")), await fresh("posts"), { title: "Draft" }, {});
    const posts = await fresh("posts");
    const refused = await status(updateRecord((await ctx("feature/login")), posts, "paaaaaaaaaaaaa1", { title: "Changed" }, {}));
    expect(refused.status).toBe(400);
    expect(refused.message).toContain("is not a row of the preview");
    expect(refused.message).toContain("cannot isolate a change to a row production already has");
    expect(refused.message).toContain("--shape instance");
    expect(String((await db.prepare("SELECT title AS t FROM posts WHERE id = 'paaaaaaaaaaaaa1'").first<{ t: string }>())!.t)).toBe("Production");
    // a delete is the same change by another name
    expect((await status(deleteRecord((await ctx("feature/login")), posts, "paaaaaaaaaaaaa1"))).status).toBe(400);
    expect(await db.prepare("SELECT id FROM posts WHERE id = 'paaaaaaaaaaaaa1'").first()).not.toBeNull();
  });

  test("its own rows it may change and delete; another branch's it cannot even see", async () => {
    const { ctx, fresh } = await instance();
    const mine = String((await createRecord((await ctx("feature/login")), await fresh("posts"), { title: "Mine" }, {})).id);
    const theirs = String((await createRecord((await ctx("feature/search")), await fresh("posts"), { title: "Theirs" }, {})).id);
    const posts = await fresh("posts");
    expect((await updateRecord((await ctx("feature/login")), posts, mine, { title: "Mine, edited" }, {})).title).toBe("Mine, edited");
    expect((await status(updateRecord((await ctx("feature/login")), posts, theirs, { title: "no" }, {}))).status).toBe(404); // not visible, so not found
    await deleteRecord((await ctx("feature/login")), posts, mine);
    expect((await listRecords((await ctx("feature/login")), posts, query())).totalItems).toBe(1);
    expect((await listRecords((await ctx("feature/search")), posts, query())).totalItems).toBe(2);
  });

  test("a production write is refused nothing: the lane is the caller's, not the instance's", async () => {
    const { ctx, fresh } = await instance();
    await createRecord((await ctx("feature/login")), await fresh("posts"), { title: "Draft" }, {});
    expect((await updateRecord((await ctx()), await fresh("posts"), "paaaaaaaaaaaaa1", { title: "Edited" }, {})).title).toBe("Edited");
    await deleteRecord((await ctx()), await fresh("posts"), "paaaaaaaaaaaaa1");
  });
});

describe("cleaning up", () => {
  test("a removal takes the branch's rows and leaves every other row where it was", async () => {
    const { ctx, env, fresh } = await instance();
    const mine = String((await createRecord((await ctx("feature/login")), await fresh("posts"), { title: "Mine" }, {})).id);
    await createRecord((await ctx("feature/login")), await fresh("comments"), { body: "mine too", post: mine }, {});
    await createRecord((await ctx("feature/search")), await fresh("posts"), { title: "Theirs" }, {});
    expect(await flaggedBranches(env.DB, await listCollections(env.DB))).toEqual([
      { branch: "feature/login", rows: 2, collections: ["comments", "posts"] },
      { branch: "feature/search", rows: 1, collections: ["posts"] },
    ]);
    const out = await removeFlagged(env, "feature/login");
    expect(out).toEqual({ branch: "feature/login", rows: 2, deleted: { comments: 1, posts: 1 } });
    expect(await flaggedBranches(env.DB, await listCollections(env.DB))).toEqual([{ branch: "feature/search", rows: 1, collections: ["posts"] }]);
    expect(ids(await listRecords((await ctx()), await fresh("posts"), query()))).toEqual(["paaaaaaaaaaaaa1"]);
    expect(ids(await listRecords((await ctx()), await fresh("comments"), query()))).toEqual(["caaaaaaaaaaaaa1"]);
    expect((await listRecords((await ctx("feature/login")), await fresh("posts"), query())).totalItems).toBe(1);
    // a branch nobody wrote for takes nothing away
    expect(await removeFlagged(env, "feature/never")).toEqual({ branch: "feature/never", rows: 0, deleted: {} });
  });

  test("what /api/plugins reports: the shape, and in flagged mode the branches with rows", async () => {
    const { ctx, env, fresh } = await instance();
    expect(previewsInfo({})).toEqual({ shape: "flagged" });
    expect(previewsInfo({ [PREVIEW_VAR]: "feature/x", [PREVIEW_OF_VAR]: "shop" })).toEqual({ shape: "instance", of: "shop", branch: "feature/x" });
    expect(await flaggedBranches(env.DB, await listCollections(env.DB))).toEqual([]);
    await createRecord((await ctx("feature/login")), await fresh("posts"), { title: "Draft" }, {});
    expect(await flaggedBranches(env.DB, await listCollections(env.DB))).toEqual([{ branch: "feature/login", rows: 1, collections: ["posts"] }]);
  });
});

describe("an instance nobody previews", () => {
  test("nothing changes at all when no request ever carries the header", async () => {
    const { ctx, fresh, db } = await instance();
    const before = await listRecords((await ctx()), await fresh("posts"), query({ expand: "author" }));
    const made = await createRecord((await ctx()), await fresh("posts"), { title: "Second", author: "uaaaaaaaaaaaaa1" }, {});
    await updateRecord((await ctx()), await fresh("posts"), "paaaaaaaaaaaaa1", { title: "Production, edited" }, {});
    const posts = await fresh("posts");
    expect(hasPreviewField(posts)).toBe(false); // no column, so no condition is added to any read
    const after = await listRecords((await ctx()), posts, query({ expand: "author" }));
    expect(ids(after)).toEqual(["paaaaaaaaaaaaa1", String(made.id)].sort());
    expect(Object.keys(before.items[0]!).sort()).toEqual(Object.keys(after.items.find((i) => i.id === "paaaaaaaaaaaaa1")!).sort());
    expect((await db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('posts') WHERE name = ?").bind(PREVIEW_FIELD).first<{ n: number }>())!.n).toBe(0);
  });

  test("and once a branch has used it, a production read is exactly the rows it had before", async () => {
    const { ctx, fresh } = await instance();
    const was = ids(await listRecords((await ctx()), await fresh("posts"), query()));
    await createRecord((await ctx("feature/login")), await fresh("posts"), { title: "Draft" }, {});
    expect(ids(await listRecords((await ctx()), await fresh("posts"), query()))).toEqual(was);
    expect((await viewRecord((await ctx()), await fresh("posts"), "paaaaaaaaaaaaa1", {})).title).toBe("Production");
  });
});
