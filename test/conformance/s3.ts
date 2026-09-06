// S3 file backend, differential: both servers point settings.s3 (and settings.backups.s3) at test/s3-mock.ts, which
// verifies AWS SigV4 with fixed credentials. Connection test, upload, serve, thumb, range, delete cleanup, backups.
//   bun test/s3-mock.ts &   then   bun test/conformance/s3.ts [pb=http://127.0.0.1:8090] [vb=http://127.0.0.1:5180]
const PB = process.argv[2] ?? "http://127.0.0.1:8090"; const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const MOCK = "http://127.0.0.1:5195";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8BQz8DAwMDAxMAAAB8ABKQP6iEAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
class Server {
  h: Record<string, string> = {}; saved: Record<string, unknown> = {}; collId = ""; recId = ""; file = "";
  constructor(public base: string, public bucket: string) {}
  async api(method: string, path: string, body?: BodyInit | object, headers: Record<string, string> = {}) {
    const isForm = body instanceof FormData; const r = await fetch(`${this.base}${path}`, { method, headers: { ...headers, ...(body && !isForm ? { "content-type": "application/json" } : {}) }, body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
    const text = await r.text(); let json: Record<string, unknown> | null = null; try { json = JSON.parse(text); } catch { json = null; }
    return { status: r.status, json, headers: r.headers, text };
  }
  s3cfg(bucket: string, enabled = true) { return { enabled, bucket, region: "us-east-1", endpoint: MOCK, accessKey: "AKIATEST", secret: "secret123", forcePathStyle: true }; }
  async setup() {
    const a = await this.api("POST", "/api/collections/_superusers/auth-with-password", CREDS); this.h = { authorization: String(a.json?.token) };
    const cur = await this.api("GET", "/api/settings", undefined, this.h); this.saved = { s3: cur.json?.s3, backups: cur.json?.backups };
    await fetch(`${MOCK}/__inspect/${this.bucket}`, { method: "DELETE" }); await fetch(`${MOCK}/__inspect/${this.bucket}bk`, { method: "DELETE" });
    await this.api("DELETE", "/api/collections/ks_s3", undefined, this.h);
  }
  async teardown() {
    await this.api("DELETE", "/api/collections/ks_s3", undefined, this.h);
    const r = await this.api("PATCH", "/api/settings", { s3: { ...(this.saved.s3 as object), secret: "" }, backups: { ...(this.saved.backups as object), s3: { ...((this.saved.backups as { s3: object }).s3), secret: "" } } }, this.h);
    if (r.status !== 200) console.error(`${this.base}: settings restore failed ${r.status} ${r.text.slice(0, 200)}`);
  }
  async objects() { return (await fetch(`${MOCK}/__inspect/${this.bucket}`).then((r) => r.json())) as { key: string; size: number; type: string }[]; }
  norm(keys: { key: string; size: number; type: string }[]) { return keys.map((o) => ({ key: o.key.replace(this.collId, "<coll>").replace(this.recId, "<rec>").replace(/_[a-z0-9]{10}\./gi, "_<rand>."), size: o.size, type: o.type })); }
}
const pb = new Server(PB, "pb"), vb = new Server(VB, "vb");
await pb.setup(); await vb.setup();
let pass = 0, fail = 0;
const step = async (label: string, run: (s: Server) => Promise<unknown>) => {
  const [a, b] = await Promise.all([run(pb).catch((e) => ({ error: String(e) })), run(vb).catch((e) => ({ error: String(e) }))]);
  const same = JSON.stringify(a) === JSON.stringify(b); same ? pass++ : fail++;
  console.log(`${same ? "PASS" : "FAIL"}  ${label.padEnd(50)} ${JSON.stringify(b).slice(0, same ? 150 : 600)}${same ? "" : `\n      pb=${JSON.stringify(a).slice(0, 600)}`}`);
};
try {
  await step("enable s3 storage + backups s3", async (s) => { const r = await s.api("PATCH", "/api/settings", { s3: s.s3cfg(s.bucket), backups: { s3: s.s3cfg(s.bucket + "bk") } }, s.h); const s3 = { ...(r.json?.s3 as { bucket: string; secret?: string }) }; s3.bucket = s3.bucket === s.bucket ? "<bucket>" : s3.bucket; return { status: r.status, s3, backupsBucket: (r.json?.backups as { s3: { bucket: string } })?.s3.bucket === s.bucket + "bk" ? "<bucket>bk" : "other" }; });
  await step("test/s3 storage connection", async (s) => (await s.api("POST", "/api/settings/test/s3", { filesystem: "storage" }, s.h)).status);
  await step("test/s3 backups connection", async (s) => (await s.api("POST", "/api/settings/test/s3", { filesystem: "backups" }, s.h)).status);
  await step("test/s3 unknown bucket -> 400", async (s) => { await s.api("PATCH", "/api/settings", { s3: s.s3cfg("missing") }, s.h); const r = await s.api("POST", "/api/settings/test/s3", { filesystem: "storage" }, s.h); await s.api("PATCH", "/api/settings", { s3: s.s3cfg(s.bucket) }, s.h); return { status: r.status, raw: String(r.json?.message ?? "").startsWith("Failed to test the S3 filesystem. Raw error:") }; });
  await step("test/s3 bad credentials -> 400", async (s) => { await s.api("PATCH", "/api/settings", { s3: { ...s.s3cfg(s.bucket), secret: "wrong" } }, s.h); const r = await s.api("POST", "/api/settings/test/s3", { filesystem: "storage" }, s.h); await s.api("PATCH", "/api/settings", { s3: s.s3cfg(s.bucket) }, s.h); return { status: r.status, raw: String(r.json?.message ?? "").startsWith("Failed to test the S3 filesystem. Raw error:") }; });
  await step("create collection with file field", async (s) => { const r = await s.api("POST", "/api/collections", { name: "ks_s3", type: "base", listRule: "", viewRule: "", fields: [{ name: "title", type: "text" }, { name: "pic", type: "file", maxSelect: 2, thumbs: ["2x2", "1x1f"] }] }, s.h); s.collId = String(r.json?.id); return r.status; });
  await step("upload record file -> object in the S3 bucket", async (s) => {
    const fd = new FormData(); fd.append("title", "s3"); fd.append("pic", new Blob([PNG], { type: "image/png" }), "dot.png");
    const r = await s.api("POST", "/api/collections/ks_s3/records", fd, s.h); s.recId = String(r.json?.id); s.file = String((r.json?.pic as string[] | undefined)?.[0] ?? "");
    return { status: r.status, objects: s.norm(await s.objects()) };
  });
  await step("serve the file from S3", async (s) => { const r = await fetch(`${s.base}/api/files/ks_s3/${s.recId}/${s.file}`); const bytes = new Uint8Array(await r.arrayBuffer()); return { status: r.status, type: r.headers.get("content-type"), same: bytes.length === PNG.length && bytes.every((b, i) => b === PNG[i]) }; });
  await step("range request from S3", async (s) => { const r = await fetch(`${s.base}/api/files/ks_s3/${s.recId}/${s.file}`, { headers: { range: "bytes=0-9" } }); return { status: r.status, range: r.headers.get("content-range"), len: (await r.arrayBuffer()).byteLength }; });
  await step("thumb generated and cached in S3", async (s) => { const r = await fetch(`${s.base}/api/files/ks_s3/${s.recId}/${s.file}?thumb=2x2`); await new Promise((res) => setTimeout(res, 800)); return { status: r.status, type: r.headers.get("content-type"), objects: s.norm(await s.objects()).map((o) => o.key) }; });
  await step("missing file -> 404", async (s) => (await fetch(`${s.base}/api/files/ks_s3/${s.recId}/nope.png`)).status);
  await step("delete record removes file and thumbs from S3", async (s) => { const r = await s.api("DELETE", `/api/collections/ks_s3/records/${s.recId}`, undefined, s.h); await new Promise((res) => setTimeout(res, 800)); return { status: r.status, objects: s.norm(await s.objects()) }; });
  await step("backup archive goes to the backups S3 bucket", async (s) => { const r = await s.api("POST", "/api/backups", { name: "s3test.zip" }, s.h); await new Promise((res) => setTimeout(res, 1500)); const list = await s.api("GET", "/api/backups", undefined, s.h); const inBucket = (await fetch(`${MOCK}/__inspect/${s.bucket}bk`).then((x) => x.json())) as { key: string }[]; return { status: r.status, listed: (list.json as unknown as { key: string }[] | null)?.map((b) => b.key), inBucket: inBucket.map((o) => o.key) }; });
  await step("delete backup from the backups S3 bucket", async (s) => { const r = await s.api("DELETE", "/api/backups/s3test.zip", undefined, s.h); const inBucket = (await fetch(`${MOCK}/__inspect/${s.bucket}bk`).then((x) => x.json())) as { key: string }[]; return { status: r.status, inBucket: inBucket.length }; });
  await step("disable s3 -> files back on the default storage", async (s) => { const r = await s.api("PATCH", "/api/settings", { s3: s.s3cfg(s.bucket, false), backups: { s3: s.s3cfg(s.bucket + "bk", false) } }, s.h); const fd = new FormData(); fd.append("title", "local"); fd.append("pic", new Blob([PNG], { type: "image/png" }), "dot2.png"); const rec = await s.api("POST", "/api/collections/ks_s3/records", fd, s.h); const objs = await s.objects(); await s.api("DELETE", `/api/collections/ks_s3/records/${rec.json?.id}`, undefined, s.h); return { status: r.status, created: rec.status, s3Objects: objs.length }; });
} finally { await pb.teardown(); await vb.teardown(); }
console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
