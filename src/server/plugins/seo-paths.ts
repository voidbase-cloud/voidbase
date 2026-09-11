// The seo plugin's paths, shared with the adapter (src/adapter/seo-redirects.ts) without pulling the server in.
/** where the three files are reachable on a deployed Worker (the asset layer redirects the root paths here) */
export const SEO_API = "/api/seo";
export const SEO_FILES = ["/robots.txt", "/sitemap.xml", "/llms.txt"] as const;
/** the _redirects lines the adapter writes for the files the app's static files do not carry themselves */
export const seoRedirectLines = (has: (path: string) => boolean): string[] =>
  SEO_FILES.filter((f) => !has(f)).map((f) => `${f} ${SEO_API}${f} 302`);
