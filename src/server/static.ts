// PocketBase static serving for `voidbase serve` (Bun) for everything outside /api (on Cloudflare the asset layer does this, see docs/differences.md): the matching file when there is one, otherwise the app's
// index.html (200); the admin panel under /_/ falls back to its own index.html; /api keeps its JSON 404s.
const PASSTHROUGH = ["/api/", "/__void", "/cdn-cgi/"];
export interface AssetFetcher { fetch(req: Request): Promise<Response> }
export async function staticFallback(req: Request, assets: AssetFetcher | undefined): Promise<Response | null> {
  const url = new URL(req.url); const path = url.pathname;
  if (!assets || PASSTHROUGH.some((p) => path === p.slice(0, -1) || path.startsWith(p))) return null;
  if (req.method === "GET" || req.method === "HEAD") {
    const file = await assets.fetch(new Request(url, { method: req.method, headers: req.headers }));
    if (file.status !== 404) return file;
  }
  const index = path === "/_" || path.startsWith("/_/") ? "/_/index.html" : "/index.html";
  const shell = await assets.fetch(new Request(new URL(index, url), { method: "GET", headers: { accept: "text/html" } }));
  if (!shell.ok) return null;
  const headers = new Headers(shell.headers); headers.delete("content-length");
  return new Response(shell.body, { status: 200, headers });
}
