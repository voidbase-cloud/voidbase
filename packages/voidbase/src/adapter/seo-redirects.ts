// The _redirects rules that carry /robots.txt, /sitemap.xml and /llms.txt to the seo plugin on a deployed Worker.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seoRedirectLines } from "../server/plugins/seo-paths";

/**
 * Appends to <dir>/_redirects the rules that send /robots.txt, /sitemap.xml and /llms.txt to the seo plugin's
 * /api/seo path when the static files do not carry them: on Cloudflare the asset layer answers every path outside
 * /api, so without this a deployed Worker never sees the request. A real file in the build keeps winning (no rule).
 */
export function writeSeoRedirects(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const file = join(dir, "_redirects");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const lines = seoRedirectLines((p) => existsSync(join(dir, p))).filter((l) => !current.split("\n").some((c) => c.trim().split(/\s+/)[0] === l.split(" ")[0]));
  if (!lines.length) return [];
  writeFileSync(file, `${current.trimEnd()}${current.trim() ? "\n" : ""}${lines.join("\n")}\n`);
  return lines;
}
