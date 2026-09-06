// S3-compatible file backend (settings.s3 / settings.backups.s3), the same subset of the R2Bucket API the server
// uses, over fetch with AWS Signature v4 (tools/filesystem/internal/s3blob semantics: path-style or virtual-host
// URLs, unsigned or sha256 payloads, ListObjectsV2). Chosen per request when settings.s3.enabled, so the rest of
// the code keeps talking to `STORAGE` whether it is R2 or S3.
export interface S3Config { enabled: boolean; bucket: string; region: string; endpoint: string; accessKey: string; secret: string; forcePathStyle: boolean }

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (data: Uint8Array | string) => hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : (data as unknown as ArrayBuffer)));
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key as unknown as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}
// RFC 3986 encoding as the S3 canonical request wants it (space -> %20, keep unreserved)
export const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const escapePath = (path: string) => path.split("/").map((seg) => rfc3986(decodeURIComponent(seg))).join("/");
export const amzDate = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export async function signV4(req: { method: string; url: URL; headers: Record<string, string>; payloadHash: string }, cfg: { accessKey: string; secret: string; region: string }, now = new Date()): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...req.headers, host: req.url.host, "x-amz-content-sha256": req.payloadHash, "x-amz-date": amzDate(now) };
  const date = headers["x-amz-date"]!.slice(0, 8);
  const names = Object.keys(headers).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = names.map((k) => `${k}:${String(headers[Object.keys(headers).find((h) => h.toLowerCase() === k)!]).trim().replace(/\s+/g, " ")}\n`).join("");
  const query = [...req.url.searchParams.entries()].map(([k, v]) => [rfc3986(k), rfc3986(v)] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [req.method, escapePath(req.url.pathname), query, canonicalHeaders, names.join(";"), req.payloadHash].join("\n");
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", headers["x-amz-date"], scope, await sha256(canonical)].join("\n");
  let key: ArrayBuffer = await hmac(enc.encode("AWS4" + cfg.secret), date);
  for (const part of [cfg.region, "s3", "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  delete headers.host; // fetch sets it
  return headers;
}

export class S3Error extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
const xmlText = (xml: string, tag: string) => { const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml); return m ? m[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&") : null; };

interface StoredObject { key: string; size: number; uploaded: Date; etag: string; httpMetadata: { contentType?: string } }
export class S3Bucket {
  constructor(private cfg: S3Config) {}
  private url(key: string, query: Record<string, string> = {}): URL {
    const raw = this.cfg.endpoint.includes("://") ? this.cfg.endpoint : `https://${this.cfg.endpoint}`;
    const ep = new URL(raw);
    const path = key.split("/").map(rfc3986).join("/");
    const u = this.cfg.forcePathStyle || !this.cfg.endpoint ? new URL(`${ep.protocol}//${ep.host}/${rfc3986(this.cfg.bucket)}${path ? "/" + path : ""}`) : new URL(`${ep.protocol}//${this.cfg.bucket}.${ep.host}/${path}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }
  private async send(method: string, key: string, opts: { query?: Record<string, string>; headers?: Record<string, string>; body?: Uint8Array; allow404?: boolean } = {}): Promise<Response> {
    const url = this.url(key, opts.query);
    const payloadHash = opts.body ? await sha256(opts.body) : "UNSIGNED-PAYLOAD";
    const headers = await signV4({ method, url, headers: { ...(opts.headers ?? {}) }, payloadHash }, this.cfg);
    const res = await fetch(url, { method, headers, body: opts.body as unknown as BodyInit | undefined });
    if (res.status >= 400 && !(opts.allow404 && res.status === 404)) {
      const text = await res.text();
      throw new S3Error(res.status, xmlText(text, "Code") ?? String(res.status), xmlText(text, "Message") ?? text.slice(0, 200) ?? `HTTP ${res.status}`);
    }
    return res;
  }
  private meta(key: string, res: Response): StoredObject {
    const cr = /bytes \d+-\d+\/(\d+)/.exec(res.headers.get("content-range") ?? "");
    return { key, size: cr ? Number(cr[1]) : Number(res.headers.get("content-length") ?? 0), uploaded: new Date(res.headers.get("last-modified") ?? Date.now()), etag: (res.headers.get("etag") ?? "").replace(/"/g, ""), httpMetadata: { contentType: res.headers.get("content-type") ?? undefined } };
  }
  async head(key: string): Promise<StoredObject | null> {
    const res = await this.send("HEAD", key, { allow404: true });
    if (res.status === 404) return null;
    return this.meta(key, res);
  }
  async get(key: string, opts?: { range?: { offset: number; length: number } }): Promise<(StoredObject & { body: ReadableStream; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string>; json<T>(): Promise<T> }) | null> {
    const headers: Record<string, string> = {};
    if (opts?.range) headers.range = `bytes=${opts.range.offset}-${opts.range.offset + opts.range.length - 1}`;
    const res = await this.send("GET", key, { headers, allow404: true });
    if (res.status === 404) return null;
    const m = this.meta(key, res);
    return { ...m, body: res.body!, arrayBuffer: () => res.arrayBuffer(), text: () => res.text(), json: <T>() => res.json() as Promise<T> };
  }
  async put(key: string, value: ArrayBuffer | Uint8Array | string | ReadableStream | Blob | null, opts?: { httpMetadata?: { contentType?: string } }): Promise<StoredObject> {
    let bytes: Uint8Array;
    if (value === null) bytes = new Uint8Array();
    else if (typeof value === "string") bytes = enc.encode(value);
    else if (value instanceof Uint8Array) bytes = value;
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (value instanceof Blob) bytes = new Uint8Array(await value.arrayBuffer());
    else bytes = new Uint8Array(await new Response(value).arrayBuffer());
    const headers: Record<string, string> = { "content-length": String(bytes.byteLength) };
    if (opts?.httpMetadata?.contentType) headers["content-type"] = opts.httpMetadata.contentType;
    const res = await this.send("PUT", key, { headers, body: bytes });
    return { key, size: bytes.byteLength, uploaded: new Date(), etag: (res.headers.get("etag") ?? "").replace(/"/g, ""), httpMetadata: { contentType: opts?.httpMetadata?.contentType } };
  }
  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) await this.send("DELETE", key);
  }
  async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}): Promise<{ objects: StoredObject[]; truncated: boolean; cursor?: string; delimitedPrefixes: string[] }> {
    const query: Record<string, string> = { "list-type": "2", "max-keys": String(opts.limit ?? 1000) };
    if (opts.prefix) query.prefix = opts.prefix;
    if (opts.cursor) query["continuation-token"] = opts.cursor;
    const xml = await (await this.send("GET", "", { query })).text();
    const objects: StoredObject[] = [];
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const c = m[1]!;
      objects.push({ key: xmlText(c, "Key") ?? "", size: Number(xmlText(c, "Size") ?? 0), uploaded: new Date(xmlText(c, "LastModified") ?? Date.now()), etag: (xmlText(c, "ETag") ?? "").replace(/"/g, ""), httpMetadata: {} });
    }
    const truncated = xmlText(xml, "IsTruncated") === "true";
    return { objects, truncated, cursor: truncated ? xmlText(xml, "NextContinuationToken") ?? undefined : undefined, delimitedPrefixes: [] };
  }
  // forms/test_s3_filesystem.go: connect and list to prove the credentials and bucket work
  async test(): Promise<void> { await this.list({ limit: 1 }); }
}

export const s3Bucket = (cfg: S3Config) => new S3Bucket(cfg) as unknown as R2Bucket;

// Outside a request (queue jobs, crons) the settings.s3 swap that the bootstrap middleware does per request
export async function withS3Storage<E extends { DB: D1Database; STORAGE: R2Bucket }>(env: E): Promise<E> {
  const { loadSettings } = await import("../settings");
  const s3 = (await loadSettings(env.DB)).s3;
  return s3.enabled ? { ...env, STORAGE: s3Bucket(s3) } : env;
}
