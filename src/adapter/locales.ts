// The `locales` option of the Void adapter: a locale in the route, and the `hreflang` links that say so.
//
//   voidbaseAdapter({ locales: { codes: ["en", "ar", "fr"], path: "prefix", default: "en" } })
//
// Two things are written into the generated pb_public, both at build time, because the Worker must not end up in
// front of the assets: a Void route outside `/api` would be asked for every page, every image and every hashed
// chunk, which is the one thing the asset layer is there to prevent (docs/platform.md). So this follows
// src/adapter/seo-redirects.ts exactly: rules in `_redirects`, which Cloudflare's asset layer applies before it
// looks for a file, and tags in the pages themselves.
//
// **Why the prefix is a redirect and not a rewrite.** Cloudflare's `_redirects` does support a 200 "proxy" line
// (`/ar/* /:splat 200`), so `/ar/about` could serve `/about`'s bytes with no round trip. It is still the wrong
// mechanism here, for three reasons, and all three are about honesty rather than taste:
//   1. a proxy serves one file for every locale, so `<html lang>` and the canonical URL on that page can only name
//      one locale; the other locales would be served a page that says it is the first one.
//   2. `_redirects` cannot add a request header. The asset layer answers the request itself and never invokes the
//      Worker, so nothing on that path can make the request carry `Accept-Language: ar` for the API calls the page
//      then makes. A rewrite would look like a locale and carry none.
//   3. `voidbase deploy` forwards only 3xx path rules to the uploaded `_redirects` (src/node/cloud-init.ts
//      `parseRedirects`, and its test): a 200 line is dropped there today, so the rule would silently do nothing.
// A 302 to the query form has none of those problems: `/ar/about` lands on `/about?locale=ar`, the page is the one
// Void prerendered, and `?locale=` is the first thing the translations plugin negotiates on (before
// `Accept-Language`), so the locale reaches the records API through the mechanism that already exists. The prefix
// is then an address people can link and share, which is all it was ever for.
//
// With `path: "query"` no rule is written at all: `?locale=` already works, and only the `hreflang` links are added.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alternatesOf, type LocaleSetup } from "../server/plugins/seo-locales";
import { escapeAttr, insertIntoHead, walkPublic } from "./pwa";

export interface LocalesOptions {
  /** the locales this site is served in; they have to be VOIDBASE_LOCALES when that is set too */
  codes: string[];
  /** `prefix` adds `/<code>/<path>` as an address for each locale; `query` leaves `?locale=` as the only one (default) */
  path?: "prefix" | "query";
  /** the locale the bare URL is in (default: the first code); it must be VOIDBASE_LOCALES' source locale */
  default?: string;
}

export interface LocalesResult {
  /** the locales, the default first */
  codes: string[];
  /** the locale the bare URL is in */
  default: string;
  mode: "prefix" | "query";
  /** the site URL the links are absolute against, "" when VOIDBASE_SITE_URL is not set and they are relative */
  site: string;
  /** the `_redirects` lines this pass added */
  rules: string[];
  /** the prerendered pages that were tagged */
  pages: string[];
}

/** VOIDBASE_LOCALES, the knob the translations and seo plugins read, as a list */
export const declaredLocales = (env: NodeJS.ProcessEnv = process.env): string[] =>
  String(env.VOIDBASE_LOCALES ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const TAG = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/;

/**
 * The option as the rest of this file uses it: the codes lowercased with the default first (the order
 * `localizedUrl` reads as "the first is the source"), checked against VOIDBASE_LOCALES when that is set.
 * A disagreement is a build error with both lists, because `hreflang` links naming a locale the API does not
 * answer in are worse than no links at all.
 */
export function resolveLocales(opts: LocalesOptions, env: NodeJS.ProcessEnv = process.env): { setup: LocaleSetup; default: string; site: string } {
  const codes = [...new Set(opts.codes.map((c) => c.trim().toLowerCase()).filter(Boolean))];
  if (!codes.length) throw new Error("voidbase: locales.codes is empty: name the locales the site is served in, such as { codes: [\"en\", \"ar\"] }.");
  const bad = codes.filter((c) => !TAG.test(c));
  if (bad.length) throw new Error(`voidbase: locales.codes has ${bad.map((c) => JSON.stringify(c)).join(", ")}, which ${bad.length === 1 ? "is not a language tag" : "are not language tags"} like en or pt-br.`);
  const fallback = opts.default?.trim().toLowerCase() || codes[0]!;
  if (!codes.includes(fallback)) throw new Error(`voidbase: locales.default is ${JSON.stringify(fallback)}, which is not one of locales.codes (${codes.join(", ")}). The default is the locale the bare URL is in.`);
  const declared = declaredLocales(env);
  if (declared.length) {
    const same = declared.length === codes.length && declared.every((c) => codes.includes(c));
    if (!same || declared[0] !== fallback) {
      throw new Error([
        "voidbase: locales: the adapter's locales and VOIDBASE_LOCALES do not agree, so the hreflang links would name locales the API does not answer in.",
        `  locales.codes     ${codes.join(", ")}   (default ${fallback})`,
        `  VOIDBASE_LOCALES  ${declared.join(", ")}   (source ${declared[0]})`,
        "Make them the same list: VOIDBASE_LOCALES' first locale is the source one, and has to be the option's default.",
      ].join("\n"));
    }
  }
  const mode = opts.path === "prefix" ? "prefix" : "query";
  const site = String(env.VOIDBASE_SITE_URL ?? "").trim().replace(/\/+$/, "");
  return { setup: { locales: [fallback, ...codes.filter((c) => c !== fallback)], mode }, default: fallback, site };
}

/** the URL a prerendered page is served at: /index.html is /, /docs/index.html is /docs/, /faq.html is /faq */
export function pageUrl(path: string): string {
  if (path.endsWith("/index.html")) return path.slice(0, -"index.html".length);
  return path.endsWith(".html") ? path.slice(0, -".html".length) : path;
}

/** the `_redirects` lines for one locale: the prefix alone and everything under it, to the same page in that locale */
export function localeRules(code: string, isDefault: boolean): string[] {
  const query = isDefault ? "" : `?locale=${encodeURIComponent(code)}`;
  return [`/${code} /${query} 302`, `/${code}/* /:splat${query} 302`];
}

/** the same links the seo plugin puts in the sitemap and the meta answer, for one page */
export function alternateLinks(site: string, url: string, setup: LocaleSetup): string {
  return alternatesOf(site, site + url, setup).map((a) => `<link rel="alternate" hreflang="${escapeAttr(a.locale)}" href="${escapeAttr(a.url)}">`).join("");
}

/**
 * Sets the page's language. A page that already says one keeps it when it is the same language (`en-GB` stays
 * `en-GB` under `en`); a page with no `<html>` element gets one opened after the doctype, which is the only place
 * the attribute can live.
 */
export function setLang(html: string, code: string): string {
  const tag = /<html(\s[^>]*)?>/i.exec(html);
  if (!tag) {
    const doctype = /<!doctype[^>]*>/i.exec(html);
    const at = doctype ? doctype.index + doctype[0].length : 0;
    return html.slice(0, at) + `<html lang="${escapeAttr(code)}">` + html.slice(at);
  }
  const attrs = tag[1] ?? "";
  const has = /\blang\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
  const current = has ? (has[2] ?? has[3] ?? has[4] ?? "") : "";
  if (current && current.split("-")[0]!.toLowerCase() === code.split("-")[0]!.toLowerCase()) return html;
  const next = has ? attrs.replace(has[0], `lang="${escapeAttr(code)}"`) : `${attrs} lang="${escapeAttr(code)}"`;
  return html.slice(0, tag.index) + `<html${next}>` + html.slice(tag.index + tag[0].length);
}

/** whether the page already carries this pass's links, so a second run over the same file changes nothing */
const hasAlternates = (html: string) => /<link[^>]*\brel=["']?alternate["']?[^>]*\bhreflang\b/i.test(html);

/**
 * Appends the rules to <dir>/_redirects, leaving a path something already rules alone, exactly as the seo pass
 * does. Returns the lines it added.
 */
export function writeLocaleRedirects(dir: string, rules: string[]): string[] {
  if (!rules.length) return [];
  const file = join(dir, "_redirects");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const ruled = new Set(current.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
  const lines = rules.filter((l) => !ruled.has(l.split(" ")[0]!));
  if (!lines.length) return [];
  writeFileSync(file, `${current.trimEnd()}${current.trim() ? "\n" : ""}${lines.join("\n")}\n`);
  return lines;
}

/**
 * The whole pass: the rules (prefix mode only) and, on every prerendered page, the `hreflang` links and the
 * `lang` attribute. Idempotent, so a second build over the same pb_public writes the same bytes.
 */
export function writeLocales(publicDir: string, opts: LocalesOptions, env: NodeJS.ProcessEnv = process.env): LocalesResult {
  const { setup, default: fallback, site } = resolveLocales(opts, env);
  if (!existsSync(publicDir) || !statSync(publicDir).isDirectory()) return { codes: setup.locales, default: fallback, mode: setup.mode, site, rules: [], pages: [] };

  const rules = setup.mode === "prefix" ? setup.locales.flatMap((code) => localeRules(code, code === fallback)) : [];
  // a rule is applied before the asset layer looks for a file, so a real directory named like a locale would stop
  // being reachable: say so rather than let a page disappear
  if (setup.mode === "prefix") {
    for (const code of setup.locales) {
      if (existsSync(join(publicDir, code))) console.warn(`voidbase: locales: the build has ${code}/ in pb_public, and the /${code}/* rule is applied before the asset layer looks for a file: those files are no longer reachable. Rename the directory, or use path: "query".`);
    }
  }
  const written = writeLocaleRedirects(publicDir, rules);

  const pages: string[] = [];
  for (const path of walkPublic(publicDir)) {
    if (!path.endsWith(".html")) continue;
    const file = join(publicDir, path);
    const html = readFileSync(file, "utf8");
    // the 404 shell is served for every unknown path, so it has no page of its own to name alternates for
    const links = path === "/404.html" || hasAlternates(html) ? "" : alternateLinks(site, pageUrl(path), setup);
    const next = insertIntoHead(setLang(html, fallback), links);
    if (next !== html) writeFileSync(file, next);
    pages.push(path);
  }
  return { codes: setup.locales, default: fallback, mode: setup.mode, site, rules: written, pages };
}
