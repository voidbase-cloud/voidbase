import { listCollections, listRecords, loadCollections, loadSettings, VERSION } from "@voidbase-cloud/voidbase/sdk";
import { env as runtimeEnv } from "@voidbase-cloud/voidbase/platform";
import { logger } from "@voidbase-cloud/voidbase/platform";
import { runAfterRead } from "@voidbase-cloud/voidbase/kernel";
import { recordContextFor } from "@voidbase-cloud/voidbase/record-slot";
import { alternatesOf, buildMeta, CARD, etagOf, expandOf, localesOf, lookupFilter, matchPath, notModified, pageText, parseSeo, shareCard, splitLocale, splitOutside } from "./lib/meta.js";
const PAGE = 1000; // listRecords' ceiling per page
const defaultSource = {
  collections: (env) => listCollections(env.DB),
  appName: async (env) => String((await loadSettings(env.DB)).meta.appName ?? ""),
  // the same listing the API does for an anonymous request, without a request: the list rule and the filter are
  // judged by the records service, so a filter from the env can do nothing a public caller could not
  records: async (env, collection, filter, limit) => {
    const ctx = {
      db: env.DB, storage: env.STORAGE, auth: null, superuser: false,
      request: { auth: null, method: "GET", query: {}, headers: {}, body: {}, context: "default" },
      collections: await loadCollections(env.DB),
      realtime: undefined, // only writes publish; a list never touches it
    };
    const out = [];
    for (let page = 1; out.length < limit; page++) {
      const r = await listRecords(ctx, collection, { page, perPage: PAGE, skipTotal: true, sort: "", filter, expand: "", fields: "" });
      out.push(...r.items);
      if (r.items.length < PAGE)
        break;
    }
    return out.slice(0, limit);
  },
  // the same listing the API does for this request's caller: the list rule is judged for the token that asks
  record: async (c, collection, filter, expand) => {
    // the request's own context, from the core's slot rather than from importing the app (../record-slot.ts)
    const r = await listRecords(await recordContextFor(c), collection, { page: 1, perPage: 1, skipTotal: true, sort: "", filter, expand, fields: "" });
    return r.items[0] ?? null;
  },
  // resvg, loaded on the first card asked for as a PNG: the wasm is ~2.4 MB and no other request should pay for it
  rasterize: async (svg) => (await import("@voidbase-cloud/voidbase/platform/raster")).rasterize(svg, CARD.width, CARD.height),
};
// --- the knobs -------------------------------------------------------------------------------------------------------
const read = (name, env) => {
  try {
    return String(env?.[name] ?? runtimeEnv[name] ?? process.env?.[name] ?? "").trim();
  }
  catch {
    return "";
  }
};
/** VOIDBASE_SITE_URL without a trailing slash, else the request's origin */
export const siteUrlOf = (c) => read("VOIDBASE_SITE_URL", c.env).replace(/\/+$/, "") || new URL(c.req.url).origin;
const ENTRY = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?:(\/.*)$/;
/** the entries VOIDBASE_SITEMAP declares; a malformed one is skipped with a warning */
export function parseSitemap(spec) {
  const entries = [];
  for (const raw of splitOutside(spec)) {
    const m = ENTRY.exec(raw);
    if (!m) {
      logger.warn("voidbase: seo: VOIDBASE_SITEMAP entry skipped, expected collection[filter]:/path/{field}", { entry: raw });
      continue;
    }
    entries.push({ collection: m[1], filter: (m[2] ?? "").trim(), pattern: m[3] });
  }
  return entries;
}
// --- the answers -------------------------------------------------------------------------------------------------------
const isPublic = (rule) => rule !== null && rule.trim() === "";
const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const lastmodOf = (v) => { const d = new Date(String(v ?? "")); return v && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };
export const SITEMAP_LIMIT = 50000;
/** a record's URL for the pattern: each {field} is the record's value, URL-encoded; null when a value is empty */
export function locOf(site, pattern, record) {
  let missing = false;
  const path = pattern.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, field) => {
    const v = record[field];
    const s = v == null ? "" : Array.isArray(v) ? v.map(String).join(",") : String(v);
    if (!s)
      missing = true;
    return encodeURIComponent(s);
  });
  return missing ? null : site + path;
}
/**
 * VOIDBASE_SEO_PNG: whether this build can rasterise the share card. Read like every other seo knob (the request's
 * env, then the runtime's), because it decides two things that have to agree: whether `.png` rasterises at all,
 * and which URL the meta answer names. `voidbase deploy` bakes the var exactly when it built with the rasteriser
 * in, so a deployed instance never advertises a PNG it cannot render (docs/plugins.md).
 */
const pngCards = (c) => seoPngOn(read(SEO_PNG_VAR, c.env));
/** the locales the translations plugin is configured with, and how a locale goes into a URL */
const localeSetup = (c) => localesOf(read("VOIDBASE_LOCALES", c.env), read("VOIDBASE_SEO_LOCALE_PATH", c.env));
/** one xhtml:link per locale (and x-default) when locales are set, else nothing: the sitemap stays as it was */
const alternatesXml = (site, loc, locales) => alternatesOf(site, loc, locales).map((a) => `<xhtml:link rel="alternate" hreflang="${xml(a.locale)}" href="${xml(a.url)}"/>`).join("");
/** the sitemap: the root, then the records of each entry; a collection that is not publicly listable is skipped */
async function buildSitemap(c, source, site) {
  const locales = localeSetup(c);
  const urls = [`<url><loc>${xml(site)}/</loc>${alternatesXml(site, `${site}/`, locales)}</url>`];
  const spec = read("VOIDBASE_SITEMAP", c.env);
  if (spec) {
    const byName = new Map((await source.collections(c.env)).map((col) => [col.name, col]));
    let count = 0;
    for (const entry of parseSitemap(spec)) {
      if (count >= SITEMAP_LIMIT)
        break;
      const collection = byName.get(entry.collection);
      if (!collection) {
        logger.warn("voidbase: seo: sitemap collection does not exist, skipped", { collection: entry.collection });
        continue;
      }
      if (!isPublic(collection.listRule)) {
        logger.warn("voidbase: seo: sitemap collection is not publicly listable (its list rule is not empty), skipped", { collection: entry.collection });
        continue;
      }
      let records;
      try {
        records = await source.records(c.env, collection, entry.filter, SITEMAP_LIMIT - count);
      }
      catch (err) {
        logger.warn("voidbase: seo: sitemap entry could not be listed, skipped", { collection: entry.collection, filter: entry.filter, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
      for (const record of records) {
        if (count >= SITEMAP_LIMIT)
          break;
        const loc = locOf(site, entry.pattern, record);
        if (!loc)
          continue;
        const lastmod = lastmodOf(record.updated);
        urls.push(`<url><loc>${xml(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}${alternatesXml(site, loc, locales)}</url>`);
        count++;
      }
    }
  }
  const xmlns = locales ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xmlns}>\n${urls.join("\n")}\n</urlset>\n`;
}
function buildRobots(c, site) {
  const extra = read("VOIDBASE_ROBOTS_DISALLOW", c.env).split(",").map((p) => p.trim()).filter(Boolean).map((p) => (p.startsWith("/") ? p : `/${p}`));
  const disallow = [...new Set(["/_/", "/api/", ...extra])];
  return ["User-agent: *", ...disallow.map((p) => `Disallow: ${p}`), "", `Sitemap: ${site}/sitemap.xml`, ""].join("\n");
}
async function buildLlms(c, source, site) {
  const name = (await source.appName(c.env).catch(() => "")).trim() || "voidbase";
  const collections = (await source.collections(c.env)).filter((col) => isPublic(col.listRule));
  const lines = [
    `# ${name}`, "",
    `> A voidbase instance at ${site}: a PocketBase-compatible API over its collections, described by the endpoints below.`, "",
    "## Public collections", "",
    ...(collections.length
      ? collections.map((col) => `- ${col.name} (${col.type}): ${col.fields.filter((f) => !f.hidden).map((f) => `${f.name} (${f.type})`).join(", ")}`)
      : ["- none: no collection is listable without a token"]),
    "",
    "## Machine-readable endpoints", "",
    `- ${site}/api/openapi.json: the OpenAPI 3.1 document of the API, scoped to the token that asks for it`,
    `- ${site}/api/docs: the API reference page over that document`,
    `- ${site}/api/mcp: the Model Context Protocol server (stateless Streamable HTTP), the same scoping`,
    "",
    "Scopes: no token sees the public API; a user's token (Authorization: <token>) sees what that user may call; a superuser's token sees everything.",
  ];
  const note = read("VOIDBASE_LLMS_NOTE", c.env);
  if (note)
    lines.push("", "## Notes", "", note);
  return lines.join("\n") + "\n";
}
/** the static layer's own answer for this path, when it has a real file (an HTML shell answering a miss is not one) */
async function staticFile(c) {
  const assets = c.env.ASSETS;
  if (!assets || typeof assets.fetch !== "function")
    return null;
  try {
    const r = await assets.fetch(new Request(c.req.url, { method: "GET" }));
    if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html"))
      return null;
    return r;
  }
  catch {
    return null;
  }
}
import { SEO_API, SEO_PNG_VAR, seoPngOn } from "@voidbase-cloud/voidbase/plugins/seo-paths";
const CACHE = "public, max-age=300";
export { SEO_API, SEO_FILES, SEO_PNG_VAR, seoPngOn, seoRedirectLines } from "@voidbase-cloud/voidbase/plugins/seo-paths";
export { buildMeta, CARD_FONT_FAMILY, etagOf, excerpt, matchPath, notModified, parseSeo, shareCard, splitLocale, wrap } from "./lib/meta.js";
const CARD_CACHE = "public, max-age=3600";
const OG_PATH = `${SEO_API}/og`;
/** the record behind a page, found through a sitemap entry: null when there is no entry, no collection, or no record */
async function findPage(c, kernel, source, target) {
  const entries = parseSitemap(read("VOIDBASE_SITEMAP", c.env));
  const mappings = parseSeo(read("VOIDBASE_SEO", c.env));
  const locales = localeSetup(c);
  let entry;
  let values = {};
  let locale = "";
  if ("path" in target) {
    const split = splitLocale(target.path, locales);
    locale = split.locale;
    const m = matchPath(entries, split.path);
    if (!m)
      return null;
    entry = m.entry;
    values = m.values;
  }
  else {
    entry = entries.find((e) => e.collection === target.collection);
    if (!entry)
      return null;
    values = { id: target.id };
  }
  const collection = (await source.collections(c.env)).find((col) => col.name === entry.collection);
  if (!collection)
    return null;
  const mapping = mappings.find((m) => m.collection === collection.name) ?? null;
  const record = await source.record(c, collection, lookupFilter(entry, values), expandOf(mapping));
  if (!record)
    return null;
  // the plugins that reshape every read (translations answers in the locale the request asks for) see this one too
  await runAfterRead(kernel, c, { collection: collection.name, rows: [record] });
  return { entry, collection, mapping, record, locales, locale };
}
/** the headers every record-derived answer carries; true when the request already has this version of it */
function skewHeaders(c, record, cache) {
  const etag = etagOf(VERSION, record);
  c.header("ETag", etag);
  c.header("X-Voidbase-Version", VERSION);
  c.header("Cache-Control", cache);
  return { etag, fresh: notModified(c.req.header("if-none-match"), etag) };
}
function mountMeta(app, kernel, source) {
  app.get(`${SEO_API}/meta`, async (c) => {
    const path = c.req.query("path") ?? "";
    const collection = c.req.query("collection") ?? "";
    const id = c.req.query("id") ?? "";
    if (!path && !(collection && id))
      return c.json({ message: "Give ?path=/the/page or ?collection=name&id=record." }, 400);
    const page = await findPage(c, kernel, source, path ? { path } : { collection, id });
    if (!page)
      return c.json({ message: "No page at this address: nothing in VOIDBASE_SITEMAP resolves it to a record the caller may list." }, 404);
    const { fresh } = skewHeaders(c, page.record, CACHE);
    if (fresh)
      return c.body(null, 304);
    const site = siteUrlOf(c);
    const asked = c.req.query("locale") ?? "";
    const locale = page.locales?.locales.includes(asked) ? asked : page.locale;
    const meta = buildMeta({
      site, appName: (await source.appName(c.env).catch(() => "")).trim(), collection: page.collection, record: page.record,
      canonical: locOf(site, page.entry.pattern, page.record) ?? `${site}${new URL(path || "/", site).pathname}`,
      mapping: page.mapping, imageSize: read("VOIDBASE_SEO_IMAGE_SIZE", c.env), locale, locales: page.locales,
      // .png when this build can rasterise (no social scraper renders SVG), .svg when it cannot: naming a PNG that
      // comes back as an SVG body would be a lie to the scraper, and the scraper is the whole point of the card
      card: `${site}${OG_PATH}/${encodeURIComponent(page.collection.name)}/${encodeURIComponent(String(page.record.id ?? ""))}.${pngCards(c) ? "png" : "svg"}`,
    });
    return c.json(meta);
  });
  app.get(`${OG_PATH}/:collection/:file`, async (c) => {
    const m = /^(.+)\.(svg|png)$/.exec(c.req.param("file"));
    if (!m)
      return c.json({ message: "The card is <id>.png or <id>.svg." }, 404);
    const page = await findPage(c, kernel, source, { collection: c.req.param("collection"), id: m[1] });
    if (!page)
      return c.json({ message: "No page for this record: nothing in VOIDBASE_SITEMAP names its collection, or the caller may not list it." }, 404);
    const { etag, fresh } = skewHeaders(c, page.record, CARD_CACHE);
    if (fresh)
      return c.body(null, 304);
    const text = pageText(page.collection, page.record, page.mapping);
    const svg = shareCard({ appName: (await source.appName(c.env).catch(() => "")).trim(), title: text.title, description: text.description, theme: read("VOIDBASE_SEO_THEME", c.env) });
    const asSvg = () => { c.header("Content-Type", "image/svg+xml; charset=utf-8"); return c.body(svg); };
    if (m[2] === "svg")
      return asSvg();
    // with the knob off the rasteriser is not in the build at all, so there is nothing to ask
    const png = !pngCards(c) ? null : await source.rasterize(svg).catch((err) => { logger.warn("voidbase: seo: share card could not be rasterised", { error: err instanceof Error ? err.message : String(err) }); return null; });
    // a card no one sees is worse than a card in the wrong format: the .png URL answers with the SVG rather than an
    // error when there is no rasteriser, and says so in a header so a caller can tell the two apart
    if (!png) {
      logger.warn(`voidbase: seo: share card asked for as .png served as SVG (${SEO_PNG_VAR} is off, or this platform has no rasteriser)`, { collection: page.collection.name, id: String(page.record.id ?? "") });
      c.header("X-Voidbase-Card", "svg-fallback");
      return asSvg();
    }
    return new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": CARD_CACHE, ETag: etag, "X-Voidbase-Version": VERSION } });
  });
}
function mountRoutes(app, kernel, source) {
  // each file at its own path (Bun, where the app runs before the static fallback) and under /api/seo, the path a
  // deployed Worker is reached at: the adapter writes a _redirects rule from the one to the other (SEO_REDIRECTS),
  // so the asset layer, which answers everything outside /api on Cloudflare, sends crawlers to the Worker
  const serve = (path, type, body) => {
    const handler = async (c) => {
      const file = await staticFile(c);
      if (file)
        return file;
      c.header("Content-Type", type);
      c.header("Cache-Control", CACHE);
      return c.body(await body(c, siteUrlOf(c)));
    };
    app.get(path, handler);
    app.get(`${SEO_API}${path}`, handler);
  };
  serve("/robots.txt", "text/plain; charset=utf-8", (c, site) => buildRobots(c, site));
  serve("/sitemap.xml", "application/xml; charset=utf-8", (c, site) => buildSitemap(c, source, site));
  serve("/llms.txt", "text/plain; charset=utf-8", (c, site) => buildLlms(c, source, site));
  mountMeta(app, kernel, source);
}
/** the plugin over a source of its own: tests hand in collections, a name and records without a database */
export const seoWith = (source = {}) => ({
  apply(ctx) { mountRoutes(ctx.app, ctx, { ...defaultSource, ...source }); },
});
/** the shipped plugin: the instance's own collections, settings and records */
const seo = seoWith();

// what the plugin does; its declaration is manifest.json beside this file, which the instance reads
export default seo;
