// Batch API conformance (apis/batch.go): create/update/upsert/delete in one request, files through multipart,
// PocketBase's error shape and rollback on failure, guard conditions.
//   bun test/conformance/batch.ts [pb] [vb]
const PB = process.argv[2] ?? "http://127.0.0.1:8090";
const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
class Server {
  h: Record<string, string> = {}; savedBatch: unknown = null;
  constructor(public base: string) {}
  async api(method: string, path: string, body?: BodyInit | object, headers: Record<string, string> = {}, raw = false) {
    const isForm = body instanceof FormData;
    const r = await fetch(`${this.base}${path}`, { method, headers: { ...headers, ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : isForm ? body : raw ? (body as BodyInit) : JSON.stringify(body) });
    const text = await r.text(); let json: unknown = null; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, json };
  }
  async setup() {
    const a = await this.api("POST", "/api/collections/_superusers/auth-with-password", CREDS); this.h = { authorization: String((a.json as { token: string }).token) };
    this.savedBatch = ((await this.api("GET", "/api/settings", undefined, this.h)).json as { batch: unknown }).batch;
    await this.api("PATCH", "/api/settings", { batch: { enabled: true, maxRequests: 5, timeout: 3, maxBodySize: 0 } }, this.h);
    await this.api("DELETE", "/api/collections/ks_batch", undefined, this.h);
    const cr = await this.api("POST", "/api/collections", { name: "ks_batch", type: "base", listRule: "", viewRule: "", fields: [{ name: "title", type: "text", required: true }, { name: "n", type: "number" }, { name: "img", type: "file", maxSelect: 1 }] }, this.h);
    if (cr.status !== 200) throw new Error(`${this.base} create ks_batch ${cr.status} ${JSON.stringify(cr.json)}`);
  }
  async teardown() { await this.api("DELETE", "/api/collections/ks_batch", undefined, this.h); await this.api("PATCH", "/api/settings", { batch: this.savedBatch }, this.h); }
}
const pb = new Server(PB), vb = new Server(VB); await pb.setup(); await vb.setup();
let pass = 0, fail = 0;
const step = async (label: string, run: (s: Server) => Promise<unknown>) => {
  const [a, b] = await Promise.all([run(pb).catch((e) => ({ error: String(e) })), run(vb).catch((e) => ({ error: String(e) }))]);
  const same = JSON.stringify(a) === JSON.stringify(b); same ? pass++ : fail++;
  console.log(`${same ? "PASS" : "FAIL"}  ${label.padEnd(44)} pb=${JSON.stringify(a).slice(0, 360)}${same ? "" : `\n      vb=${JSON.stringify(b).slice(0, 800)}`}`);
};
const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replace(/"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z"/g, '"<TS>"').replace(/_[a-z0-9]{10}\.png/g, "_X.png"));
const A = "ksbatch0000000a", B = "ksbatch0000000b";
try {
  await step("upsert create, upsert update, patch, delete, create", async (s) => {
    const r = await s.api("POST", "/api/batch", { requests: [
      { method: "PUT", url: "/api/collections/ks_batch/records", body: { id: A, title: "a", n: 1 } },
      { method: "PUT", url: "/api/collections/ks_batch/records", body: { id: B, title: "b", n: 2 } },
      { method: "PUT", url: "/api/collections/ks_batch/records", body: { id: A, title: "a2", n: 10 } },
      { method: "PATCH", url: `/api/collections/ks_batch/records/${B}?fields=id,title,n`, body: { n: 20 } },
      { method: "DELETE", url: `/api/collections/ks_batch/records/${B}` },
    ] }, s.h);
    return { status: r.status, results: norm(r.json) };
  });
  await step("state after the batch", async (s) => { const l = await s.api("GET", "/api/collections/ks_batch/records?sort=id&fields=id,title,n"); return norm((l.json as { items: unknown }).items); });
  await step("failure rolls everything back", async (s) => {
    const r = await s.api("POST", "/api/batch", { requests: [
      { method: "POST", url: "/api/collections/ks_batch/records", body: { title: "should-not-persist", n: 5 } },
      { method: "PATCH", url: `/api/collections/ks_batch/records/${A}`, body: { n: 999 } },
      { method: "POST", url: "/api/collections/ks_batch/records", body: { n: 5 } },
    ] }, s.h);
    const l = await s.api("GET", "/api/collections/ks_batch/records?sort=id&fields=id,title,n");
    return { status: r.status, body: r.json, after: norm((l.json as { items: unknown }).items) };
  });
  await step("multipart batch with a file", async (s) => {
    const fd = new FormData();
    fd.append("@jsonPayload", JSON.stringify({ requests: [{ method: "POST", url: "/api/collections/ks_batch/records", body: { title: "with file", n: 3 } }] }));
    fd.append("requests.0.img", new File([PNG as BlobPart], "pixel.png", { type: "image/png" }));
    const r = await s.api("POST", "/api/batch", fd, s.h);
    const res = r.json as { status: number; body: Record<string, unknown> }[];
    return { status: r.status, itemStatus: res?.[0]?.status, img: String(res?.[0]?.body?.img ?? "").replace(/(_[a-z0-9]{10})+\.png/, "_X.png"), title: res?.[0]?.body?.title };
  });
  await step("unknown action", async (s) => { const r = await s.api("POST", "/api/batch", { requests: [{ method: "GET", url: "/api/collections/ks_batch/records" }] }, s.h); return { status: r.status, body: r.json }; });
  await step("too many requests", async (s) => { const r = await s.api("POST", "/api/batch", { requests: Array.from({ length: 6 }, () => ({ method: "POST", url: "/api/collections/ks_batch/records", body: { title: "x" } })) }, s.h); return { status: r.status, body: r.json }; });
  await step("empty requests", async (s) => { const r = await s.api("POST", "/api/batch", { requests: [] }, s.h); return { status: r.status, body: r.json }; });
  await step("anonymous create refused inside the batch", async (s) => { const r = await s.api("POST", "/api/batch", { requests: [{ method: "POST", url: "/api/collections/ks_batch/records", body: { title: "anon" } }] }); return { status: r.status, body: r.json }; });
  await step("batch disabled", async (s) => { await s.api("PATCH", "/api/settings", { batch: { enabled: false } }, s.h); const r = await s.api("POST", "/api/batch", { requests: [{ method: "DELETE", url: `/api/collections/ks_batch/records/${A}` }] }, s.h); return { status: r.status, body: r.json }; });
} finally { await pb.teardown(); await vb.teardown(); }
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
