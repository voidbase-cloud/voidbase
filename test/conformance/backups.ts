// Backups API against PocketBase: list, create (validation, naming), upload, token-protected download, delete;
// restore is exercised on voidbase only (restoring the reference server would restart it).
//   bun test/conformance/backups.ts [pb] [vb]
import { zipSync } from "fflate";
const PB = process.argv[2] ?? "http://127.0.0.1:8090";
const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
class Server {
  h: Record<string, string> = {}; fileToken = ""; userFileToken = "";
  constructor(public base: string) {}
  async api(method: string, path: string, body?: object | FormData, headers: Record<string, string> = {}) {
    const isForm = body instanceof FormData;
    const r = await fetch(`${this.base}${path}`, { method, headers: { ...headers, ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) });
    const text = await r.text(); let json: unknown = null; try { json = JSON.parse(text); } catch { json = text || null; }
    return { status: r.status, json, headers: r.headers };
  }
  async setup() {
    const a = await this.api("POST", "/api/collections/_superusers/auth-with-password", CREDS); this.h = { authorization: String((a.json as { token: string }).token) };
    this.fileToken = String(((await this.api("POST", "/api/files/token", undefined, this.h)).json as { token: string }).token);
    const u = await this.api("POST", "/api/collections/users/auth-with-password", { identity: "user@example.com", password: "changeme123" });
    this.userFileToken = String(((await this.api("POST", "/api/files/token", undefined, { authorization: String((u.json as { token: string }).token) })).json as { token: string }).token);
    await this.cleanup();
  }
  async cleanup() { const l = await this.api("GET", "/api/backups", undefined, this.h); for (const b of ((l.json as { key: string }[]) ?? [])) if (b.key.startsWith("ks_backup_")) await this.api("DELETE", `/api/backups/${b.key}`, undefined, this.h); }
}
const pb = new Server(PB), vb = new Server(VB); await pb.setup(); await vb.setup();
let pass = 0, fail = 0;
const step = async (label: string, run: (s: Server) => Promise<unknown>) => {
  const [a, b] = await Promise.all([run(pb).catch((e) => ({ error: String(e) })), run(vb).catch((e) => ({ error: String(e) }))]);
  const same = JSON.stringify(a) === JSON.stringify(b); same ? pass++ : fail++;
  console.log(`${same ? "PASS" : "FAIL"}  ${label.padEnd(44)} pb=${JSON.stringify(a).slice(0, 360)}${same ? "" : `\n      vb=${JSON.stringify(b).slice(0, 700)}`}`);
};
const normalize = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replace(/Raw error: \\n[^"]*/g, "Raw error: <RAW>").replace(/_[a-z0-9]{10}\.txt/g, "_X.txt"));
const body = (r: { status: number; json: unknown }) => ({ status: r.status, body: normalize(r.json) });
try {
  await step("create with a bad name", async (s) => body(await s.api("POST", "/api/backups", { name: "Bad Name.zip" }, s.h)));
  await step("create with a too long name", async (s) => body(await s.api("POST", "/api/backups", { name: "a".repeat(160) + ".zip" }, s.h)));
  await step("create named backup", async (s) => body(await s.api("POST", "/api/backups", { name: "ks_backup_test.zip" }, s.h)));
  await step("create same name again", async (s) => body(await s.api("POST", "/api/backups", { name: "ks_backup_test.zip" }, s.h)));
  await step("list shows the backup", async (s) => { const r = await s.api("GET", "/api/backups", undefined, s.h); const items = ((r.json as { key: string; size: number; modified: string }[]) ?? []).filter((b) => b.key.startsWith("ks_backup_")); return { status: r.status, keys: items.map((b) => b.key), itemKeys: ["key", "modified", "size"].filter((k) => k in (items[0] ?? {})), sizePositive: (items[0]?.size ?? 0) > 0, modifiedShape: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(items[0]?.modified ?? "") }; });
  await step("download without token", async (s) => body(await s.api("GET", "/api/backups/ks_backup_test.zip")));
  await step("download with a regular user's file token", async (s) => body(await s.api("GET", `/api/backups/ks_backup_test.zip?token=${s.userFileToken}`)));
  await step("download with a superuser file token", async (s) => { const r = await fetch(`${s.base}/api/backups/ks_backup_test.zip?token=${s.fileToken}`); const bytes = new Uint8Array(await r.arrayBuffer()); return { status: r.status, type: r.headers.get("content-type")?.split(";")[0], disposition: r.headers.get("content-disposition")?.replace(/"/g, ""), isZip: bytes[0] === 0x50 && bytes[1] === 0x4b }; });
  await step("upload a non-zip", async (s) => { const fd = new FormData(); fd.append("file", new File([new TextEncoder().encode("hello") as BlobPart], "ks_backup_note.txt", { type: "text/plain" })); return body(await s.api("POST", "/api/backups/upload", fd, s.h)); });
  await step("upload without file", async (s) => { const fd = new FormData(); fd.append("other", "x"); return body(await s.api("POST", "/api/backups/upload", fd, s.h)); });
  const zip = zipSync({ "readme.txt": new TextEncoder().encode("test archive") });
  await step("upload a zip", async (s) => { const fd = new FormData(); fd.append("file", new File([zip as BlobPart], "ks_backup_upload.zip", { type: "application/zip" })); return body(await s.api("POST", "/api/backups/upload", fd, s.h)); });
  await step("upload the same name again", async (s) => { const fd = new FormData(); fd.append("file", new File([zip as BlobPart], "ks_backup_upload.zip", { type: "application/zip" })); return body(await s.api("POST", "/api/backups/upload", fd, s.h)); });
  await step("delete backups", async (s) => ({ a: (await s.api("DELETE", "/api/backups/ks_backup_test.zip", undefined, s.h)).status, b: (await s.api("DELETE", "/api/backups/ks_backup_upload.zip", undefined, s.h)).status }));
  await step("delete unknown backup", async (s) => body(await s.api("DELETE", "/api/backups/ks_backup_nope.zip", undefined, s.h)));
  await step("restore unknown backup", async (s) => body(await s.api("POST", "/api/backups/ks_backup_nope.zip/restore", undefined, s.h)));
  await step("backups require superuser", async (s) => body(await s.api("GET", "/api/backups")));
  // restore round trip on voidbase only
  const s = vb;
  const create = await s.api("POST", "/api/backups", { name: "ks_backup_restore.zip" }, s.h);
  const rec = await s.api("POST", "/api/collections/posts/records", { title: "after-backup", slug: `after-backup-${Date.now()}`, body: "should disappear" }, s.h);
  const recId = String((rec.json as { id: string }).id);
  const restore = await s.api("POST", "/api/backups/ks_backup_restore.zip/restore", undefined, s.h);
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { await Bun.sleep(500); const g = await s.api("GET", `/api/collections/posts/records/${recId}`, undefined, s.h); gone = g.status === 404; }
  const posts = await s.api("GET", "/api/collections/posts/records?perPage=1", undefined, s.h);
  const users = await s.api("POST", "/api/collections/users/auth-with-password", { identity: "user@example.com", password: "changeme123" });
  const ok = create.status === 204 && restore.status === 204 && gone && posts.status === 200 && users.status === 200;
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  voidbase restore round trip                   create=${create.status} restore=${restore.status} recordGone=${gone} postsOk=${posts.status} userLogin=${users.status}`);
  await s.api("DELETE", "/api/backups/ks_backup_restore.zip", undefined, s.h);
} finally { await pb.cleanup(); await vb.cleanup(); }
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
