// Where a locale sits in a URL, and the alternates of one page. Shared by the seo plugin (seo-meta.ts), which puts
// them in the sitemap and the meta answer, and by the Void adapter (src/adapter/locales.ts), which writes the same
// links into the prerendered pages at build time: the two cannot disagree because they are the same four functions.
// Like seo-paths.ts, this file imports nothing, so the adapter never pulls the server in.
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
