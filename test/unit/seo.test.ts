// The seo plugin: robots.txt, a sitemap generated from public records, and llms.txt, from an injected source.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { provideAuthLookup } from "../../src/server/auth-slot";
import type { Collection } from "../../src/server/collections/model";
import { ApiError } from "../../src/server/errors";
import { createKernel, load } from "../../src/server/kernel";
import { auth, provider } from "../../src/server/plugins/auth";
import { locOf, parseSitemap, seo, seoWith, type SeoSource } from "../../src/server/plugins/seo";
import type { AppEnv, Bindings } from "../../src/server/types";

// the collections: a public one with a slug and updated, a locked one, a view with a public list rule
const f = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ id: `f_${name}`, name, type, system: false, hidden: false, presentable: false, required: false, help: "", ...extra });
const collection = (name: string, type: Collection["type"], rules: Partial<Pick<Collection, "listRule" | "viewRule">>, fields: Record<string, unknown>[]): Collection =>
  ({ id: `c_${name}`, name, type, system: false, fields: fields as Collection["fields"], indexes: [], options: {}, created: "", updated: "", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, ...rules }) as Collection;
const COLLECTIONS: Collection[] = [
  collection("posts", "base", { listRule: "", viewRule: "" }, [f("id", "text", { primaryKey: true, system: true }), f("title", "text"), f("slug", "text"), f("status", "select", { values: ["draft", "live"] }), f("token", "text", { hidden: true }), f("updated", "autodate")]),
  collection("secrets", "base", {}, [f("id", "text", { primaryKey: true, system: true }), f("slug", "text")]),
  collection("pages", "base", { listRule: "", viewRule: "" }, [f("id", "text", { primaryKey: true, system: true }), f("slug", "text")]),
];
const POSTS = [
  { id: "p1", slug: "hello-world", status: "live", updated: "2026-09-01 10:20:30.456Z" },
  { id: "p2", slug: "a b/c&d", status: "live", updated: "" },
  { id: "p3", slug: "draft-one", status: "draft", updated: "2026-09-02 00:00:00.000Z" },
  { id: "p4", slug: "", status: "live", updated: "2026-09-03 00:00:00.000Z" },
];
const PAGES = [{ id: "g1", slug: "about", updated: "2026-08-01 00:00:00.000Z" }];

/** a records source over the fixtures; a filter is matched on `field="value"` only, which is all these tests use */
const records: SeoSource["records"] = async (_env, c, filter, limit) => {
  const rows = c.name === "posts" ? POSTS : c.name === "pages" ? PAGES : [];
  const m = /^(\w+)\s*=\s*"([^"]*)"$/.exec(filter.trim());
  if (filter.trim() && !m) throw new ApiError(400, "bad filter");
  return rows.filter((r) => !m || String((r as Record<string, unknown>)[m[1]!]) === m[2]).slice(0, limit);
};
const seen: { collection: string; filter: string; limit: number }[] = [];
const spySource: Partial<SeoSource> = { collections: async () => COLLECTIONS, appName: async () => "Shop", records: async (env, c, filter, limit) => { seen.push({ collection: c.name, filter, limit }); return records(env, c, filter, limit); } };

async function appWith(env: Record<string, unknown> = {}, plugin = seoWith(spySource)) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("auth", null); await next(); });
  app.onError((err, c) => (err instanceof ApiError ? c.json({ message: err.message }, err.status as 400) : c.json({ message: String(err) }, 500)));
  const kernel = createKernel(app);
  await load(kernel, [auth, plugin], "0.9.0");
  provideAuthLookup(() => provider);
  const get = async (path: string) => { const r = await app.request(`http://shop.example${path}`, {}, env as unknown as Bindings); return { r, text: await r.text() }; };
  return { app, get };
}
const locs = (xml: string) => [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);

let warn: ReturnType<typeof spyOn> | null = null;
const quiet = () => { warn = spyOn(console, "warn").mockImplementation(() => {}); return warn; };
const warned = () => (warn?.mock.calls ?? []).map((c) => String(c[0])).join("\n");
afterEach(() => { warn?.mockRestore(); warn = null; seen.length = 0; });

describe("robots.txt", () => {
  test("by default: everything allowed but the panel and the API, and the sitemap at the request origin", async () => {
    const { get } = await appWith();
    const { r, text } = await get("/robots.txt");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/plain/);
    expect(r.headers.get("cache-control")).toBe("public, max-age=300");
    expect(text).toBe("User-agent: *\nDisallow: /_/\nDisallow: /api/\n\nSitemap: http://shop.example/sitemap.xml\n");
  });

  test("VOIDBASE_ROBOTS_DISALLOW adds paths, VOIDBASE_SITE_URL sets the sitemap's host", async () => {
    const { get } = await appWith({ VOIDBASE_ROBOTS_DISALLOW: "/drafts/, admin , /api/", VOIDBASE_SITE_URL: "https://www.shop.example/" });
    const { text } = await get("/robots.txt");
    expect(text).toBe("User-agent: *\nDisallow: /_/\nDisallow: /api/\nDisallow: /drafts/\nDisallow: /admin\n\nSitemap: https://www.shop.example/sitemap.xml\n");
  });

  test("a robots.txt in the static files wins over the generated one; an HTML shell answering a miss does not", async () => {
    const assets = { fetch: async (req: Request) => new URL(req.url).pathname === "/robots.txt" ? new Response("User-agent: *\nDisallow: /mine/\n", { headers: { "content-type": "text/plain" } }) : new Response("<html>shell</html>", { status: 200, headers: { "content-type": "text/html" } }) };
    const { get } = await appWith({ ASSETS: assets });
    expect((await get("/robots.txt")).text).toBe("User-agent: *\nDisallow: /mine/\n");
    const llms = await get("/llms.txt");
    expect(llms.text).toContain("# Shop");
    expect(llms.text).not.toContain("shell");
  });
});

describe("sitemap.xml", () => {
  test("without VOIDBASE_SITEMAP it lists only /", async () => {
    const { get } = await appWith();
    const { r, text } = await get("/sitemap.xml");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/application\/xml/);
    expect(r.headers.get("cache-control")).toBe("public, max-age=300");
    expect(text).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(text).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(locs(text)).toEqual(["http://shop.example/"]);
    expect(seen).toEqual([]);
  });

  test("a pattern per collection: one url per record, {field} substituted and encoded, lastmod from updated", async () => {
    const { get } = await appWith({ VOIDBASE_SITEMAP: "posts:/blog/{slug},pages:/{slug}", VOIDBASE_SITE_URL: "https://shop.example" });
    const { text } = await get("/sitemap.xml");
    expect(locs(text)).toEqual(["https://shop.example/", "https://shop.example/blog/hello-world", "https://shop.example/blog/a%20b%2Fc%26d", "https://shop.example/blog/draft-one", "https://shop.example/about"]);
    expect(text).toContain("<url><loc>https://shop.example/blog/hello-world</loc><lastmod>2026-09-01T10:20:30.456Z</lastmod></url>");
    // an empty updated has no lastmod; an empty slug is no url at all
    expect(text).toContain("<url><loc>https://shop.example/blog/a%20b%2Fc%26d</loc></url>");
    expect(text).not.toContain("/blog/</loc>");
    expect(seen.map((s) => s.collection)).toEqual(["posts", "pages"]);
    expect(seen[0]!.limit).toBe(50000);
    expect(seen[1]!.limit).toBe(50000 - 3);
  });

  test("a filter per entry goes to the records source; a filter that fails skips the entry with a warning", async () => {
    quiet();
    const { get } = await appWith({ VOIDBASE_SITEMAP: 'posts[status="live"]:/blog/{slug}, pages[broken]:/{slug}' });
    const { r, text } = await get("/sitemap.xml");
    expect(r.status).toBe(200);
    expect(locs(text)).toEqual(["http://shop.example/", "http://shop.example/blog/hello-world", "http://shop.example/blog/a%20b%2Fc%26d"]);
    expect(seen[0]).toMatchObject({ collection: "posts", filter: 'status="live"' });
    expect(warned()).toContain("could not be listed");
  });

  test("a collection that is not publicly listable, or does not exist, is skipped with a warning", async () => {
    const w = quiet();
    const { get } = await appWith({ VOIDBASE_SITEMAP: "secrets:/s/{slug},nothing:/n/{id},posts:/blog/{slug}" });
    const { text } = await get("/sitemap.xml");
    expect(locs(text)).toContain("http://shop.example/blog/hello-world");
    expect(locs(text).some((l) => l!.includes("/s/"))).toBe(false);
    expect(seen.map((s) => s.collection)).toEqual(["posts"]);
    expect(w).toHaveBeenCalledTimes(2);
    expect(warned()).toContain("secrets");
    expect(warned()).toContain("not publicly listable");
    expect(warned()).toContain("nothing");
  });

  test("the entry grammar: commas inside a filter, a malformed entry skipped", () => {
    quiet();
    expect(parseSitemap('posts[status="live" && tags ?~ "a,b"]:/blog/{slug}, pages:/{slug}')).toEqual([
      { collection: "posts", filter: 'status="live" && tags ?~ "a,b"', pattern: "/blog/{slug}" },
      { collection: "pages", filter: "", pattern: "/{slug}" },
    ]);
    expect(parseSitemap("posts:blog/{slug},pages")).toEqual([]);
    expect(warned()).toContain("VOIDBASE_SITEMAP entry skipped");
    expect(locOf("https://x", "/{a}/{b}", { a: "1", b: ["x", "y"] })).toBe("https://x/1/x%2Cy");
    expect(locOf("https://x", "/{a}", { a: null })).toBeNull();
  });
});

describe("llms.txt", () => {
  test("the name, the site, the public collections with their fields, the endpoints and the scopes", async () => {
    const { get } = await appWith({ VOIDBASE_SITE_URL: "https://shop.example" });
    const { r, text } = await get("/llms.txt");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/plain/);
    expect(text.startsWith("# Shop\n")).toBe(true);
    expect(text).toContain("https://shop.example");
    expect(text).toContain("- posts (base): id (text), title (text), slug (text), status (select), updated (autodate)");
    expect(text).toContain("- pages (base): id (text), slug (text)");
    expect(text).not.toContain("secrets");
    expect(text).not.toContain("token (text)");
    for (const p of ["/api/openapi.json", "/api/docs", "/api/mcp"]) expect(text).toContain(`https://shop.example${p}`);
    expect(text).toMatch(/^Scopes: no token .* a user's token .* a superuser's token .*$/m);
    expect(text).not.toContain("## Notes");
  });

  test("VOIDBASE_LLMS_NOTE appends a paragraph; an instance without a name is voidbase", async () => {
    const { get } = await appWith({ VOIDBASE_LLMS_NOTE: "Ask before scraping the gallery." }, seoWith({ ...spySource, appName: async () => " " }));
    const { text } = await get("/llms.txt");
    expect(text.startsWith("# voidbase\n")).toBe(true);
    expect(text.endsWith("## Notes\n\nAsk before scraping the gallery.\n")).toBe(true);
  });
});

describe("the shipped plugin", () => {
  test("is official, called seo, and reads the collections through the database", async () => {
    expect(seo.manifest).toMatchObject({ name: "seo", tier: "official" });
    const { invalidateCollections } = await import("../../src/server/collections/model");
    const { invalidateSettings } = await import("../../src/server/settings");
    invalidateCollections(); invalidateSettings();
    const rows = COLLECTIONS.map((c) => ({ ...c, system: 0, fields: JSON.stringify(c.fields), indexes: "[]", options: "{}" }));
    const db = { prepare: (sql: string) => ({ bind: () => ({
      all: async () => ({ results: /_collections/.test(sql) ? rows : [] }),
      first: async () => (/_params/.test(sql) ? { value: JSON.stringify({ meta: { appName: "From the row" } }) } : null),
    }) }) } as unknown as D1Database;
    const { get } = await appWith({ DB: db }, seo);
    const { text } = await get("/llms.txt");
    expect(text.startsWith("# From the row\n")).toBe(true);
    expect(text).toContain("- posts (base)");
    invalidateCollections(); invalidateSettings();
  });
});
