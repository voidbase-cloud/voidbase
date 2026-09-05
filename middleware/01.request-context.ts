// Global middleware. Its presence puts the Worker in front of every request (Void's "worker owns HTML" shape),
// and routing.notFound = "none" leaves unmatched requests to us. We mirror PocketBase's static serving: a request
// outside /api is answered by the matching file when there is one, otherwise by the app's index.html (200); the
// admin panel under /_/ falls back to its own index.html; /api keeps its JSON 404s. Request logging lands here later.
import { defineMiddleware } from "void";

const PASSTHROUGH = ["/api/", "/__void", "/cdn-cgi/"];

export default defineMiddleware(async (c, next) => {
  await next();
  if (c.res.status !== 404) return;
  const url = new URL(c.req.url);
  const path = url.pathname;
  if (PASSTHROUGH.some((p) => path === p.slice(0, -1) || path.startsWith(p))) return;
  const assets = (c.env as unknown as { ASSETS?: Fetcher }).ASSETS;
  if (!assets) return;
  // the file itself (dev does not always run the asset step before the worker), then the index fallback
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    const file = await assets.fetch(new Request(url, { method: c.req.method, headers: c.req.raw.headers }));
    if (file.status !== 404) { c.res = file; return; }
  }
  const index = path === "/_" || path.startsWith("/_/") ? "/_/index.html" : "/index.html";
  const shell = await assets.fetch(new Request(new URL(index, url), { method: "GET", headers: { accept: "text/html" } }));
  if (!shell.ok) return;
  const headers = new Headers(shell.headers);
  headers.delete("content-length");
  c.res = new Response(shell.body, { status: 200, headers });
});
