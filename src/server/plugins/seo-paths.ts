// The seo plugin's paths, shared with the adapter (src/adapter/seo-redirects.ts) without pulling the server in.
/** where the three files are reachable on a deployed Worker (the asset layer redirects the root paths here) */
export const SEO_API = "/api/seo";
export const SEO_FILES = ["/robots.txt", "/sitemap.xml", "/llms.txt"] as const;
/** the _redirects lines the adapter writes for the files the app's static files do not carry themselves */
export const seoRedirectLines = (has: (path: string) => boolean): string[] =>
  SEO_FILES.filter((f) => !has(f)).map((f) => `${f} ${SEO_API}${f} 302`);

/**
 * The knob for the share card as PNG: `VOIDBASE_SEO_PNG=1`. Off by default, and off means off in two places at
 * once. At build time the hooks plugin aliases `#platform/raster` to a stub, so resvg's 2.4 MB of wasm and the
 * card's font stay out of the Worker (docs/platform.md); at runtime the plugin serves the card's SVG from the
 * `.png` URL and names the `.svg` in `og:image`, because pointing a scraper at a PNG nobody renders is worse than
 * naming the SVG. `voidbase deploy` reads it from the environment or the secrets file and bakes it as a var, so
 * the two halves cannot disagree on a deployed instance.
 */
export const SEO_PNG_VAR = "VOIDBASE_SEO_PNG";
/** whether a knob value means on: `1`, `true`, `on`, `yes`. Anything else, unset included, is off */
export const seoPngOn = (value: string | undefined): boolean => /^(1|true|on|yes)$/i.test(String(value ?? "").trim());
