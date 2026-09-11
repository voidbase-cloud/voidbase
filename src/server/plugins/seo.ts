// The crawlers' view of the instance: robots.txt, a sitemap generated from public records, and llms.txt.
//
// Anything that serves pages has to answer crawlers, and a hand-written copy of what is in the collections goes
// stale. This plugin answers from what the instance has, the way openapi and mcp do for tools:
//   GET /robots.txt    allow everything, keep crawlers out of the panel (/_/) and the API (/api/), name the sitemap,
//                      plus the paths VOIDBASE_ROBOTS_DISALLOW lists.
//   GET /sitemap.xml   the site root, then one <url> per record of each entry VOIDBASE_SITEMAP declares
//                      (`posts:/blog/{slug}`, with an optional filter `posts[status="live"]:/blog/{slug}`). Only a
//                      collection whose list rule is public ("") is read: what a crawler could not list through
//                      the API is not put in front of it here either. Capped at 50000 entries, the sitemap limit.
//   GET /llms.txt      a plain-text description for the crawlers that are not search engines: the instance's name,
//                      the site URL, the public collections with their fields, and the machine-readable endpoints.
// A file in the static files (pb_public) wins over a generated answer: each route asks the static layer for its
// own path first and only answers when there is no file. On Bun the app runs before the static fallback, so this
// is the only way the file could win; on Cloudflare the asset layer answers before the Worker for any path outside
// /api, so the file wins there without the plugin being asked. The site URL is VOIDBASE_SITE_URL when set, else
// the request's origin. JSON-LD, OpenGraph tags, canonical URLs and share images are the roadmap's other half and
// are not here.
import type { Context, Hono } from "hono";
import { env as runtimeEnv } from "#platform/env";
import { logger } from "#platform/log";
import type { Field } from "../collections/fields";
import { listCollections, loadCollections, type Collection } from "../collections/model";
import type { Kernel } from "../kernel";
import { listRecords, type RecordContext } from "../records/service";
import { loadSettings } from "../settings";
import type { AppEnv, Bindings } from "../types";
import type { Plugin } from "./manifest";

/** where the answers' facts come from; the defaults read the instance, a test hands in what it likes */
export interface SeoSource {
  /** the collections this instance has */
  collections(env: Bindings): Promise<Collection[]>;
  /** the instance's name from its settings, or "" when it has none */
  appName(env: Bindings): Promise<string>;
  /** the records of a public collection that match the filter (a PocketBase filter, "" for all), at most `limit` */
  records(env: Bindings, collection: Collection, filter: string, limit: number): Promise<Record<string, unknown>[]>;
}

const PAGE = 1000; // listRecords' ceiling per page
const defaultSource: SeoSource = {
  collections: (env) => listCollections(env.DB),
  appName: async (env) => String((await loadSettings(env.DB)).meta.appName ?? ""),
  // the same listing the API does for an anonymous request, without a request: the list rule and the filter are
  // judged by the records service, so a filter from the env can do nothing a public caller could not
  records: async (env, collection, filter, limit) => {
    const ctx: RecordContext = {
      db: env.DB, storage: env.STORAGE, auth: null, superuser: false,
      request: { auth: null, method: "GET", query: {}, headers: {}, body: {}, context: "default" },
      collections: await loadCollections(env.DB),
      realtime: undefined as never, // only writes publish; a list never touches it
    };
    const out: Record<string, unknown>[] = [];
    for (let page = 1; out.length < limit; page++) {
      const r = await listRecords(ctx, collection, { page, perPage: PAGE, skipTotal: true, sort: "", filter, expand: "", fields: "" });
      out.push(...r.items);
      if (r.items.length < PAGE) break;
    }
    return out.slice(0, limit);
  },
};

// --- the knobs -------------------------------------------------------------------------------------------------------
const read = (name: string, env?: object): string => {
  try { return String((env as Record<string, unknown> | undefined)?.[name] ?? (runtimeEnv as Record<string, unknown>)[name] ?? process.env?.[name] ?? "").trim(); } catch { return ""; }
};
/** VOIDBASE_SITE_URL without a trailing slash, else the request's origin */
export const siteUrlOf = (c: Context<AppEnv>): string => read("VOIDBASE_SITE_URL", c.env).replace(/\/+$/, "") || new URL(c.req.url).origin;

/** one VOIDBASE_SITEMAP entry: `collection[filter]:/path/{field}` */
export interface SitemapEntry { collection: string; filter: string; pattern: string }
const ENTRY = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[(.*)\])?:(\/.*)$/;

/** split on the commas outside brackets and quotes, so a filter may contain one */
function splitEntries(spec: string): string[] {
  const out: string[] = []; let cur = ""; let depth = 0; let quote = "";
  for (const ch of spec) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "[") depth++; else if (ch === "]") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** the entries VOIDBASE_SITEMAP declares; a malformed one is skipped with a warning */
export function parseSitemap(spec: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  for (const raw of splitEntries(spec)) {
    const m = ENTRY.exec(raw);
    if (!m) { logger.warn("voidbase: seo: VOIDBASE_SITEMAP entry skipped, expected collection[filter]:/path/{field}", { entry: raw }); continue; }
    entries.push({ collection: m[1]!, filter: (m[2] ?? "").trim(), pattern: m[3]! });
  }
  return entries;
}

// --- the answers -------------------------------------------------------------------------------------------------------
const isPublic = (rule: string | null): boolean => rule !== null && rule.trim() === "";
const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const lastmodOf = (v: unknown): string | null => { const d = new Date(String(v ?? "")); return v && !Number.isNaN(d.getTime()) ? d.toISOString() : null; };

export const SITEMAP_LIMIT = 50000;

/** a record's URL for the pattern: each {field} is the record's value, URL-encoded; null when a value is empty */
export function locOf(site: string, pattern: string, record: Record<string, unknown>): string | null {
  let missing = false;
  const path = pattern.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, field: string) => {
    const v = record[field];
    const s = v == null ? "" : Array.isArray(v) ? v.map(String).join(",") : String(v);
    if (!s) missing = true;
    return encodeURIComponent(s);
  });
  return missing ? null : site + path;
}

/** the sitemap: the root, then the records of each entry; a collection that is not publicly listable is skipped */
async function buildSitemap(c: Context<AppEnv>, source: SeoSource, site: string): Promise<string> {
  const urls: string[] = [`<url><loc>${xml(site)}/</loc></url>`];
  const spec = read("VOIDBASE_SITEMAP", c.env);
  if (spec) {
    const byName = new Map((await source.collections(c.env)).map((col) => [col.name, col]));
    let count = 0;
    for (const entry of parseSitemap(spec)) {
      if (count >= SITEMAP_LIMIT) break;
      const collection = byName.get(entry.collection);
      if (!collection) { logger.warn("voidbase: seo: sitemap collection does not exist, skipped", { collection: entry.collection }); continue; }
      if (!isPublic(collection.listRule)) { logger.warn("voidbase: seo: sitemap collection is not publicly listable (its list rule is not empty), skipped", { collection: entry.collection }); continue; }
      let records: Record<string, unknown>[];
      try { records = await source.records(c.env, collection, entry.filter, SITEMAP_LIMIT - count); } catch (err) { logger.warn("voidbase: seo: sitemap entry could not be listed, skipped", { collection: entry.collection, filter: entry.filter, error: err instanceof Error ? err.message : String(err) }); continue; }
      for (const record of records) {
        if (count >= SITEMAP_LIMIT) break;
        const loc = locOf(site, entry.pattern, record);
        if (!loc) continue;
        const lastmod = lastmodOf(record.updated);
        urls.push(`<url><loc>${xml(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`);
        count++;
      }
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

function buildRobots(c: Context<AppEnv>, site: string): string {
  const extra = read("VOIDBASE_ROBOTS_DISALLOW", c.env).split(",").map((p) => p.trim()).filter(Boolean).map((p) => (p.startsWith("/") ? p : `/${p}`));
  const disallow = [...new Set(["/_/", "/api/", ...extra])];
  return ["User-agent: *", ...disallow.map((p) => `Disallow: ${p}`), "", `Sitemap: ${site}/sitemap.xml`, ""].join("\n");
}

async function buildLlms(c: Context<AppEnv>, source: SeoSource, site: string): Promise<string> {
  const name = (await source.appName(c.env).catch(() => "")).trim() || "voidbase";
  const collections = (await source.collections(c.env)).filter((col) => isPublic(col.listRule));
  const lines = [
    `# ${name}`, "",
    `> A voidbase instance at ${site}: a PocketBase-compatible API over its collections, described by the endpoints below.`, "",
    "## Public collections", "",
    ...(collections.length
      ? collections.map((col) => `- ${col.name} (${col.type}): ${(col.fields as Field[]).filter((f) => !f.hidden).map((f) => `${f.name} (${f.type})`).join(", ")}`)
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
  if (note) lines.push("", "## Notes", "", note);
  return lines.join("\n") + "\n";
}

// --- the routes --------------------------------------------------------------------------------------------------------
interface AssetFetcher { fetch(req: Request): Promise<Response> }
/** the static layer's own answer for this path, when it has a real file (an HTML shell answering a miss is not one) */
async function staticFile(c: Context<AppEnv>): Promise<Response | null> {
  const assets = (c.env as unknown as { ASSETS?: AssetFetcher }).ASSETS;
  if (!assets || typeof assets.fetch !== "function") return null;
  try {
    const r = await assets.fetch(new Request(c.req.url, { method: "GET" }));
    if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) return null;
    return r;
  } catch { return null; }
}

import { SEO_API } from "./seo-paths";
const CACHE = "public, max-age=300";
export { SEO_API, SEO_FILES, seoRedirectLines } from "./seo-paths";
function mountRoutes(app: Hono<AppEnv>, source: SeoSource) {
  // each file at its own path (Bun, where the app runs before the static fallback) and under /api/seo, the path a
  // deployed Worker is reached at: the adapter writes a _redirects rule from the one to the other (SEO_REDIRECTS),
  // so the asset layer, which answers everything outside /api on Cloudflare, sends crawlers to the Worker
  const serve = (path: string, type: string, body: (c: Context<AppEnv>, site: string) => Promise<string> | string) => {
    const handler = async (c: Context<AppEnv>) => {
      const file = await staticFile(c);
      if (file) return file;
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
}

/** the plugin over a source of its own: tests hand in collections, a name and records without a database */
export const seoWith = (source: Partial<SeoSource> = {}): Plugin => ({
  manifest: { name: "seo", version: "0.1.0", tier: "official", voidbase: "*" },
  apply(ctx: Kernel) { mountRoutes(ctx.app, { ...defaultSource, ...source }); },
});

/** the shipped plugin: the instance's own collections, settings and records */
export const seo: Plugin = seoWith();
