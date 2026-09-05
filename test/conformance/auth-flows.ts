// Verification, password reset and email change against PocketBase with a shared SMTP sink (test/smtp-sink.ts):
// both servers are pointed at the sink, each flow is driven end to end and the emails (subject, html with the
// token normalized, from/to) and API responses are compared.
//   bun test/smtp-sink.ts &   then   bun test/conformance/auth-flows.ts [pb=http://127.0.0.1:8090] [vb=http://127.0.0.1:5180]
const PB = process.argv[2] ?? "http://127.0.0.1:8090";
const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const SINK = "http://127.0.0.1:2526/messages";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
const USER = { email: "flow.user@example.com", password: "flowpass123", passwordConfirm: "flowpass123", name: "Flow User", verified: false };
const NEW_EMAIL = "flow.new@example.com";

interface Mail { from: string; to: string[]; subject: string; html: string; headers: Record<string, string> }
const normalize = (m: Mail) => ({ from: m.from, to: m.to, subject: m.subject, fromHeader: m.headers.from, html: m.html.replace(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<TOKEN>").replace(/\r\n/g, "\n").trim() });
const sinkClear = () => fetch(SINK, { method: "DELETE" });
async function sinkWait(n: number, ms = 6000): Promise<Mail[]> { const until = Date.now() + ms; for (;;) { const list = (await fetch(SINK).then((r) => r.json())) as Mail[]; if (list.length >= n || Date.now() > until) return list; await Bun.sleep(150); } }
const tokenOf = (m: Mail | undefined) => (m ? /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.exec(m.html)?.[0] ?? "" : "");

class Server {
  h: Record<string, string> = {}; savedSmtp: unknown = null; userId = ""; userToken = ""; tokens: Record<string, string> = {};
  constructor(public base: string) {}
  async api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(`${this.base}${path}`, { method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json: Record<string, unknown> | null = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json };
  }
  async setup() {
    const a = await this.api("POST", "/api/collections/_superusers/auth-with-password", CREDS); this.h = { authorization: String(a.json?.token) };
    this.savedSmtp = (await this.api("GET", "/api/settings", undefined, this.h)).json?.smtp;
    const smtp = await this.api("PATCH", "/api/settings", { smtp: { enabled: true, host: "127.0.0.1", port: 2525, username: "", password: "", authMethod: "", tls: false, localName: "" } }, this.h);
    if (smtp.status !== 200) throw new Error(`${this.base} smtp settings ${smtp.status} ${JSON.stringify(smtp.json)}`);
    await this.cleanupUsers();
    const u = await this.api("POST", "/api/collections/users/records", USER, this.h);
    if (u.status !== 200) throw new Error(`${this.base} create user ${u.status} ${JSON.stringify(u.json)}`);
    this.userId = String(u.json!.id);
  }
  async cleanupUsers() { for (const email of [USER.email, NEW_EMAIL]) { const list = await this.api("GET", `/api/collections/users/records?filter=${encodeURIComponent(`email = "${email}"`)}`, undefined, this.h); for (const it of ((list.json?.items as { id: string }[]) ?? [])) await this.api("DELETE", `/api/collections/users/records/${it.id}`, undefined, this.h); } }
  async teardown() {
    const smtp = await this.api("PATCH", "/api/settings", { smtp: { ...(this.savedSmtp as object), password: "" } }, this.h);
    if (smtp.status !== 200) console.error(`${this.base}: smtp restore failed`, smtp.status, JSON.stringify(smtp.json));
    await this.cleanupUsers();
  }
  user() { return this.api("GET", `/api/collections/users/records/${this.userId}`, undefined, this.h); }
}
const pb = new Server(PB), vb = new Server(VB);
await pb.setup(); await vb.setup();
let pass = 0, fail = 0;
// sequential per server so the shared sink attributes emails correctly
const step = async (label: string, run: (s: Server) => Promise<unknown>) => {
  const a = await run(pb).catch((e) => ({ error: String(e) })); const b = await run(vb).catch((e) => ({ error: String(e) }));
  const same = JSON.stringify(a) === JSON.stringify(b); same ? pass++ : fail++;
  console.log(`${same ? "PASS" : "FAIL"}  ${label.padEnd(46)} pb=${JSON.stringify(a).slice(0, 320)}${same ? "" : `\n      vb=${JSON.stringify(b).slice(0, 700)}`}`);
};
const body = (r: { status: number; json: unknown }) => ({ status: r.status, body: r.json });
try {
  await step("request-verification sends the email", async (s) => { await sinkClear(); const r = await s.api("POST", "/api/collections/users/request-verification", { email: USER.email }); const [m] = await sinkWait(1); s.tokens.verification = tokenOf(m); return { status: r.status, mail: m ? normalize(m) : null }; });
  await step("immediate second request is rate limited", async (s) => { await sinkClear(); const r = await s.api("POST", "/api/collections/users/request-verification", { email: USER.email }); await Bun.sleep(1200); return { status: r.status, mails: (await sinkWait(1, 500)).length }; });
  await step("request-verification unknown email still 204", async (s) => { await sinkClear(); const r = await s.api("POST", "/api/collections/users/request-verification", { email: "nobody@example.com" }); await Bun.sleep(800); return { status: r.status, mails: (await sinkWait(1, 300)).length }; });
  await step("request-verification validation", async (s) => body(await s.api("POST", "/api/collections/users/request-verification", { email: "bad" })));
  await step("request-verification for superusers", async (s) => body(await s.api("POST", "/api/collections/_superusers/request-verification", { email: "admin@example.com" })));
  await step("confirm-verification bad token", async (s) => body(await s.api("POST", "/api/collections/users/confirm-verification", { token: "nope" })));
  await step("confirm-verification missing token", async (s) => body(await s.api("POST", "/api/collections/users/confirm-verification", {})));
  await step("confirm-verification", async (s) => { const r = await s.api("POST", "/api/collections/users/confirm-verification", { token: s.tokens.verification }); const u = await s.user(); return { status: r.status, verified: u.json?.verified }; });
  await step("confirm-verification again (already verified)", async (s) => body(await s.api("POST", "/api/collections/users/confirm-verification", { token: s.tokens.verification })));
  await step("request-password-reset sends the email", async (s) => { await sinkClear(); const r = await s.api("POST", "/api/collections/users/request-password-reset", { email: USER.email }); const [m] = await sinkWait(1); s.tokens.reset = tokenOf(m); return { status: r.status, mail: m ? normalize(m) : null }; });
  await step("confirm-password-reset validation", async (s) => body(await s.api("POST", "/api/collections/users/confirm-password-reset", { token: s.tokens.reset, password: "short", passwordConfirm: "other" })));
  await step("confirm-password-reset bad token", async (s) => body(await s.api("POST", "/api/collections/users/confirm-password-reset", { token: "nope", password: "newpass123", passwordConfirm: "newpass123" })));
  await step("confirm-password-reset", async (s) => { const r = await s.api("POST", "/api/collections/users/confirm-password-reset", { token: s.tokens.reset, password: "newpass123", passwordConfirm: "newpass123" }); const old = await s.api("POST", "/api/collections/users/auth-with-password", { identity: USER.email, password: USER.password }); const fresh = await s.api("POST", "/api/collections/users/auth-with-password", { identity: USER.email, password: "newpass123" }); s.userToken = String(fresh.json?.token ?? ""); return { status: r.status, oldPassword: old.status, newPassword: fresh.status }; });
  await step("request-email-change anonymous", async (s) => body(await s.api("POST", "/api/collections/users/request-email-change", { newEmail: NEW_EMAIL })));
  await step("request-email-change same email", async (s) => body(await s.api("POST", "/api/collections/users/request-email-change", { newEmail: USER.email }, { authorization: s.userToken })));
  await step("request-email-change taken email", async (s) => body(await s.api("POST", "/api/collections/users/request-email-change", { newEmail: "user@example.com" }, { authorization: s.userToken })));
  await step("request-email-change sends the email", async (s) => { await sinkClear(); const r = await s.api("POST", "/api/collections/users/request-email-change", { newEmail: NEW_EMAIL }, { authorization: s.userToken }); const [m] = await sinkWait(1); s.tokens.change = tokenOf(m); return { status: r.status, mail: m ? normalize(m) : null }; });
  await step("confirm-email-change wrong password", async (s) => body(await s.api("POST", "/api/collections/users/confirm-email-change", { token: s.tokens.change, password: "wrong" })));
  await step("confirm-email-change bad token", async (s) => body(await s.api("POST", "/api/collections/users/confirm-email-change", { token: "nope", password: "newpass123" })));
  await step("confirm-email-change", async (s) => { const r = await s.api("POST", "/api/collections/users/confirm-email-change", { token: s.tokens.change, password: "newpass123" }); const u = await s.user(); return { status: r.status, email: u.json?.email, verified: u.json?.verified }; });
  await step("superusers request-email-change", async (s) => body(await s.api("POST", "/api/collections/_superusers/request-email-change", { newEmail: "x@y.co" }, s.h)));
  await step("test email endpoint sends", async (s) => { await sinkClear(); const r = await s.api("POST", "/api/settings/test/email", { email: "tester@example.com", template: "otp" }, s.h); const [m] = await sinkWait(1); return { status: r.status, mail: m ? normalize(m) : null }; });
} finally { await pb.teardown(); await vb.teardown(); }
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
