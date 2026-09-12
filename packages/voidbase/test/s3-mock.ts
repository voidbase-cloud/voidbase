// In-memory S3-compatible server for tests (path-style, ListObjectsV2, Range GETs) that verifies AWS Signature v4
// with fixed credentials, so both PocketBase and voidbase must sign exactly right. Inspect/clear a bucket without a
// signature at GET/DELETE /__inspect/<bucket>.
//   bun test/s3-mock.ts [port=5195]        credentials: AKIATEST / secret123
const port = Number(process.argv[2] ?? 5195);
const ACCESS = "AKIATEST", SECRET = "secret123";
interface Obj { bytes: Uint8Array; type: string; mtime: Date; etag: string }
const buckets = new Map<string, Map<string, Obj>>();
const bucket = (b: string) => { if (!buckets.has(b)) buckets.set(b, new Map()); return buckets.get(b)!; };
const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (d: Uint8Array | string) => hex(await crypto.subtle.digest("SHA-256", typeof d === "string" ? enc.encode(d) : (d as unknown as ArrayBuffer)));
const hmac = async (key: ArrayBuffer | Uint8Array, data: string) => crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key as unknown as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), enc.encode(data));
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const escapePath = (p: string) => p.split("/").map((seg) => rfc3986(decodeURIComponent(seg))).join("/");
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const err = (status: number, code: string, message: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEsc(message)}</Message></Error>`, { status, headers: { "content-type": "application/xml" } });

async function verify(req: Request, url: URL, body: Uint8Array): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]+)$/.exec(auth);
  if (!m) return "missing or malformed Authorization header";
  const [, access, date, region, signedHeaders, signature] = m as unknown as [string, string, string, string, string, string];
  if (access !== ACCESS) return "unknown access key";
  const names = signedHeaders.split(";");
  const canonicalHeaders = names.map((n) => `${n}:${(n === "host" ? url.host : req.headers.get(n) ?? "").trim().replace(/\s+/g, " ")}\n`).join("");
  const query = [...url.searchParams.entries()].map(([k, v]) => [rfc3986(k), rfc3986(v)] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const payloadHash = req.headers.get("x-amz-content-sha256") ?? "";
  if (payloadHash !== "UNSIGNED-PAYLOAD" && payloadHash !== (await sha256(body))) return "payload hash mismatch";
  const canonical = [req.method, escapePath(url.pathname), query, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", req.headers.get("x-amz-date") ?? "", scope, await sha256(canonical)].join("\n");
  let key: ArrayBuffer = await hmac(enc.encode("AWS4" + SECRET), date);
  for (const part of [region, "s3", "aws4_request"]) key = await hmac(key, part);
  const expected = hex(await hmac(key, toSign));
  return expected === signature ? null : `signature mismatch; canonical request was:\n${canonical}`;
}

Bun.serve({
  port, hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const [, b, ...rest] = url.pathname.split("/");
    if (b === "__inspect") {
      const store = bucket(rest[0] ?? "");
      if (req.method === "DELETE") { store.clear(); return new Response(null, { status: 204 }); }
      return Response.json([...store.entries()].map(([k, o]) => ({ key: k, size: o.bytes.byteLength, type: o.type })).sort((a, c) => (a.key < c.key ? -1 : 1)));
    }
    const body = new Uint8Array(await req.arrayBuffer());
    const bad = await verify(req, url, body);
    if (bad) { console.error(`[s3-mock] ${req.method} ${url.pathname}: ${bad}`); return err(403, "SignatureDoesNotMatch", bad); }
    if (!b) return err(400, "InvalidRequest", "bucket missing");
    if (!buckets.has(b) && !["pb", "vb", "pbbk", "vbbk"].includes(b)) return err(404, "NoSuchBucket", "The specified bucket does not exist");
    const store = bucket(b);
    const key = rest.map((s) => decodeURIComponent(s)).join("/");
    if (!key) {
      if (req.method !== "GET") return err(405, "MethodNotAllowed", "unsupported bucket operation");
      const prefix = url.searchParams.get("prefix") ?? ""; const max = Number(url.searchParams.get("max-keys") ?? 1000); const token = url.searchParams.get("continuation-token") ?? "";
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix) && (!token || k > token)).sort();
      const page = keys.slice(0, max); const truncated = keys.length > max;
      const contents = page.map((k) => { const o = store.get(k)!; return `<Contents><Key>${xmlEsc(k)}</Key><LastModified>${o.mtime.toISOString()}</LastModified><ETag>&quot;${o.etag}&quot;</ETag><Size>${o.bytes.byteLength}</Size><StorageClass>STANDARD</StorageClass></Contents>`; }).join("");
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${b}</Name><Prefix>${xmlEsc(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${xmlEsc(page.at(-1)!)}</NextContinuationToken>` : ""}${contents}</ListBucketResult>`, { headers: { "content-type": "application/xml" } });
    }
    if (req.method === "PUT") { const etag = (await sha256(body)).slice(0, 32); store.set(key, { bytes: body, type: req.headers.get("content-type") ?? "application/octet-stream", mtime: new Date(), etag }); return new Response(null, { status: 200, headers: { etag: `"${etag}"` } }); }
    if (req.method === "DELETE") { store.delete(key); return new Response(null, { status: 204 }); }
    const o = store.get(key);
    if (!o) return err(404, "NoSuchKey", "The specified key does not exist.");
    const headers: Record<string, string> = { "content-type": o.type, "last-modified": o.mtime.toUTCString(), etag: `"${o.etag}"`, "accept-ranges": "bytes" };
    if (req.method === "HEAD") return new Response(null, { status: 200, headers: { ...headers, "content-length": String(o.bytes.byteLength) } });
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
    if (range) {
      const total = o.bytes.byteLength; const start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2])); const end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
      if (start >= total || start > end) return err(416, "InvalidRange", "The requested range is not satisfiable");
      return new Response(o.bytes.slice(start, end + 1), { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${total}`, "content-length": String(end - start + 1) } });
    }
    return new Response(o.bytes, { status: 200, headers: { ...headers, "content-length": String(o.bytes.byteLength) } });
  },
});
console.log(`s3 mock on http://127.0.0.1:${port} (buckets pb, vb, pbbk, vbbk; ${ACCESS}/${SECRET})`);
