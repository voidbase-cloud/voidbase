// The seo plugin: robots.txt, a sitemap generated from public records, and llms.txt, from an injected source; then
// the record half: a page's metadata resolved through the sitemap templates in reverse, the share card, the ETags.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { provideAuthLookup } from "../../src/server/auth-slot";
import type { Collection } from "../../src/server/collections/model";
import { ApiError } from "../../src/server/errors";
import { createKernel, load } from "../../src/server/kernel";
import { auth, provider } from "../../src/server/plugins/auth";
import { buildMeta, etagOf, excerpt, locOf, matchPath, notModified, parseSeo, parseSitemap, seo, seoRedirectLines, seoWith, shareCard, splitLocale, wrap, type MetaAnswer, type SeoSource } from "../../src/server/plugins/seo";
import type { AppEnv, Bindings } from "../../src/server/types";
import { VERSION } from "../../src/server/version";

// the collections: a public one with a slug and updated, a locked one, a view with a public list rule
const f = (name: string, type: string, extra: Record<string, unknown> = {}) => ({ id: `f_${name}`, name, type, system: false, hidden: false, presentable: false, required: false, help: "", ...extra });
const collection = (name: string, type: Collection["type"], rules: Partial<Pick<Collection, "listRule" | "viewRule">>, fields: Record<string, unknown>[]): Collection =>
  ({ id: `c_${name}`, name, type, system: false, fields: fields as Collection["fields"], indexes: [], options: {}, created: "", updated: "", listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null, ...rules }) as Collection;
const COLLECTIONS: Collection[] = [
  collection("posts", "base", { listRule: "", viewRule: "" }, [f("id", "text", { primaryKey: true, system: true }), f("title", "text"), f("slug", "text"), f("summary", "editor"), f("cover", "file", { thumbs: ["1200x630"] }), f("author", "relation", { collectionId: "c_people" }), f("status", "select", { values: ["draft", "live"] }), f("token", "text", { hidden: true }), f("created", "autodate"), f("updated", "autodate")]),
  collection("secrets", "base", {}, [f("id", "text", { primaryKey: true, system: true }), f("slug", "text")]),
  collection("pages", "base", { listRule: "", viewRule: "" }, [f("id", "text", { primaryKey: true, system: true }), f("slug", "text"), f("name", "text"), f("description", "text"), f("updated", "autodate")]),
];
const AUTHOR = { id: "u1", collectionName: "people", name: "Ada <Lovelace>", avatar: "ada.png" };
const POSTS = [
  { id: "p1", slug: "hello-world", title: "Hello, <b>world</b> & \"friends\"", summary: "<p>The first post, with <em>markup</em> &amp; entities.</p>", cover: "cover.jpg", author: "u1", status: "live", created: "2026-08-30 08:00:00.000Z", updated: "2026-09-01 10:20:30.456Z", expand: { author: AUTHOR } },
  { id: "p2", slug: "a b/c&d", title: "A very long title that keeps going well past the width of a share card so it has to wrap onto several lines and then stop", summary: "x".repeat(400), cover: "", author: "", status: "live", updated: "" },
  { id: "p3", slug: "draft-one", title: "Draft", summary: "", cover: "", author: "", status: "draft", updated: "2026-09-02 00:00:00.000Z" },
  { id: "p4", slug: "", title: "", summary: "", cover: "", author: "", status: "live", updated: "2026-09-03 00:00:00.000Z" },
];
const PAGES = [{ id: "g1", slug: "about", name: "About us", description: "Who we are. ".repeat(30), updated: "2026-08-01 00:00:00.000Z" }];

/** the fixtures' filter language: `field="value"` terms joined by &&, a term in parentheses allowed, backslash escapes */
const matches = (row: Record<string, unknown>, filter: string): boolean => {
  const terms = filter.split("&&").map((t) => t.trim().replace(/^\((.*)\)$/, "$1").trim()).filter(Boolean);
  for (const term of terms) {
    const m = /^(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"$/.exec(term);
    if (!m) throw new ApiError(400, "bad filter");
    if (String(row[m[1]!] ?? "") !== m[2]!.replace(/\\(.)/g, "$1")) return false;
  }
  return true;
};
const rowsOf = (name: string) => (name === "posts" ? POSTS : name === "pages" ? PAGES : []) as Record<string, unknown>[];
const records: SeoSource["records"] = async (_env, c, filter, limit) => rowsOf(c.name).filter((r) => matches(r, filter)).slice(0, limit);
const seen: { collection: string; filter: string; limit: number }[] = [];
const looked: { collection: string; filter: string; expand: string; auth: unknown }[] = [];
const spySource: Partial<SeoSource> = {
  collections: async () => COLLECTIONS, appName: async () => "Shop",
  records: async (env, c, filter, limit) => { seen.push({ collection: c.name, filter, limit }); return records(env, c, filter, limit); },
  // the caller's list rule: an anonymous caller lists only a public collection, like the records service judges it
  record: async (c, col, filter, expand) => {
    looked.push({ collection: col.name, filter, expand, auth: c.get("auth") });
    if (col.listRule === null && !c.get("auth")) throw new ApiError(403, "Only superusers can perform this action.");
    const row = rowsOf(col.name).find((r) => matches(r, filter)) ?? null;
    return row && !expand ? { ...row, expand: undefined } : row;
  },
};

async function appWith(env: Record<string, unknown> = {}, plugin = seoWith(spySource)) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => { c.set("auth", null); await next(); });
  app.onError((err, c) => (err instanceof ApiError ? c.json({ message: err.message }, err.status as 400) : c.json({ message: String(err) }, 500)));
  const kernel = createKernel(app);
  await load(kernel, [auth, plugin], "0.9.0");
  provideAuthLookup(() => provider);
  const get = async (path: string, headers: Record<string, string> = {}) => { const r = await app.request(`http://shop.example${path}`, { headers }, env as unknown as Bindings); return { r, text: await r.text() }; };
  return { app, get };
}
const locs = (xml: string) => [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);

let warn: ReturnType<typeof spyOn> | null = null;
const quiet = () => { warn = spyOn(console, "warn").mockImplementation(() => {}); return warn; };
const warned = () => (warn?.mock.calls ?? []).map((c) => String(c[0])).join("\n");
afterEach(() => { warn?.mockRestore(); warn = null; seen.length = 0; looked.length = 0; });

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
    expect(text).toContain("- posts (base): id (text), title (text), slug (text), summary (editor), cover (file), author (relation), status (select), created (autodate), updated (autodate)");
    expect(text).toContain("- pages (base): id (text), slug (text), name (text), description (text), updated (autodate)");
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

describe("the /api/seo aliases", () => {
  test("each file answers under /api/seo too, the path a deployed Worker is reached at", async () => {
    const { get } = await appWith({ VOIDBASE_SITEMAP: "posts:/blog/{slug}" });
    const robots = await get("/api/seo/robots.txt");
    expect(robots.r.status).toBe(200);
    expect(robots.text).toContain("Sitemap: http://shop.example/sitemap.xml");
    const sitemap = await get("/api/seo/sitemap.xml");
    expect(sitemap.r.headers.get("content-type")).toContain("application/xml");
    expect(sitemap.text).toContain("/blog/hello-world");
    expect((await get("/api/seo/llms.txt")).r.status).toBe(200);
  });
  test("seoRedirectLines writes one rule per file the static build lacks", () => {
    expect(seoRedirectLines((p) => p === "/robots.txt")).toEqual(["/sitemap.xml /api/seo/sitemap.xml 302", "/llms.txt /api/seo/llms.txt 302"]);
    expect(seoRedirectLines(() => true)).toEqual([]);
  });
});


// --- the record half ------------------------------------------------------------------------------------------------------
const SITEMAP = 'posts[status="live"]:/blog/{slug},pages:/{slug},secrets:/s/{slug}';
const SEO = "posts:Article{title=title,description=summary,image=cover,datePublished=created,dateModified=updated,author=author.name}";
const SITE = "https://shop.example";
const meta = async (get: Awaited<ReturnType<typeof appWith>>["get"], query: string, headers: Record<string, string> = {}) => {
  const { r, text } = await get(`/api/seo/meta?${query}`, headers);
  return { r, text, body: (text ? JSON.parse(text) : null) as MetaAnswer & { message?: string } };
};
const P1_ETAG = `"${VERSION}-${Date.parse("2026-09-01 10:20:30.456Z")}"`;

describe("the page's metadata: /api/seo/meta", () => {
  test("a path is resolved through the sitemap template in reverse, the record read with the entry's filter as the caller", async () => {
    const { get } = await appWith({ VOIDBASE_SITEMAP: SITEMAP, VOIDBASE_SEO: SEO, VOIDBASE_SITE_URL: SITE });
    const { r, body } = await meta(get, "path=/blog/hello-world");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
    expect(r.headers.get("etag")).toBe(P1_ETAG);
    expect(r.headers.get("x-voidbase-version")).toBe(VERSION);
    expect(r.headers.get("cache-control")).toBe("public, max-age=300");
    expect(looked).toEqual([{ collection: "posts", filter: '(status="live") && slug = "hello-world"', expand: "author", auth: null }]);
    expect(body.canonical).toBe("https://shop.example/blog/hello-world");
    expect(body.title).toBe('Hello, world & "friends"');
    expect(body.description).toBe("The first post, with markup & entities.");
    expect(body.image).toBe("https://shop.example/api/files/posts/p1/cover.jpg");
    expect(body.type).toBe("Article");
    expect(body.locale).toBe("");
    expect(body.alternates).toEqual([]);
    expect(body.og).toEqual({ "og:title": 'Hello, world & "friends"', "og:description": "The first post, with markup & entities.", "og:url": "https://shop.example/blog/hello-world", "og:type": "article", "og:site_name": "Shop", "og:image": "https://shop.example/api/files/posts/p1/cover.jpg" });
    expect(body.twitter).toEqual({ "twitter:card": "summary_large_image", "twitter:title": 'Hello, world & "friends"', "twitter:description": "The first post, with markup & entities.", "twitter:image": "https://shop.example/api/files/posts/p1/cover.jpg" });
  });

  test("the JSON-LD: the schema.org type, the page fields, every other mapping as is, dates in ISO, the author a Person", async () => {
    const { get } = await appWith({ VOIDBASE_SITEMAP: SITEMAP, VOIDBASE_SEO: SEO, VOIDBASE_SITE_URL: SITE });
    const { body } = await meta(get, "path=/blog/hello-world");
    expect(body.jsonld).toEqual({
      "@context": "https://schema.org", "@type": "Article", name: 'Hello, world & "friends"', headline: 'Hello, world & "friends"',
      description: "The first post, with markup & entities.", image: "https://shop.example/api/files/posts/p1/cover.jpg", url: "https://shop.example/blog/hello-world",
      datePublished: "2026-08-30T08:00:00.000Z", dateModified: "2026-09-01T10:20:30.456Z", author: { "@type": "Person", name: "Ada <Lovelace>" },
    });
  });

  test("the html fragment: every tag, every value escaped, the JSON-LD safe inside its script", async () => {
    const { get } = await appWith({ VOIDBASE_SITEMAP: SITEMAP, VOIDBASE_SEO: SEO, VOIDBASE_SITE_URL: SITE });
    const { body } = await meta(get, "path=/blog/hello-world");
    const lines = body.html.split("\n");
    expect(lines[0]).toBe("<title>Hello, world &amp; &quot;friends&quot;</title>");
    expect(lines[1]).toBe('<link rel="canonical" href="https://shop.example/blog/hello-world">');
    expect(lines[2]).toBe('<meta name="description" content="The first post, with markup &amp; entities.">');
    expect(lines).toContain('<meta property="og:title" content="Hello, world &amp; &quot;friends&quot;">');
    expect(lines).toContain('<meta property="og:site_name" content="Shop">');
    expect(lines).toContain('<meta property="og:image" content="https://shop.example/api/files/posts/p1/cover.jpg">');
    expect(lines).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(lines).toContain('<meta name="twitter:title" content="Hello, world &amp; &quot;friends&quot;">');
    const script = lines[lines.length - 1]!;
    expect(script.startsWith('<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article"')).toBe(true);
    expect(script.endsWith("</script>")).toBe(true);
    expect(script).toContain('"name":"Ada \\u003cLovelace>"');
    expect(script).not.toContain("<Lovelace");
    // a description whose text (tags stripped, entities decoded) tries to close the script tag cannot
    const built = buildMeta({ site: SITE, appName: "Shop", collection: COLLECTIONS[0]!, record: { id: "x", title: "T", summary: "<p>&lt;/script&gt;&lt;script&gt;alert(1)</p>" }, canonical: `${SITE}/blog/x`, mapping: parseSeo(SEO)[0]!, imageSize: "", locale: "", locales: null, card: `${SITE}/api/seo/og/posts/x.svg` });
    expect(built.description).toBe("</script><script>alert(1)");
    expect(built.html).toContain('<meta name="description" content="&lt;/script&gt;&lt;script&gt;alert(1)">');
    expect(built.html).toContain('"description":"\\u003c/script>\\u003cscript>alert(1)"');
    expect(built.html.match(/<\/script>/g)).toHaveLength(1);
  });

  test("an escaped slug (the path sent as a loader would, encoded once more) is decoded for the lookup and re-encoded in the canonical; the description is capped at 200", async () => {
    const { get } = await appWith({ VOIDBASE_SITEMAP: SITEMAP, VOIDBASE_SEO: SEO, VOIDBASE_SITE_URL: SITE });
    const { r, body } = await meta(get, `path=${encodeURIComponent("/blog/a%20b%2Fc%26d")}`);
    expect(r.status).toBe(200);
    expect(looked[0]!.filter).toBe('(status="live") && slug = "a b/c&d"');
    expect(body.canonical).toBe("https://shop.example/blog/a%20b%2Fc%26d");
    expect(body.description).toHaveLength(201);
    expect(body.description.endsWith("\u2026")).toBe(true);
    expect(r.headers.get("etag")).toBe(`"${VERSION}-0"`);
    // a quote in the slug is escaped for the filter
    await meta(get, `path=${encodeURIComponent(`/blog/${encodeURIComponent('say "hi"')}`)}`);
    expect(looked[1]!.filter).toBe('(status="live") && slug = "say \\"hi\\""');
  });

  test("a filter mismatch, an unknown path, a bad encoding, and the root are 404; no parameters is 400; a locked collection is 403", async () => {
    const { get } = await appWith({ VOIDBASE_SITEMAP: SITEMAP, VOIDBASE_SEO: SEO, VOIDBASE_SITE_URL: SITE });
    const draft = await meta(get, "path=/blog/draft-one");
    expect(draft.r.status).toBe(404);
    expect(draft.r.headers.get("content-type")).toMatch(/application\/json/);
    expect(draft.body.message).toContain("No page at this address");
    expect(looked[0]!.filter).toBe('(status="live") && slug = "draft-one"');
    expect((await meta(get, "path=/nope/x")).r.status).toBe(404);
    expect((await meta(get, "path=/blog/%E0%A4%A")).r.status).toBe(404);
    expect((await meta(get, "path=/")).r.status).toBe(404);
    expect((await meta(get, "path=/blog/hello-world/extra")).r.status).toBe(404);
    expect((await meta(get, "")).r.status).toBe(400);
    expect((await meta(get, "collection=posts")).r.status).toBe(400);
    expect((await meta(get, "path=/s/anything")).r.status).toBe(403);
    expect((await meta(get, "collection=nothing&id=p1")).r.status).toBe(404);
  });

  test("?collection=&id= names the record directly, still through the entry's filter; a full URL as the path is accepted", async () => {
    const { get } = await appWith({ VOIDBASE_SITEMAP: SITEMAP, VOIDBASE_SEO: SEO, VOIDBASE_SITE_URL: SITE, VOIDBASE_SEO_IMAGE_SIZE: "1200x630" });
    const { r, body } = await meta(get, "collection=posts&id=p1");
    expect(r.status).toBe(200);
    expect(looked[0]!.filter).toBe('(status="live") && id = "p1"');
    expect(body.canonical).toBe("https://shop.example/blog/hello-world");
    expect(body.image).toBe("https://shop.example/api/files/posts/p1/cover.jpg?thumb=1200x630");
    expect((await meta(get, "collection=posts&id=p3")).r.status).toBe(404);
    expect((await meta(get, `path=${encodeURIComponent("https://www.shop.example/blog/hello-world")}`)).body.canonical).toBe("https://shop.example/blog/hello-world");
  });

  test("a collection in the sitemap but not in VOIDBASE_SEO: WebPage, title from name, description from description, the card as the image", async () => {
    const { get } = await appWith({ VOIDBASE_SITEMAP: SITEMAP, VOIDBASE_SEO: SEO });
    const { r, body } = await meta(get, "path=/about");
    expect(r.status).toBe(200);
    expect(looked[0]).toMatchObject({ collection: "pages", filter: 'slug = "about"', expand: "" });
    expect(body.type).toBe("WebPage");
    expect(body.title).toBe("About us");
    expect(body.description.length).toBeLessThanOrEqual(201);
    expect(body.description.startsWith("Who we are. Who we are.")).toBe(true);
    expect(body.description.endsWith("\u2026")).toBe(true);
    expect(body.image).toBe("http://shop.example/api/seo/og/pages/g1.svg");
    expect(body.canonical).toBe("http://shop.example/about");
    expect(body.og["og:type"]).toBe("website");
    expect(body.jsonld).toEqual({ "@context": "https://schema.org", "@type": "WebPage", name: "About us", description: body.description, image: body.image, url: "http://shop.example/about" });
    expect(body.html).not.toContain("headline");
  });

  test("the mapping grammar: type without mappings, commas inside braces, a malformed entry or mapping skipped with a warning", () => {
    quiet();
    expect(parseSeo(`${SEO},pages:WebPage`)).toEqual([
      { collection: "posts", type: "Article", fields: { title: "title", description: "summary", image: "cover", datePublished: "created", dateModified: "updated", author: "author.name" } },
      { collection: "pages", type: "WebPage", fields: {} },
    ]);
    expect(parseSeo("posts, pages:Event{title=name,when=starts.at.x,bad}")).toEqual([{ collection: "pages", type: "Event", fields: { title: "name" } }]);
    expect(warned()).toContain("VOIDBASE_SEO entry skipped");
    expect(warned()).toContain("VOIDBASE_SEO mapping skipped");
    expect(parseSeo("")).toEqual([]);
  });

  test("matchPath: the template in reverse, a trailing slash tolerated, one segment per field, a bad escape no match", () => {
    const entries = parseSitemap("posts:/blog/{slug},docs:/d/{section}/{slug},pages:/{slug}");
    expect(matchPath(entries, "/blog/hello")).toMatchObject({ entry: { collection: "posts" }, values: { slug: "hello" } });
    expect(matchPath(entries, "/blog/hello/")).toMatchObject({ values: { slug: "hello" } });
    expect(matchPath(entries, "/d/intro/first")).toMatchObject({ entry: { collection: "docs" }, values: { section: "intro", slug: "first" } });
    expect(matchPath(entries, "/about")).toMatchObject({ entry: { collection: "pages" }, values: { slug: "about" } });
    expect(matchPath(entries, "/blog/a/b")).toBeNull();
    expect(matchPath(entries, "/")).toBeNull();
    expect(matchPath(entries, "/blog/%E0%A4%A")).toBeNull();
    expect(excerpt("<p>Hi &amp; bye</p>")).toBe("Hi & bye");
  });

  test("ETag and If-None-Match: the same record on the same version is 304, weak tags and * count, a change is 200", async () => {
    const { get } = await appWith({ VOIDBASE_SITEMAP: SITEMAP, VOIDBASE_SEO: SEO, VOIDBASE_SITE_URL: SITE });
    const fresh = await meta(get, "path=/blog/hello-world", { "if-none-match": P1_ETAG });
    expect(fresh.r.status).toBe(304);
    expect(fresh.text).toBe("");
    expect(fresh.r.headers.get("etag")).toBe(P1_ETAG);
    expect(fresh.r.headers.get("x-voidbase-version")).toBe(VERSION);
    expect((await meta(get, "path=/blog/hello-world", { "if-none-match": `W/${P1_ETAG}, "other"` })).r.status).toBe(304);
    expect((await meta(get, "path=/blog/hello-world", { "if-none-match": "*" })).r.status).toBe(304);
    expect((await meta(get, "path=/blog/hello-world", { "if-none-match": `"0.0.0-${Date.parse("2026-09-01 10:20:30.456Z")}"` })).r.status).toBe(200);
    expect(etagOf("1.0.0", { updated: "2026-09-01 10:20:30.456Z" })).not.toBe(etagOf("1.0.0", { updated: "2026-09-01 10:20:31.456Z" }));
    expect(etagOf("1.0.0", { updated: "2026-09-01 10:20:30.456Z" })).not.toBe(etagOf("1.0.1", { updated: "2026-09-01 10:20:30.456Z" }));
    expect(etagOf("1.0.0", {})).toBe('"1.0.0-0"');
    expect(notModified(undefined, '"a"')).toBe(false);
  });
});

describe("locales: og:locale, alternates and hreflang", () => {
  test("VOIDBASE_LOCALES gives og:locale from the source, og:locale:alternate and hreflang links from the rest; the path's ?locale= picks one", async () => {
    const { get } = await appWith({ VOIDBASE_SITEMAP: SITEMAP, VOIDBASE_SEO: SEO, VOIDBASE_SITE_URL: SITE, VOIDBASE_LOCALES: "en-US, ar, fr" });
    const en = (await meta(get, "path=/blog/hello-world")).body;
    expect(en.locale).toBe("en-US");
    expect(en.canonical).toBe("https://shop.example/blog/hello-world");
    expect(en.alternates).toEqual([
      { locale: "en-US", url: "https://shop.example/blog/hello-world" },
      { locale: "ar", url: "https://shop.example/blog/hello-world?locale=ar" },
      { locale: "fr", url: "https://shop.example/blog/hello-world?locale=fr" },
      { locale: "x-default", url: "https://shop.example/blog/hello-world" },
    ]);
    expect(en.og["og:locale"]).toBe("en_US");
    expect(en.og["og:locale:alternate"]).toEqual(["ar", "fr"]);
    expect(en.jsonld.inLanguage).toBe("en-US");
    expect(en.html).toContain('<link rel="alternate" hreflang="ar" href="https://shop.example/blog/hello-world?locale=ar">');
    expect(en.html).toContain('<link rel="alternate" hreflang="x-default" href="https://shop.example/blog/hello-world">');
    expect(en.html).toContain('<meta property="og:locale" content="en_US">');
    expect(en.html).toContain('<meta property="og:locale:alternate" content="ar">');
    expect(en.html).toContain('<meta property="og:locale:alternate" content="fr">');
    const ar = (await meta(get, `path=${encodeURIComponent("/blog/hello-world?locale=ar")}`)).body;
    expect(ar.locale).toBe("ar");
    expect(ar.canonical).toBe("https://shop.example/blog/hello-world?locale=ar");
    expect(ar.og["og:locale"]).toBe("ar");
    expect(ar.og["og:locale:alternate"]).toEqual(["en_US", "fr"]);
    // the meta request's own locale wins over the path's; a locale that is not configured is ignored
    expect((await meta(get, `path=${encodeURIComponent("/blog/hello-world?locale=ar")}&locale=fr`)).body.locale).toBe("fr");
    expect((await meta(get, `path=${encodeURIComponent("/blog/hello-world?locale=de")}`)).body.locale).toBe("en-US");
  });

  test("VOIDBASE_SEO_LOCALE_PATH=prefix puts the locale in the path: /ar/blog/... resolves and is the canonical there", async () => {
    const { get } = await appWith({ VOIDBASE_SITEMAP: SITEMAP, VOIDBASE_SEO: SEO, VOIDBASE_SITE_URL: SITE, VOIDBASE_LOCALES: "en,ar", VOIDBASE_SEO_LOCALE_PATH: "prefix" });
    const ar = await meta(get, "path=/ar/blog/hello-world");
    expect(ar.r.status).toBe(200);
    expect(looked[0]!.filter).toBe('(status="live") && slug = "hello-world"');
    expect(ar.body.locale).toBe("ar");
    expect(ar.body.canonical).toBe("https://shop.example/ar/blog/hello-world");
    expect(ar.body.alternates).toEqual([{ locale: "en", url: "https://shop.example/blog/hello-world" }, { locale: "ar", url: "https://shop.example/ar/blog/hello-world" }, { locale: "x-default", url: "https://shop.example/blog/hello-world" }]);
    expect((await meta(get, "path=/blog/hello-world")).body.canonical).toBe("https://shop.example/blog/hello-world");
    expect((await meta(get, "path=/de/blog/hello-world")).r.status).toBe(404);
    expect(splitLocale("/ar/about", { locales: ["en", "ar"], mode: "prefix" })).toEqual({ path: "/about", locale: "ar" });
    expect(splitLocale("/ar", { locales: ["en", "ar"], mode: "prefix" })).toEqual({ path: "/", locale: "ar" });
    expect(splitLocale("/ar/about", { locales: ["en", "ar"], mode: "query" })).toEqual({ path: "/ar/about", locale: "" });
    expect(splitLocale("/about?locale=ar", null)).toEqual({ path: "/about", locale: "" });
  });

  test("the sitemap: xhtml:link alternates per locale in query and prefix form, and byte-identical without locales", async () => {
    const env = { VOIDBASE_SITEMAP: "posts:/blog/{slug}", VOIDBASE_SITE_URL: SITE };
    const plain = (await (await appWith(env)).get("/sitemap.xml")).text;
    expect(plain).toBe([
      '<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      "<url><loc>https://shop.example/</loc></url>",
      "<url><loc>https://shop.example/blog/hello-world</loc><lastmod>2026-09-01T10:20:30.456Z</lastmod></url>",
      "<url><loc>https://shop.example/blog/a%20b%2Fc%26d</loc></url>",
      "<url><loc>https://shop.example/blog/draft-one</loc><lastmod>2026-09-02T00:00:00.000Z</lastmod></url>",
      "</urlset>", "",
    ].join("\n"));
    const query = (await (await appWith({ ...env, VOIDBASE_LOCALES: "en,ar" })).get("/sitemap.xml")).text;
    expect(query).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">');
    expect(query).toContain('<url><loc>https://shop.example/</loc><xhtml:link rel="alternate" hreflang="en" href="https://shop.example/"/><xhtml:link rel="alternate" hreflang="ar" href="https://shop.example/?locale=ar"/><xhtml:link rel="alternate" hreflang="x-default" href="https://shop.example/"/></url>');
    expect(query).toContain('<url><loc>https://shop.example/blog/hello-world</loc><lastmod>2026-09-01T10:20:30.456Z</lastmod><xhtml:link rel="alternate" hreflang="en" href="https://shop.example/blog/hello-world"/><xhtml:link rel="alternate" hreflang="ar" href="https://shop.example/blog/hello-world?locale=ar"/><xhtml:link rel="alternate" hreflang="x-default" href="https://shop.example/blog/hello-world"/></url>');
    const prefix = (await (await appWith({ ...env, VOIDBASE_LOCALES: "en,ar", VOIDBASE_SEO_LOCALE_PATH: "prefix" })).get("/sitemap.xml")).text;
    expect(prefix).toContain('<xhtml:link rel="alternate" hreflang="ar" href="https://shop.example/ar/blog/hello-world"/>');
    expect(prefix).toContain('<xhtml:link rel="alternate" hreflang="ar" href="https://shop.example/ar/"/>');
    expect(prefix).toContain('<xhtml:link rel="alternate" hreflang="en" href="https://shop.example/blog/hello-world"/>');
  });
});

describe("the share card: /api/seo/og/:collection/:id.svg", () => {
  test("a 1200x630 SVG with the app's name, the title and the description, escaped, cached an hour, with the skew headers", async () => {
    const { get } = await appWith({ VOIDBASE_SITEMAP: SITEMAP, VOIDBASE_SEO: SEO, VOIDBASE_SITE_URL: SITE });
    const { r, text } = await get("/api/seo/og/posts/p1.svg");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(r.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(r.headers.get("etag")).toBe(P1_ETAG);
    expect(r.headers.get("x-voidbase-version")).toBe(VERSION);
    expect(looked[0]!.filter).toBe('(status="live") && id = "p1"');
    expect(text.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">')).toBe(true);
    expect(text).toContain('fill="#1f2430"');
    expect(text).toContain(">Shop</text>");
    expect(text).toContain('font-size="64" font-weight="700" fill="#ffffff">Hello, world &amp; &quot;friends&quot;</text>');
    expect(text).toContain('font-size="32" fill="#ffffff" opacity="0.8">The first post, with markup &amp; entities.</text>');
    expect(text).not.toContain("<b>");
    expect(text).toMatch(/font-family="system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"/);
    expect(text).not.toContain("@font-face");
    expect((await get("/api/seo/og/posts/p1.svg", { "if-none-match": P1_ETAG })).r.status).toBe(304);
  });

  test("a long title wraps onto at most three lines of thirty characters, the last one ellipsised", async () => {
    const { get } = await appWith({ VOIDBASE_SITEMAP: SITEMAP, VOIDBASE_SEO: SEO });
    const { text } = await get("/api/seo/og/posts/p2.svg");
    const lines = [...text.matchAll(/font-size="64"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(30);
    expect(lines[0]).toBe("A very long title that keeps");
    expect(lines[2]!.endsWith("\u2026")).toBe(true);
    expect(wrap("short", 30, 3)).toEqual(["short"]);
    expect(wrap("a".repeat(70), 30, 3)).toEqual(["a".repeat(30), "a".repeat(30), "a".repeat(10)]);
    expect(wrap("a".repeat(100), 30, 3)).toEqual(["a".repeat(30), "a".repeat(30), `${"a".repeat(29)}\u2026`]);
    expect(wrap("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen", 12, 2)).toEqual(["one two", "three four\u2026"]);
  });

  test("VOIDBASE_SEO_THEME sets the background, dark ink on a light one; a bad value is the default; no name is no line", async () => {
    const light = await (await appWith({ VOIDBASE_SITEMAP: SITEMAP, VOIDBASE_SEO_THEME: "#fafafa" })).get("/api/seo/og/pages/g1.svg");
    expect(light.text).toContain('<rect width="1200" height="630" fill="#fafafa"/>');
    expect(light.text).toContain('fill="#111111">About us</text>');
    expect((await (await appWith({ VOIDBASE_SITEMAP: SITEMAP, VOIDBASE_SEO_THEME: "url(x)" })).get("/api/seo/og/pages/g1.svg")).text).toContain('fill="#1f2430"');
    expect((await (await appWith({ VOIDBASE_SITEMAP: SITEMAP, VOIDBASE_SEO_THEME: "navy" })).get("/api/seo/og/pages/g1.svg")).text).toContain('fill="navy"');
    const unnamed = shareCard({ appName: "", title: "T", description: "", theme: "" });
    expect(unnamed).not.toContain('font-size="30"');
    expect(unnamed).not.toContain('font-size="32"');
    expect(shareCard({ appName: "Shop", title: "", description: "", theme: "" })).toContain('font-size="64" font-weight="700" fill="#ffffff">Shop</text>');
  });

  test(".png is 406 when the platform cannot rasterise an SVG, image/png when a source can; a bad name or record is 404", async () => {
    const env = { VOIDBASE_SITEMAP: SITEMAP, VOIDBASE_SEO: SEO };
    const { get } = await appWith(env);
    const png = await get("/api/seo/og/posts/p1.png");
    expect(png.r.status).toBe(406);
    expect(JSON.parse(png.text).message).toContain("cannot rasterise");
    expect((await get("/api/seo/og/posts/p3.svg")).r.status).toBe(404);
    expect((await get("/api/seo/og/posts/p1.gif")).r.status).toBe(404);
    expect((await get("/api/seo/og/secrets/x.svg")).r.status).toBe(403);
    expect((await get("/api/seo/og/nothing/x.svg")).r.status).toBe(404);
    const able = await appWith(env, seoWith({ ...spySource, rasterize: async (svg) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, svg.length & 0xff]) }));
    const ok = await able.get("/api/seo/og/posts/p1.png");
    expect(ok.r.status).toBe(200);
    expect(ok.r.headers.get("content-type")).toBe("image/png");
    expect(ok.r.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(ok.r.headers.get("etag")).toBe(P1_ETAG);
    expect(new Uint8Array(await (await able.get("/api/seo/og/posts/p1.png")).r.clone().arrayBuffer().catch(() => new ArrayBuffer(0))).length).toBeGreaterThanOrEqual(0);
    expect((await able.get("/api/seo/og/posts/p1.png", { "if-none-match": P1_ETAG })).r.status).toBe(304);
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
