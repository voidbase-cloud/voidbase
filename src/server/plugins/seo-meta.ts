// The record half of the seo plugin: what one page says about itself (canonical URL, title, description, OpenGraph
// and Twitter tags, JSON-LD from a schema.org type mapped onto the collection), the share card rendered on request,
// and the locale alternates the sitemap and the page share. Pure functions over a record and the knobs; seo.ts owns
// the routes and the lookups.
//   VOIDBASE_SEO=posts:Article{title=title,description=summary,image=cover,datePublished=created,author=author.name}
//     collection: schema.org type, then `key=field` mappings in braces, comma-separated entries outside the braces.
//     `title`, `description` and `image` are the page-level keys; every other key lands in the JSON-LD as is (dates
//     are normalised to ISO, `author` and `publisher` become a Person and an Organization). A field path may reach
//     through one relation (`author.name`) with `expand`.
//   VOIDBASE_SEO_IMAGE_SIZE=1200x630   a thumb size of the mapped file field to put in og:image (else the original)
//   VOIDBASE_SEO_THEME=#1f2430          the share card's background colour (a hex colour or a CSS colour name)
//   VOIDBASE_SEO_LOCALE_PATH=prefix     locale alternates as /<code>/path rather than ?locale=<code> (VOIDBASE_LOCALES)
import { logger } from "#platform/log";
import type { Field } from "../collections/fields";
import type { Collection } from "../collections/model";
import type { SitemapEntry } from "./seo";

// --- the mapping grammar ------------------------------------------------------------------------------------------------
/** one VOIDBASE_SEO entry: the schema.org type of a collection's pages and which fields feed which key */
export interface SeoMapping { collection: string; type: string; fields: Record<string, string> }
const SEO_ENTRY = /^([A-Za-z_][A-Za-z0-9_]*):([A-Za-z][A-Za-z0-9]*)(?:\{(.*)\})?$/;
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;
const KEY = /^[A-Za-z@][A-Za-z0-9]*$/;

/** split on the commas outside brackets, braces and quotes */
export function splitOutside(spec: string): string[] {
  const out: string[] = []; let cur = ""; let depth = 0; let quote = "";
  for (const ch of spec) {
    if (quote) { cur += ch; if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "[" || ch === "{") depth++; else if (ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** the mappings VOIDBASE_SEO declares; a malformed entry or mapping is skipped with a warning */
export function parseSeo(spec: string): SeoMapping[] {
  const out: SeoMapping[] = [];
  for (const raw of splitOutside(spec)) {
    const m = SEO_ENTRY.exec(raw);
    if (!m) { logger.warn("voidbase: seo: VOIDBASE_SEO entry skipped, expected collection:Type{key=field,...}", { entry: raw }); continue; }
    const fields: Record<string, string> = {};
    for (const pair of (m[3] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const eq = pair.indexOf("=");
      const key = eq < 0 ? "" : pair.slice(0, eq).trim(); const path = eq < 0 ? "" : pair.slice(eq + 1).trim();
      if (!KEY.test(key) || !FIELD_PATH.test(path)) { logger.warn("voidbase: seo: VOIDBASE_SEO mapping skipped, expected key=field or key=relation.field", { collection: m[1], mapping: pair }); continue; }
      fields[key] = path;
    }
    out.push({ collection: m[1]!, type: m[2]!, fields });
  }
  return out;
}

/** the relations the mappings reach through, for the records service's `expand` */
export const expandOf = (mapping: SeoMapping | null): string =>
  [...new Set(Object.values(mapping?.fields ?? {}).filter((p) => p.includes(".")).map((p) => p.split(".")[0]!))].join(",");

// --- the path, matched against the sitemap templates in reverse ----------------------------------------------------------
export interface PathMatch { entry: SitemapEntry; values: Record<string, string> }
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** the first sitemap entry whose pattern matches the path, each {field} captured and URL-decoded */
export function matchPath(entries: SitemapEntry[], path: string): PathMatch | null {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  for (const entry of entries) {
    const names: string[] = [];
    const re = new RegExp(`^${escapeRe(entry.pattern).replace(/\\\{([A-Za-z_][A-Za-z0-9_]*)\\\}/g, (_, n: string) => { names.push(n); return "([^/]+)"; })}$`);
    const m = re.exec(p);
    if (!m || !names.length) continue;
    const values: Record<string, string> = {};
    let ok = true;
    names.forEach((n, i) => { try { values[n] = decodeURIComponent(m[i + 1]!); } catch { ok = false; } });
    if (ok) return { entry, values };
  }
  return null;
}

/** a filter string literal: the lexer takes a backslash before a quote or a backslash */
export const quoteFilter = (v: string): string => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** the entry's own filter and the captured values, as one filter the records service judges with the list rule */
export const lookupFilter = (entry: SitemapEntry, values: Record<string, string>): string =>
  [...(entry.filter ? [`(${entry.filter})`] : []), ...Object.entries(values).map(([k, v]) => `${k} = ${quoteFilter(v)}`)].join(" && ");

// --- locales ------------------------------------------------------------------------------------------------------------
export interface LocaleSetup { locales: string[]; mode: "query" | "prefix" }
/** VOIDBASE_LOCALES as the translations plugin reads it (the first is the source), or null when unset */
export function localesOf(locales: string, mode: string): LocaleSetup | null {
  const list = [...new Set(locales.split(",").map((s) => s.trim()).filter(Boolean))];
  return list.length ? { locales: list, mode: mode.trim().toLowerCase() === "prefix" ? "prefix" : "query" } : null;
}
/** the URL of `url` (an absolute URL under `site`) in one locale; the source locale keeps the bare URL */
export function localizedUrl(site: string, url: string, code: string, setup: LocaleSetup): string {
  if (code === setup.locales[0]) return url;
  if (setup.mode === "prefix") return url.startsWith(site) ? `${site}/${encodeURIComponent(code)}${url.slice(site.length)}` : url;
  return `${url}${url.includes("?") ? "&" : "?"}locale=${encodeURIComponent(code)}`;
}
/** the alternates of one URL: every locale, then x-default as the bare URL; empty without locales */
export const alternatesOf = (site: string, url: string, setup: LocaleSetup | null): { locale: string; url: string }[] =>
  setup ? [...setup.locales.map((code) => ({ locale: code, url: localizedUrl(site, url, code, setup) })), { locale: "x-default", url }] : [];
/**
 * The locale a page path asks for and the path without it: `?locale=ar` in query mode, `/ar/...` in prefix mode.
 * A code that is not configured is not a locale, so `/ar/about` stays a path when `ar` is not in the list.
 */
export function splitLocale(path: string, setup: LocaleSetup | null): { path: string; locale: string } {
  const u = new URL(path, "http://seo.invalid");
  let p = u.pathname; let locale = "";
  if (setup) {
    const q = u.searchParams.get("locale") ?? "";
    if (setup.locales.includes(q)) locale = q;
    const seg = /^\/([^/]+)(\/.*)?$/.exec(p);
    if (setup.mode === "prefix" && seg && setup.locales.includes(decodeURIComponent(seg[1]!))) { locale = decodeURIComponent(seg[1]!); p = seg[2] || "/"; }
  }
  return { path: p, locale };
}

// --- the page's metadata ------------------------------------------------------------------------------------------------
export interface MetaAnswer {
  canonical: string; title: string; description: string; image: string; type: string; locale: string;
  alternates: { locale: string; url: string }[];
  jsonld: Record<string, unknown>;
  og: Record<string, string | string[]>;
  twitter: Record<string, string>;
  html: string;
}
export interface MetaInput {
  site: string; appName: string; collection: Collection; record: Record<string, unknown>; canonical: string;
  mapping: SeoMapping | null; imageSize: string; locale: string; locales: LocaleSetup | null;
  /** the share card's URL, og:image when no image field is mapped or the record has no file in it */
  card: string;
}

export const stripTags = (s: string): string => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
export const DESCRIPTION_MAX = 200;
/** the first 200 characters, cut back to a word boundary and closed with an ellipsis when it was longer */
export function excerpt(s: string, max = DESCRIPTION_MAX): string {
  const text = stripTags(s);
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}\u2026`;
}
export const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** the expanded record behind a relation field (the first of a multi relation), or null when not expanded */
function ownerOf(record: Record<string, unknown>, relation: string): Record<string, unknown> | null {
  const expand = (record.expand as Record<string, unknown> | undefined)?.[relation];
  const related = Array.isArray(expand) ? expand[0] : expand;
  return related && typeof related === "object" ? (related as Record<string, unknown>) : null;
}
/** the record's value at a field path; one relation hop reads the expanded record */
export function valueAt(record: Record<string, unknown>, path: string): unknown {
  const [head, tail] = path.split(".");
  return tail ? ownerOf(record, head!)?.[tail] : record[head!];
}
const asText = (v: unknown): string => v == null ? "" : Array.isArray(v) ? v.map(asText).filter(Boolean).join(", ") : typeof v === "object" ? "" : String(v);
const firstField = (collection: Collection, names: string[], types: string[]): string =>
  names.find((n) => (collection.fields as Field[]).some((f) => f.name === n && types.includes(f.type) && !f.hidden)) ?? "";
const TEXT = ["text", "editor"];
const ARTICLE = /(Article|Posting)$/;

/** the title and description of a record's page, mapped or defaulted; what the meta answer and the card share */
export function pageText(collection: Collection, record: Record<string, unknown>, mapping: SeoMapping | null): { title: string; description: string } {
  const titlePath = mapping?.fields.title || firstField(collection, ["title", "name", "headline"], TEXT);
  const descriptionPath = mapping?.fields.description || firstField(collection, ["summary", "description", "excerpt"], TEXT);
  return { title: stripTags(asText(titlePath ? valueAt(record, titlePath) : "")), description: excerpt(asText(descriptionPath ? valueAt(record, descriptionPath) : "")) };
}

/** the URL of the record's mapped image: a file field through the files route (a thumb when sized), a URL as is */
export function imageUrl(input: Pick<MetaInput, "site" | "collection" | "record" | "mapping" | "imageSize">): string {
  const path = input.mapping?.fields.image;
  if (!path) return "";
  const v = valueAt(input.record, path);
  const first = Array.isArray(v) ? v[0] : v;
  const name = first == null ? "" : String(first);
  if (!name) return "";
  if (/^https?:\/\//i.test(name)) return name;
  // the record the file belongs to: the record itself, or the expanded record a relation path reads through
  const [head, tail] = path.split(".");
  const owner = tail ? ownerOf(input.record, head!) : input.record;
  const collectionName = tail ? String(owner?.collectionName ?? "") : input.collection.name;
  const id = String(owner?.id ?? "");
  if (!collectionName || !id) return "";
  return `${input.site}/api/files/${encodeURIComponent(collectionName)}/${encodeURIComponent(id)}/${encodeURIComponent(name)}${input.imageSize ? `?thumb=${encodeURIComponent(input.imageSize)}` : ""}`;
}

const isoOf = (v: unknown): string => { const d = new Date(String(v ?? "")); return v && !Number.isNaN(d.getTime()) ? d.toISOString() : asText(v); };
const PAGE_KEYS = new Set(["title", "description", "image"]);

/** the whole answer: the tags as data, the JSON-LD, and the html fragment a page puts in its head */
export function buildMeta(input: MetaInput): MetaAnswer {
  const type = input.mapping?.type || "WebPage";
  const { title, description } = pageText(input.collection, input.record, input.mapping);
  const image = imageUrl(input) || input.card;
  const alternates = alternatesOf(input.site, input.canonical, input.locales);
  const canonical = input.locale && input.locales ? localizedUrl(input.site, input.canonical, input.locale, input.locales) : input.canonical;
  const locale = input.locale || input.locales?.locales[0] || "";
  const ogLocale = (s: string) => s.replace(/-/g, "_");

  const jsonld: Record<string, unknown> = { "@context": "https://schema.org", "@type": type, name: title };
  if (ARTICLE.test(type)) jsonld.headline = title;
  if (description) jsonld.description = description;
  jsonld.image = image;
  jsonld.url = canonical;
  if (locale) jsonld.inLanguage = locale;
  for (const [key, path] of Object.entries(input.mapping?.fields ?? {})) {
    if (PAGE_KEYS.has(key)) continue;
    const v = valueAt(input.record, path);
    if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
    if (/^date/i.test(key)) jsonld[key] = isoOf(v);
    else if (key === "author" || key === "publisher") jsonld[key] = { "@type": key === "author" ? "Person" : "Organization", name: asText(v) };
    else jsonld[key] = typeof v === "object" && !Array.isArray(v) ? asText(v) : v;
  }

  const og: Record<string, string | string[]> = {
    "og:title": title, "og:description": description, "og:url": canonical, "og:type": ARTICLE.test(type) ? "article" : "website",
    "og:site_name": input.appName, "og:image": image,
  };
  if (locale) { og["og:locale"] = ogLocale(locale); const others = alternates.filter((a) => a.locale !== "x-default" && a.locale !== locale).map((a) => ogLocale(a.locale)); if (others.length) og["og:locale:alternate"] = others; }
  const twitter: Record<string, string> = { "twitter:card": "summary_large_image", "twitter:title": title, "twitter:description": description, "twitter:image": image };

  const lines = [
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="canonical" href="${escapeHtml(canonical)}">`,
    ...(description ? [`<meta name="description" content="${escapeHtml(description)}">`] : []),
    ...alternates.map((a) => `<link rel="alternate" hreflang="${escapeHtml(a.locale)}" href="${escapeHtml(a.url)}">`),
    ...Object.entries(og).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).filter((x) => x !== "").map((x) => `<meta property="${k}" content="${escapeHtml(x)}">`)),
    ...Object.entries(twitter).filter(([, v]) => v !== "").map(([k, v]) => `<meta name="${k}" content="${escapeHtml(v)}">`),
    `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}</script>`,
  ];
  return { canonical, title, description, image, type, locale, alternates, jsonld, og, twitter, html: lines.join("\n") };
}

// --- the share card ------------------------------------------------------------------------------------------------------
export const CARD = { width: 1200, height: 630, titleChars: 30, titleLines: 3, descriptionChars: 70 } as const;
export const DEFAULT_THEME = "#1f2430";
// The rasteriser is handed Inter's own bytes (og-font.ts), so the family is named first and the generic stack
// stays behind it for the browsers and scrapers that fetch the .svg instead.
export const CARD_FONT_FAMILY = "Inter";
const FONT = `${CARD_FONT_FAMILY}, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`;

/** VOIDBASE_SEO_THEME when it is a hex colour or a colour name, else the default dark */
export const themeOf = (v: string): string => (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v.trim()) || /^[a-z]{3,20}$/i.test(v.trim()) ? v.trim() : DEFAULT_THEME);
/** white text on a dark background, near-black on a light one (a colour name is taken as dark) */
function inkOf(theme: string): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(theme);
  if (!m) return "#ffffff";
  const hex = m[1]!.length === 3 ? m[1]!.split("").map((c) => c + c).join("") : m[1]!;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? "#111111" : "#ffffff";
}

/** words wrapped to at most `chars` per line and `lines` lines, the last one ellipsised when text was left over */
export function wrap(text: string, chars: number, lines: number): string[] {
  const out: string[] = [];
  let cur = "";
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    let w = words[i]!;
    while (w.length > chars) { if (cur) { out.push(cur); cur = ""; } out.push(w.slice(0, chars)); w = w.slice(chars); if (out.length >= lines) break; }
    if (out.length >= lines) { cur = ""; break; }
    if (!w) continue;
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= chars) cur += ` ${w}`;
    else { out.push(cur); cur = w; if (out.length >= lines) { cur = ""; break; } }
  }
  if (cur && out.length < lines) out.push(cur);
  const used = out.join(" ").replace(/\s+/g, " ");
  if (used.length < text.replace(/\s+/g, " ").trim().length && out.length) {
    const last = out[out.length - 1]!;
    out[out.length - 1] = `${(last.length >= chars ? last.slice(0, chars - 1) : last).trimEnd()}\u2026`;
  }
  return out;
}

/** the 1200x630 SVG card: the app's name, the title on up to three lines, the description on one */
export function shareCard(opts: { appName: string; title: string; description: string; theme: string }): string {
  const bg = themeOf(opts.theme);
  const ink = inkOf(bg);
  const titleLines = wrap(opts.title || opts.appName || "voidbase", CARD.titleChars, CARD.titleLines);
  const description = wrap(opts.description, CARD.descriptionChars, 1)[0] ?? "";
  const top = 300 - (titleLines.length - 1) * 39;
  const title = titleLines.map((line, i) => `<text x="80" y="${top + i * 78}" font-family="${FONT}" font-size="64" font-weight="700" fill="${ink}">${escapeHtml(line)}</text>`).join("\n  ");
  const descY = top + (titleLines.length - 1) * 78 + 72;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD.width}" height="${CARD.height}" viewBox="0 0 ${CARD.width} ${CARD.height}">`,
    `  <rect width="${CARD.width}" height="${CARD.height}" fill="${escapeHtml(bg)}"/>`,
    `  <rect x="80" y="96" width="56" height="8" rx="4" fill="${ink}" opacity="0.9"/>`,
    ...(opts.appName ? [`  <text x="80" y="160" font-family="${FONT}" font-size="30" font-weight="600" fill="${ink}" opacity="0.75">${escapeHtml(opts.appName)}</text>`] : []),
    `  ${title}`,
    ...(description ? [`  <text x="80" y="${descY}" font-family="${FONT}" font-size="32" fill="${ink}" opacity="0.8">${escapeHtml(description)}</text>`] : []),
    `</svg>`,
    "",
  ].join("\n");
}

// --- deployment skew ------------------------------------------------------------------------------------------------------
/** the ETag of anything derived from one record on one version of voidbase: `"<version>-<updated ms>"` */
export const etagOf = (version: string, record: Record<string, unknown>): string => `"${version}-${Date.parse(String(record.updated ?? "")) || 0}"`;
/** whether If-None-Match names this ETag (weak or strong) or everything */
export function notModified(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").map((t) => t.trim().replace(/^W\//, "")).some((t) => t === "*" || t === etag);
}
