// Protected files and file tokens (apis/file.go): a protected file needs a valid ?token= file token whose record
// passes the collection's view rule; superusers always pass (subject to the IP allowlist).
//   bun test/conformance/protected-files.ts [pb] [vb]
const PB = process.argv[2] ?? "http://127.0.0.1:8090";
const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
class Server {
  h: Record<string, string> = {}; userToken = ""; recId = ""; file = "";
  constructor(public base: string) {}
  async api(method: string, path: string, body?: object | FormData, headers: Record<string, string> = {}) {
    const isForm = body instanceof FormData;
    const r = await fetch(`${this.base}${path}`, { method, headers: { ...headers, ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) });
    const text = await r.text(); let json: Record<string, unknown> | null = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json, headers: r.headers };
  }
  async setup() {
    const a = await this.api("POST", "/api/collections/_superusers/auth-with-password", CREDS); this.h = { authorization: String(a.json?.token) };
    const u = await this.api("POST", "/api/collections/users/auth-with-password", { identity: "user@example.com", password: "changeme123" }); this.userToken = String(u.json?.token);
    await this.api("DELETE", "/api/collections/ks_prot", undefined, this.h);
    const cr = await this.api("POST", "/api/collections", { name: "ks_prot", type: "base", listRule: "", viewRule: "@request.auth.id != ''", fields: [{ name: "doc", type: "file", maxSelect: 1, protected: true }, { name: "pub", type: "file", maxSelect: 1 }] }, this.h);
    if (cr.status !== 200) throw new Error(`${this.base} ks_prot ${cr.status} ${JSON.stringify(cr.json)}`);
    const fd = new FormData(); fd.append("doc", new File([PNG as BlobPart], "secret.png", { type: "image/png" })); fd.append("pub", new File([PNG as BlobPart], "open.png", { type: "image/png" }));
    const rec = await this.api("POST", "/api/collections/ks_prot/records", fd, this.h);
    this.recId = String(rec.json?.id); this.file = String(rec.json?.doc); this.pub = String(rec.json?.pub);
  }
  pub = "";
  async teardown() { await this.api("DELETE", "/api/collections/ks_prot", undefined, this.h); }
  async get(path: string, headers: Record<string, string> = {}) { const r = await fetch(`${this.base}${path}`, { headers }); return { status: r.status, type: r.headers.get("content-type") }; }
}
const pb = new Server(PB), vb = new Server(VB); await pb.setup(); await vb.setup();
let pass = 0, fail = 0;
const step = async (label: string, run: (s: Server) => Promise<unknown>) => {
  const [a, b] = await Promise.all([run(pb).catch((e) => ({ error: String(e) })), run(vb).catch((e) => ({ error: String(e) }))]);
  const same = JSON.stringify(a) === JSON.stringify(b); same ? pass++ : fail++;
  console.log(`${same ? "PASS" : "FAIL"}  ${label.padEnd(44)} pb=${JSON.stringify(a).slice(0, 300)}${same ? "" : `\n      vb=${JSON.stringify(b).slice(0, 600)}`}`);
};
const st: Record<string, Record<string, string>> = { [PB]: {}, [VB]: {} };
try {
  await step("public file is open", async (s) => s.get(`/api/files/ks_prot/${s.recId}/${s.pub}`));
  await step("protected file without token", async (s) => s.get(`/api/files/ks_prot/${s.recId}/${s.file}`));
  await step("protected file with an auth token instead of a file token", async (s) => s.get(`/api/files/ks_prot/${s.recId}/${s.file}?token=${s.userToken}`));
  await step("file token requires auth", async (s) => { const r = await s.api("POST", "/api/files/token"); return { status: r.status, body: r.json }; });
  await step("file token issued", async (s) => { const r = await s.api("POST", "/api/files/token", undefined, { authorization: s.userToken }); st[s.base]!.token = String(r.json?.token ?? ""); const claims = JSON.parse(atob(st[s.base]!.token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))); return { status: r.status, keys: Object.keys(r.json ?? {}), type: claims.type, ttl: Math.round((claims.exp - claims.iat) / 10) * 10 }; });
  await step("protected file with a user file token (view rule passes)", async (s) => s.get(`/api/files/ks_prot/${s.recId}/${s.file}?token=${st[s.base]!.token}`));
  await step("protected file with a superuser file token", async (s) => { const r = await s.api("POST", "/api/files/token", undefined, s.h); return s.get(`/api/files/ks_prot/${s.recId}/${s.file}?token=${r.json?.token}`); });
  await step("view rule null: only superusers", async (s) => { await s.api("PATCH", "/api/collections/ks_prot", { viewRule: null }, s.h); const user = await s.get(`/api/files/ks_prot/${s.recId}/${s.file}?token=${st[s.base]!.token}`); const su = await s.api("POST", "/api/files/token", undefined, s.h); const admin = await s.get(`/api/files/ks_prot/${s.recId}/${s.file}?token=${su.json?.token}`); return { user, admin }; });
  await step("garbage token", async (s) => s.get(`/api/files/ks_prot/${s.recId}/${s.file}?token=nope`));
} finally { await pb.teardown(); await vb.teardown(); }
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
