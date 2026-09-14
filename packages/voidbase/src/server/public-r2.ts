// pb_public on a vanilla instance on Cloudflare (voidbase-stories voidbase/pb-public.feature: "Uploading assets on a vanilla
// instance", "Uploaded assets survive a redeploy"). A Worker cannot write the assets it was deployed with, so what the panel
// uploads is kept in the instance's own bucket, beside an index of the paths, and served from there: straight away, and
// through every rebuild and update, which change the Worker and never the bucket. A release routes every path to the Worker
// first (src/node/bundle.ts); a path nobody uploaded answers 404 here, and Void's entry serves the deployed asset instead.
import { publicPath } from "./public-files";

export const PUBLIC_PREFIX = "_voidbase/public/";
const INDEX = `${PUBLIC_PREFIX}index.json`;
interface Index { files: Record<string, number> }

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json", map: "application/json", txt: "text/plain; charset=utf-8", xml: "application/xml", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg",
  jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", pdf: "application/pdf", woff: "font/woff", woff2: "font/woff2", wasm: "application/wasm",
};
export const contentTypeOf = (path: string): string => MIME[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
/** an upload's object key: its dots escaped, since the REST API that deletes an instance's bucket refuses a path holding "..." */
export const publicObjectKey = (path: string): string => `${PUBLIC_PREFIX}files/${path.replace(/\./g, "%2E")}`;

// the index, read once per isolate for a few seconds: an upload made through another isolate is served within that time
let cached: { at: number; bucket: R2Bucket; index: Index } | null = null;
const TTL_MS = 5_000;
async function readIndex(bucket: R2Bucket, fresh = false): Promise<Index> {
  if (!fresh && cached && cached.bucket === bucket && Date.now() - cached.at < TTL_MS) return cached.index;
  const o = await bucket.get(INDEX);
  const index = o ? (JSON.parse(await o.text()) as Index) : { files: {} };
  cached = { at: Date.now(), bucket, index };
  return index;
}

export interface R2PublicFiles { list(): Promise<{ path: string; size: number }[]>; write(path: string, bytes: Uint8Array): Promise<void> }

export function r2PublicFiles(bucket: R2Bucket): R2PublicFiles {
  return {
    async list() {
      const index = await readIndex(bucket, true);
      return Object.entries(index.files).sort(([a], [b]) => a.localeCompare(b)).map(([path, size]) => ({ path, size }));
    },
    async write(path, bytes) {
      await bucket.put(publicObjectKey(path), bytes, { httpMetadata: { contentType: contentTypeOf(path) } });
      const index = await readIndex(bucket, true);
      index.files[path] = bytes.length;
      await bucket.put(INDEX, JSON.stringify(index));
      cached = { at: Date.now(), bucket, index };
    },
  };
}

/** the upload at the path a request names, or null: GET and HEAD outside the API, the panel and Void's own paths */
export async function servePublic(bucket: R2Bucket, request: Request): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (/^\/(api|_|__void)(\/|$)/.test(url.pathname)) return null;
  let raw: string;
  try { raw = decodeURIComponent(url.pathname); } catch { return null; }
  if (raw.endsWith("/")) raw += "index.html";
  const path = publicPath(raw);
  if (!path) return null;
  if (!((await readIndex(bucket)).files[path] >= 0)) return null;
  const o = await bucket.get(publicObjectKey(path));
  if (!o) return null;
  return new Response(request.method === "HEAD" ? null : (o as unknown as { body: ReadableStream }).body, { status: 200, headers: { "content-type": contentTypeOf(path), "cache-control": "no-store" } });
}
