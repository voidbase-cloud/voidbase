// manageRule: an authenticated record that satisfies the rule may change another auth record's email, password
// (without oldPassword) and verified flag; without the rule those changes are refused.
//   bun test/conformance/manage-rule.ts [pb] [vb]
const PB = process.argv[2] ?? "http://127.0.0.1:8090";
const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
const TARGET = { email: "managed.user@example.com", password: "managedpass123", passwordConfirm: "managedpass123", name: "Managed" };
class Server {
  h: Record<string, string> = {}; user = ""; targetId = ""; saved: unknown = null;
  constructor(public base: string) {}
  async api(method: string, path: string, body?: object, headers: Record<string, string> = {}) { const r = await fetch(`${this.base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null }; }
  async setup() {
    const a = await this.api("POST", "/api/collections/_superusers/auth-with-password", CREDS); this.h = { authorization: String(a.json?.token) };
    this.saved = (await this.api("GET", "/api/collections/users", undefined, this.h)).json?.manageRule ?? null;
    const u = await this.api("POST", "/api/collections/users/auth-with-password", { identity: "user@example.com", password: "changeme123" }); this.user = String(u.json?.token);
    await this.cleanup();
    const t = await this.api("POST", "/api/collections/users/records", TARGET, this.h); this.targetId = String(t.json?.id);
  }
  async cleanup() { for (const e of [TARGET.email, "managed.new@example.com"]) { const l = await this.api("GET", `/api/collections/users/records?filter=${encodeURIComponent(`email = "${e}"`)}`, undefined, this.h); for (const it of ((l.json?.items as { id: string }[]) ?? [])) await this.api("DELETE", `/api/collections/users/records/${it.id}`, undefined, this.h); } }
  async teardown() { await this.cleanup(); await this.api("PATCH", "/api/collections/users", { manageRule: this.saved }, this.h); }
}
const pb = new Server(PB), vb = new Server(VB); await pb.setup(); await vb.setup();
let pass = 0, fail = 0;
const step = async (label: string, run: (s: Server) => Promise<unknown>) => {
  const [a, b] = await Promise.all([run(pb).catch((e) => ({ error: String(e) })), run(vb).catch((e) => ({ error: String(e) }))]);
  const same = JSON.stringify(a) === JSON.stringify(b); same ? pass++ : fail++;
  console.log(`${same ? "PASS" : "FAIL"}  ${label.padEnd(50)} pb=${JSON.stringify(a).slice(0, 300)}${same ? "" : `\n      vb=${JSON.stringify(b).slice(0, 600)}`}`);
};
const body = (r: { status: number; json: unknown }) => ({ status: r.status, body: r.json });
try {
  await step("without manageRule: other user cannot change email", async (s) => { await s.api("PATCH", "/api/collections/users", { manageRule: null }, s.h); return body(await s.api("PATCH", `/api/collections/users/records/${s.targetId}`, { email: "managed.new@example.com" }, { authorization: s.user })); });
  await step("without manageRule: password change needs oldPassword", async (s) => body(await s.api("PATCH", `/api/collections/users/records/${s.targetId}`, { password: "newpass12345", passwordConfirm: "newpass12345" }, { authorization: s.user })));
  await step("manageRule for user@example.com: email + verified", async (s) => {
    await s.api("PATCH", "/api/collections/users", { manageRule: '@request.auth.id != "" && @request.auth.email = "user@example.com"' }, s.h);
    const r = await s.api("PATCH", `/api/collections/users/records/${s.targetId}`, { email: "managed.new@example.com", verified: true }, { authorization: s.user });
    return { status: r.status, email: r.json?.email, verified: r.json?.verified, keys: Object.keys(r.json ?? {}).sort() };
  });
  await step("manageRule: password without oldPassword", async (s) => { const r = await s.api("PATCH", `/api/collections/users/records/${s.targetId}`, { password: "newpass12345", passwordConfirm: "newpass12345" }, { authorization: s.user }); const login = await s.api("POST", "/api/collections/users/auth-with-password", { identity: "managed.new@example.com", password: "newpass12345" }); return { status: r.status, login: login.status }; });
  await step("manageRule not matching another user", async (s) => { const other = await s.api("POST", "/api/collections/users/auth-with-password", { identity: "managed.new@example.com", password: "newpass12345" }); return body(await s.api("PATCH", `/api/collections/users/records/${s.targetId}`, { verified: false, email: "managed.user@example.com" }, { authorization: String(other.json?.token) })); });
} finally { await pb.teardown(); await vb.teardown(); }
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
