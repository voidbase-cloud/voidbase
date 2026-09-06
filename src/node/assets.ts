// The ASSETS fetcher for `voidbase serve`: the admin panel under /_/ and the public directory for everything else.
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
export function assetsFetcher(opts: { panelDir: string; publicDir?: string }) {
  // Cloudflare's asset layer resolves an extensionless path against `<path>.html` and `<path>/index.html`
  // (html_handling "auto-trailing-slash"); a static site generator writes one shape or the other, so the Bun
  // runtime tries both and a deep link behaves the same on either runtime.
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  const file = (root: string, rel: string): string | null => {
    const p = normalize(join(root, rel));
    if (!p.startsWith(normalize(root))) return null;
    if (isFile(p)) return p;
    const html = p.replace(/\/$/, "") + ".html";
    if (html !== ".html" && isFile(html)) return html;
    const index = join(p, "index.html");
    return existsSync(index) ? index : null;
  };
  return {
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url); const path = decodeURIComponent(url.pathname);
      const target = path === "/_" || path.startsWith("/_/") ? file(opts.panelDir, path.slice(2) || "/") : opts.publicDir ? file(opts.publicDir, path) : null;
      if (!target) return new Response("not found", { status: 404 });
      const f = Bun.file(target);
      const headers = { "content-type": f.type || "application/octet-stream", "content-length": String(f.size) };
      return new Response(req.method === "HEAD" ? null : f, { status: 200, headers });
    },
  };
}
