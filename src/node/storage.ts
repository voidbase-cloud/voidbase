/// <reference types="@cloudflare/workers-types" />
// R2Bucket on the filesystem: keys are paths under the root, object metadata lives in .meta/<key>.json.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
interface Meta { contentType?: string; uploaded: string; etag: string; size: number }
interface Obj { key: string; size: number; uploaded: Date; etag: string; httpMetadata: { contentType?: string } }
export class FsBucket {
  constructor(private root: string) { mkdirSync(join(root, ".meta"), { recursive: true }); }
  private path(key: string) { return join(this.root, key); }
  private metaPath(key: string) { return join(this.root, ".meta", `${key}.json`); }
  private meta(key: string): Meta | null { try { return JSON.parse(readFileSync(this.metaPath(key), "utf8")) as Meta; } catch { return null; } }
  private obj(key: string): Obj | null {
    const p = this.path(key); if (!existsSync(p) || !statSync(p).isFile()) return null;
    const m = this.meta(key); const st = statSync(p);
    return { key, size: st.size, uploaded: new Date(m?.uploaded ?? st.mtimeMs), etag: m?.etag ?? String(st.mtimeMs), httpMetadata: { contentType: m?.contentType } };
  }
  async head(key: string) { return this.obj(key); }
  async get(key: string, opts?: { range?: { offset: number; length: number } }) {
    const o = this.obj(key); if (!o) return null;
    const file = Bun.file(this.path(key));
    const part = opts?.range ? file.slice(opts.range.offset, opts.range.offset + opts.range.length) : file;
    return { ...o, body: part.stream(), arrayBuffer: () => part.arrayBuffer(), text: () => part.text(), json: <T>() => part.json() as Promise<T> };
  }
  async put(key: string, value: ArrayBuffer | Uint8Array | string | ReadableStream | Blob | null, opts?: { httpMetadata?: { contentType?: string } }) {
    let bytes: Uint8Array;
    if (value === null) bytes = new Uint8Array();
    else if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else if (value instanceof Uint8Array) bytes = value;
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (value instanceof Blob) bytes = new Uint8Array(await value.arrayBuffer());
    else bytes = new Uint8Array(await new Response(value).arrayBuffer());
    mkdirSync(dirname(this.path(key)), { recursive: true }); mkdirSync(dirname(this.metaPath(key)), { recursive: true });
    writeFileSync(this.path(key), bytes);
    const meta: Meta = { contentType: opts?.httpMetadata?.contentType, uploaded: new Date().toISOString(), etag: Bun.hash(bytes).toString(16), size: bytes.byteLength };
    writeFileSync(this.metaPath(key), JSON.stringify(meta));
    return { key, size: meta.size, uploaded: new Date(meta.uploaded), etag: meta.etag, httpMetadata: { contentType: meta.contentType } };
  }
  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) { rmSync(this.path(key), { force: true }); rmSync(this.metaPath(key), { force: true }); }
  }
  async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const keys: string[] = [];
    const walk = (dir: string) => { if (!existsSync(dir)) return; for (const e of readdirSync(dir, { withFileTypes: true })) { if (dir === this.root && e.name === ".meta") continue; const p = join(dir, e.name); if (e.isDirectory()) walk(p); else keys.push(relative(this.root, p).split("\\").join("/")); } };
    walk(this.root);
    const prefix = opts.prefix ?? ""; const limit = opts.limit ?? 1000;
    const all = keys.filter((k) => k.startsWith(prefix) && (!opts.cursor || k > opts.cursor)).sort();
    const page = all.slice(0, limit);
    return { objects: page.map((k) => this.obj(k)!).filter(Boolean), truncated: all.length > limit, cursor: all.length > limit ? page.at(-1) : undefined, delimitedPrefixes: [] as string[] };
  }
}
export const fsBucket = (root: string) => new FsBucket(root) as unknown as R2Bucket;
