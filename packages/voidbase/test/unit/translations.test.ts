// The translations plugin: the knob grammar, the locale a request gets, the swap with its fallback and marker, one
// lookup per response, the reports, and a collection the knob does not name answered exactly as before.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { provideAuthLookup } from "../../src/server/auth-slot";
import type { Collection } from "../../src/server/collections/model";
import { planCreate, prepareCollection } from "../../src/server/collections/service";
import { ApiError } from "../../src/server/errors";
import { createKernel, load, runAfterRead } from "../../src/server/kernel";
import { d1 } from "../../src/node/d1";
import { auth, provider } from "../../src/server/plugins/auth";
import { applyTranslations, configOf, dbSource, negotiateLocale, parseLocales, parseTranslatable, translations, translationsInfo, translationsWith, TRANSLATIONS_COLLECTION, type TranslationRow, type TranslationsSource } from "../../src/server/plugins/translations";
import type { AppEnv, AuthRecord, Bindings } from "../../src/server/types";

// the collections: two declared translatable, one that expands into a declared one, one the knob never names
const f = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ id: `f_${name}`, name, type, system: false, hidden: false, presentable: false, required: false, help: "", ...extra });
const collection = (name: string, type: Collection["type"], fields: Record<string, unknown>[], system = false): Collection =>
  ({ id: `c_${name}`, name, type, system, fields: fields as Collection["fields"], indexes: [], options: {}, created: "", updated: "", listRule: "", viewRule: "", createRule: null, updateRule: null, deleteRule: null }) as Collection;
const COLLECTIONS: Collection[] = [
  collection("_superusers", "auth", [f("id", "text", { primaryKey: true, system: true }), f("email", "email", { system: true })], true),
  collection("posts", "base", [f("id", "text", { primaryKey: true, system: true }), f("title", "text"), f("body", "editor")]),
  collection("pages", "base", [f("id", "text", { primaryKey: true, system: true }), f("title", "text")]),
  collection("comments", "base", [f("id", "text", { primaryKey: true, system: true }), f("text", "text"), f("post", "relation", { collectionId: "c_posts", maxSelect: 1 })]),
  collection("secrets", "base", [f("id", "text", { primaryKey: true, system: true }), f("title", "text")]),
];
type Json = Record<string, unknown>;
const POSTS: Json[] = [
  { collectionId: "c_posts", collectionName: "posts", id: "p1", title: "Hello", body: "Body one" },
  { collectionId: "c_posts", collectionName: "posts", id: "p2", title: "", body: "Body two" },
  { collectionId: "c_posts", collectionName: "posts", id: "p3", title: "Third", body: "Body three" },
];
const PAGES: Json[] = [{ collectionId: "c_pages", collectionName: "pages", id: "g1", title: "About" }];
const COMMENTS: Json[] = [{ collectionId: "c_comments", collectionName: "comments", id: "c1", text: "nice", post: "p1", expand: { post: { ...POSTS[0] } } }];
const SECRETS: Json[] = [{ collectionId: "c_secrets", collectionName: "secrets", id: "s1", title: "Hush" }];
const ROWS: Record<string, Json[]> = { posts: POSTS, pages: PAGES, comments: COMMENTS, secrets: SECRETS };
const TRANSLATIONS: TranslationRow[] = [
  { collection: "posts", record: "p1", field: "title", locale: "ar", value: "مرحبا" },
  { collection: "posts", record: "p1", field: "body", locale: "ar", value: "" }, // an empty translation is no translation
  { collection: "posts", record: "p1", field: "title", locale: "fr", value: "Bonjour" },
  { collection: "posts", record: "p2", field: "title", locale: "ar", value: "عنوان" },
  { collection: "posts", record: "p2", field: "body", locale: "fr", value: "Corps deux" },
  { collection: "pages", record: "g1", field: "title", locale: "ar", value: "حول" },
];
const KNOBS = { VOIDBASE_TRANSLATABLE: "posts:title,body;pages:title", VOIDBASE_LOCALES: "en,ar,fr" };

/** the source over the fixtures, recording each translations lookup */
const seen: { ids: string[]; locales: string[] }[] = [];
const spySource: TranslationsSource = {
  collections: async () => COLLECTIONS,
  translations: async (_env, ids, locales) => { seen.push({ ids, locales }); return TRANSLATIONS.filter((t) => ids.includes(t.record) && locales.includes(t.locale)); },
  recordIds: async (_env, c, page, perPage) => { const all = (ROWS[c.name] ?? []).map((r) => String(r.id)); return { ids: all.slice((page - 1) * perPage, page * perPage), totalItems: all.length }; },
  counts: async (_env, c, fields) => {
    const translated: Record<string, number> = {};
    for (const t of TRANSLATIONS) if (t.collection === c.name && fields.includes(t.field) && t.value && (ROWS[c.name] ?? []).some((r) => r.id === t.record)) translated[t.locale] = (translated[t.locale] ?? 0) + 1;
    return { records: (ROWS[c.name] ?? []).length, translated };
  },
};
const superuser = { collection: COLLECTIONS[0], row: { id: "s1" } } as AuthRecord;

/** a Hono app with the kernel: the records routes as app.ts wires them (fixture rows, then the seam), and the plugin */
async function appWith(env: Record<string, unknown> = KNOBS, plugin = translationsWith(spySource)) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("auth", c.req.header("x-as") === "superuser" ? superuser : null); await next(); });
  app.onError((err, c) => (err instanceof ApiError ? c.json({ message: err.message }, err.status as 400) : c.json({ message: String(err) }, 500)));
  const kernel = createKernel(app);
  app.get("/api/collections/:collection/records", async (c) => {
    const rows = structuredClone(ROWS[c.req.param("collection")] ?? []);
    await runAfterRead(kernel, c, { collection: c.req.param("collection"), rows });
    return c.json({ items: rows, page: 1, perPage: 30, totalItems: rows.length, totalPages: 1 });
  });
  app.get("/api/collections/:collection/records/:id", async (c) => {
    const row = structuredClone((ROWS[c.req.param("collection")] ?? []).find((r) => r.id === c.req.param("id")));
    if (!row) return c.json({ message: "not found" }, 404);
    await runAfterRead(kernel, c, { collection: c.req.param("collection"), rows: [row] });
    return c.json(row);
  });
  await load(kernel, [auth, plugin], "0.9.0");
  provideAuthLookup(() => provider);
  const get = async (path: string, headers: Record<string, string> = {}) => { const r = await app.request(`http://shop.example${path}`, { headers }, env as unknown as Bindings); const text = await r.text(); return { r, text, json: (text ? JSON.parse(text) : null) as Json }; };
  return { app, get };
}
const items = (json: Json) => json.items as Json[];

let warn: ReturnType<typeof spyOn> | null = null;
const quiet = () => { warn = spyOn(console, "warn").mockImplementation(() => {}); return warn; };
const warned = () => (warn?.mock.calls ?? []).map((c) => String(c[0])).join("\n");
afterEach(() => { warn?.mockRestore(); warn = null; seen.length = 0; });

describe("the knobs", () => {
  test("VOIDBASE_TRANSLATABLE: `;` between collections, `,` between fields, whitespace ignored, repeats merged", () => {
    expect([...parseTranslatable("posts:title,body;pages:title")]).toEqual([["posts", ["title", "body"]], ["pages", ["title"]]]);
    expect([...parseTranslatable(" posts : title , body ; posts:summary,title ; ")]).toEqual([["posts", ["title", "body", "summary"]]]);
    expect(parseTranslatable("").size).toBe(0);
  });

  test("a malformed entry is skipped with a warning, the others kept", () => {
    quiet();
    expect([...parseTranslatable("posts;pages:;1bad:title;ok:a-b;pages:title")]).toEqual([["pages", ["title"]]]);
    expect(warned().split("\n").filter((l) => l.includes("VOIDBASE_TRANSLATABLE entry skipped"))).toHaveLength(4);
  });

  test("VOIDBASE_LOCALES: lowercased, deduplicated, the first is the source; a non-tag is skipped", () => {
    quiet();
    expect(parseLocales("en, AR,fr,en,pt-BR")).toEqual(["en", "ar", "fr", "pt-br"]);
    expect(parseLocales("en,not a tag,de")).toEqual(["en", "de"]);
    expect(warned()).toContain("VOIDBASE_LOCALES entry skipped");
    const cfg = configOf(KNOBS);
    expect(cfg.source).toBe("en");
    expect(cfg.locales).toEqual(["en", "ar", "fr"]);
    expect(translationsInfo(KNOBS)).toEqual({ source: "en", locales: ["en", "ar", "fr"], collections: { posts: ["title", "body"], pages: ["title"] } });
    expect(translationsInfo({})).toEqual({ source: "", locales: [], collections: {} });
  });
});

describe("the locale a request gets", () => {
  const L = ["en", "ar", "fr"];
  test("?locale wins when it is one of the locales; an unknown one is the source, not an error", () => {
    expect(negotiateLocale("ar", "fr", L)).toBe("ar");
    expect(negotiateLocale("FR", undefined, L)).toBe("fr");
    expect(negotiateLocale("de", "ar", L)).toBe("en");
  });
  test("Accept-Language: the best q among the locales, exact before primary subtag, * and nothing are the source", () => {
    expect(negotiateLocale(undefined, "fr-CA;q=0.8, ar;q=0.9", L)).toBe("ar");
    expect(negotiateLocale(undefined, "de, fr;q=0.5", L)).toBe("fr");
    expect(negotiateLocale(undefined, "fr-CA", L)).toBe("fr");
    expect(negotiateLocale(undefined, "de;q=0.9, *;q=0.1", L)).toBe("en");
    expect(negotiateLocale(undefined, "de, it", L)).toBe("en");
    expect(negotiateLocale(undefined, "ar;q=0", L)).toBe("en");
    expect(negotiateLocale("", undefined, L)).toBe("en");
    expect(negotiateLocale("ar", "ar", [])).toBe("");
  });
});

describe("reading in a locale", () => {
  test("each translatable field is swapped, the source kept where the locale has none, and `translated` says which", async () => {
    const { get } = await appWith();
    const { r, json } = await get("/api/collections/posts/records?locale=ar");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-language")).toBe("ar");
    const [p1, p2, p3] = items(json);
    expect(p1).toEqual({ collectionId: "c_posts", collectionName: "posts", id: "p1", title: "مرحبا", body: "Body one", translated: { title: "ar" } });
    expect(p2).toEqual({ collectionId: "c_posts", collectionName: "posts", id: "p2", title: "عنوان", body: "Body two", translated: { title: "ar" } });
    expect(p3).toEqual(POSTS[2]); // nothing in ar: no marker at all
  });

  test("the fallback runs down VOIDBASE_LOCALES' order: an empty source value is missing and the next locale is tried", async () => {
    const { get } = await appWith();
    const { r, json } = await get("/api/collections/posts/records?locale=fr");
    expect(r.headers.get("content-language")).toBe("fr");
    const [p1, p2] = items(json);
    expect(p1).toMatchObject({ title: "Bonjour", body: "Body one", translated: { title: "fr" } });
    // p2 has no fr title and an empty en title, so the ar one is served and the marker says so; the body is fr
    expect(p2).toMatchObject({ title: "عنوان", body: "Corps deux", translated: { title: "ar", body: "fr" } });
  });

  test("the source locale is the records as they are: no lookup, only the header", async () => {
    const { get } = await appWith();
    const { r, json } = await get("/api/collections/posts/records?locale=en");
    expect(r.headers.get("content-language")).toBe("en");
    expect(items(json)).toEqual(POSTS);
    expect(seen).toEqual([]);
  });

  test("a single record is negotiated from Accept-Language", async () => {
    const { get } = await appWith();
    const { r, json } = await get("/api/collections/pages/records/g1", { "accept-language": "fr-CA;q=0.8, ar;q=0.9" });
    expect(r.headers.get("content-language")).toBe("ar");
    expect(json).toEqual({ ...PAGES[0], title: "حول", translated: { title: "ar" } });
    const plain = await get("/api/collections/pages/records/g1");
    expect(plain.r.headers.get("content-language")).toBe("en");
    expect(plain.json).toEqual(PAGES[0]);
  });

  test("one lookup per response, over every declared record in it, expanded ones included", async () => {
    const { get } = await appWith();
    await get("/api/collections/posts/records?locale=ar");
    expect(seen).toEqual([{ ids: ["p1", "p2", "p3"], locales: ["ar", "fr"] }]);
    seen.length = 0;
    // comments are not declared, but the post each expands into is
    const { r, json } = await get("/api/collections/comments/records?locale=ar");
    expect(r.headers.get("content-language")).toBe("ar");
    expect(seen).toEqual([{ ids: ["p1"], locales: ["ar", "fr"] }]);
    const [c1] = items(json);
    expect(c1!.text).toBe("nice");
    expect(c1!.translated).toBeUndefined();
    expect((c1!.expand as Json).post).toMatchObject({ title: "مرحبا", translated: { title: "ar" } });
  });

  test("a collection the knob does not name is answered byte for byte as before, no header", async () => {
    const { get } = await appWith();
    const { r, text } = await get("/api/collections/secrets/records?locale=ar", { "accept-language": "ar" });
    expect(r.headers.get("content-language")).toBeNull();
    expect(text).toBe(JSON.stringify({ items: SECRETS, page: 1, perPage: 30, totalItems: 1, totalPages: 1 }));
    expect(seen).toEqual([]);
  });

  test("without the knobs the plugin is idle: nothing swapped, no header, no lookup", async () => {
    const { get } = await appWith({ VOIDBASE_LOCALES: "en,ar" });
    const { r, json } = await get("/api/collections/posts/records?locale=ar");
    expect(r.headers.get("content-language")).toBeNull();
    expect(items(json)).toEqual(POSTS);
    expect(seen).toEqual([]);
  });

  test("applyTranslations on its own: a field `fields` left out is skipped, a row without an id too", () => {
    const rows: Json[] = [{ id: "p1", title: "Hello" }, { title: "No id" }];
    applyTranslations(rows, "posts", configOf(KNOBS), "ar", TRANSLATIONS);
    expect(rows).toEqual([{ id: "p1", title: "مرحبا", translated: { title: "ar" } }, { title: "No id" }]);
  });
});

describe("the reports", () => {
  test("missing: the records of the page lacking a field in that locale, with the fields, paginated like records", async () => {
    const { get } = await appWith();
    const { r, json } = await get("/api/translations/missing?collection=posts&locale=ar", { "x-as": "superuser" });
    expect(r.status).toBe(200);
    expect(json).toEqual({ collection: "posts", locale: "ar", page: 1, perPage: 30, totalItems: 3, totalPages: 1, items: [{ id: "p1", fields: ["body"] }, { id: "p2", fields: ["body"] }, { id: "p3", fields: ["title", "body"] }] });
    const page2 = await get("/api/translations/missing?collection=posts&locale=fr&page=2&perPage=2", { "x-as": "superuser" });
    expect(page2.json).toEqual({ collection: "posts", locale: "fr", page: 2, perPage: 2, totalItems: 3, totalPages: 2, items: [{ id: "p3", fields: ["title", "body"] }] });
    expect((await get("/api/translations/missing?collection=pages&locale=ar", { "x-as": "superuser" })).json.items).toEqual([]);
  });

  test("missing: superusers only, and the collection and locale have to be declared ones", async () => {
    const { get } = await appWith();
    expect((await get("/api/translations/missing?collection=posts&locale=ar")).r.status).toBe(401);
    for (const [q, msg] of [["collection=secrets&locale=ar", "not declared translatable"], ["collection=posts&locale=de", "not one of the locales"], ["collection=posts&locale=en", "is the source locale"]] as const) {
      const { r, json } = await get(`/api/translations/missing?${q}`, { "x-as": "superuser" });
      expect(r.status).toBe(400);
      expect(String(json.message)).toContain(msg);
    }
  });

  test("status: per collection and locale, translated (record, field) pairs out of records times fields", async () => {
    const { get } = await appWith();
    expect((await get("/api/translations/status")).r.status).toBe(401);
    const { r, json } = await get("/api/translations/status", { "x-as": "superuser" });
    expect(r.status).toBe(200);
    expect(json).toEqual({
      source: "en", locales: ["en", "ar", "fr"],
      collections: {
        posts: { fields: ["title", "body"], records: 3, locales: { ar: { translated: 2, total: 6 }, fr: { translated: 2, total: 6 } } },
        pages: { fields: ["title"], records: 1, locales: { ar: { translated: 1, total: 1 }, fr: { translated: 0, total: 1 } } },
      },
    });
  });

  test("status: a declared collection that does not exist is left out with a warning", async () => {
    quiet();
    const { get } = await appWith({ ...KNOBS, VOIDBASE_TRANSLATABLE: "posts:title;nothing:title" });
    const { json } = await get("/api/translations/status", { "x-as": "superuser" });
    expect(Object.keys(json.collections as Json)).toEqual(["posts"]);
    expect(warned()).toContain("nothing");
  });
});

describe("the shipped plugin", () => {
  test("is official, called translations, owns the translations collection, and is idle without the knobs", async () => {
    expect(translations.manifest).toMatchObject({ name: "translations", tier: "official", collections: ["translations"] });
    const { get } = await appWith({}, translations);
    const { r, json } = await get("/api/collections/posts/records?locale=ar");
    expect(r.headers.get("content-language")).toBeNull();
    expect(items(json)).toEqual(POSTS);
  });

  test("the collection it creates: the four keys required, one unique index over them, public reads, superuser writes", () => {
    const c = prepareCollection(TRANSLATIONS_COLLECTION, null);
    expect(c.fields.filter((x) => x.required).map((x) => x.name)).toEqual(["id", "collection", "record", "field", "locale"]);
    expect(c.indexes).toEqual(["CREATE UNIQUE INDEX `idx_translations_key` ON `translations` (`collection`, `record`, `field`, `locale`)"]);
    expect([c.listRule, c.viewRule, c.createRule, c.updateRule, c.deleteRule]).toEqual(["", "", null, null, null]);
  });

  test("the default source's queries, over the table the definition creates", async () => {
    const sqlite = new Database(":memory:");
    for (const sql of planCreate(prepareCollection(TRANSLATIONS_COLLECTION, null))) sqlite.run(sql);
    sqlite.run("CREATE TABLE `posts` (id TEXT PRIMARY KEY, title TEXT, body TEXT)");
    for (const p of POSTS) sqlite.run("INSERT INTO `posts` (id, title, body) VALUES (?, ?, ?)", [String(p.id), String(p.title), String(p.body)]);
    for (const t of [...TRANSLATIONS, { collection: "posts", record: "gone", field: "title", locale: "ar", value: "orphan" }]) sqlite.run("INSERT INTO `translations` (id, collection, record, field, locale, value, created, updated) VALUES (?, ?, ?, ?, ?, ?, '', '')", [`${t.record}${t.field}${t.locale}`, t.collection, t.record, t.field, t.locale, t.value]);
    expect(() => sqlite.run("INSERT INTO `translations` (id, collection, record, field, locale, value, created, updated) VALUES ('dup', 'posts', 'p1', 'title', 'ar', 'again', '', '')")).toThrow(/UNIQUE/);
    const env = { DB: d1(sqlite) } as Bindings;
    const posts = COLLECTIONS[1]!;
    const found = await dbSource.translations(env, ["p1", "p2", "nope"], ["ar"]);
    expect(found.map((t) => `${t.record}.${t.field}=${t.value}`).sort()).toEqual(["p1.body=", "p1.title=مرحبا", "p2.title=عنوان"]);
    expect(await dbSource.translations(env, [], ["ar"])).toEqual([]);
    expect(await dbSource.recordIds(env, posts, 2, 2)).toEqual({ ids: ["p3"], totalItems: 3 });
    // the empty ar body and the orphan (its record is gone) are not counted
    expect(await dbSource.counts(env, posts, ["title", "body"])).toEqual({ records: 3, translated: { ar: 2, fr: 2 } });
    expect(await dbSource.counts(env, posts, [])).toEqual({ records: 3, translated: {} });
    sqlite.close();
  });
});
