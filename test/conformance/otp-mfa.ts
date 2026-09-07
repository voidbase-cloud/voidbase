// OTP, MFA, impersonation and login alerts against PocketBase with the shared SMTP sink (test/smtp-sink.ts).
//   bun test/smtp-sink.ts &   then   bun test/conformance/otp-mfa.ts [pb] [vb]
const PB = process.argv[2] ?? "http://127.0.0.1:8090";
const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const SINK = "http://127.0.0.1:2526/messages";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
const USER = { email: "otp.user@example.com", password: "otppass123", passwordConfirm: "otppass123", name: "Otp User", verified: false };
interface Mail { from: string; to: string[]; subject: string; html: string }
const sinkClear = () => fetch(SINK, { method: "DELETE" });
// Mail arrives filtered: voidbase delivers from a queue consumer, so a message an earlier step triggered can reach
// the sink after this step cleared it. A login alert for the superuser was read as the user's OTP once, which
// failed every step after it. Each wait now says which message it is waiting for.
const forUser = (m: Mail) => (m.to ?? []).some((a) => a.includes(USER.email));
const otpForUser = (m: Mail) => forUser(m) && /otp/i.test(m.subject ?? "");
async function sinkWait(n: number, ms = 6000, want: (m: Mail) => boolean = () => true): Promise<Mail[]> { const until = Date.now() + ms; for (;;) { const list = ((await fetch(SINK).then((r) => r.json())) as Mail[]).filter(want); if (list.length >= n || Date.now() > until) return list; await Bun.sleep(150); } }
const normalize = (m: Mail | undefined) => (m ? { to: m.to, subject: m.subject, html: m.html.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z - [^<]*/g, "<INFO>").replace(/<strong>\d+<\/strong>/g, "<strong><OTP></strong>").replace(/\r\n/g, "\n").trim() } : null);
const otpFrom = (m: Mail | undefined) => (m ? /<strong>(\d+)<\/strong>/.exec(m.html)?.[1] ?? "" : "");

class Server {
  h: Record<string, string> = {}; savedSmtp: unknown = null; savedUsers: Record<string, unknown> = {}; userId = ""; st: Record<string, string> = {};
  constructor(public base: string) {}
  async api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(`${this.base}${path}`, { method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json: Record<string, unknown> | null = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json };
  }
  async setup() {
    const a = await this.api("POST", "/api/collections/_superusers/auth-with-password", CREDS); this.h = { authorization: String(a.json?.token) };
    this.savedSmtp = (await this.api("GET", "/api/settings", undefined, this.h)).json?.smtp;
    await this.api("PATCH", "/api/settings", { smtp: { enabled: true, host: "127.0.0.1", port: 2525, username: "", password: "", authMethod: "", tls: false, localName: "" } }, this.h);
    const users = (await this.api("GET", "/api/collections/users", undefined, this.h)).json!;
    this.savedUsers = { otp: users.otp, mfa: users.mfa, authAlert: users.authAlert };
    await this.setUsers({ otp: { ...(users.otp as object), enabled: true, duration: 180, length: 8 }, mfa: { ...(users.mfa as object), enabled: false }, authAlert: { ...(users.authAlert as object), enabled: false } });
    await this.cleanupUsers();
    const u = await this.api("POST", "/api/collections/users/records", USER, this.h);
    if (u.status !== 200) throw new Error(`${this.base} create user ${u.status} ${JSON.stringify(u.json)}`);
    this.userId = String(u.json!.id);
  }
  async setUsers(patch: Record<string, unknown>) { const r = await this.api("PATCH", "/api/collections/users", patch, this.h); if (r.status !== 200) throw new Error(`${this.base} users patch ${r.status} ${JSON.stringify(r.json)}`); }
  async cleanupUsers() { const list = await this.api("GET", `/api/collections/users/records?filter=${encodeURIComponent(`email = "${USER.email}"`)}`, undefined, this.h); for (const it of ((list.json?.items as { id: string }[]) ?? [])) await this.api("DELETE", `/api/collections/users/records/${it.id}`, undefined, this.h); }
  async teardown() {
    const smtp = await this.api("PATCH", "/api/settings", { smtp: { ...(this.savedSmtp as object), password: "" } }, this.h);
    if (smtp.status !== 200) console.error(`${this.base}: smtp restore failed`, smtp.status, JSON.stringify(smtp.json));
    await this.cleanupUsers();
    const users = await this.api("PATCH", "/api/collections/users", this.savedUsers, this.h);
    if (users.status !== 200) console.error(`${this.base}: users restore failed`, users.status, JSON.stringify(users.json));
  }
}
const pb = new Server(PB), vb = new Server(VB); await pb.setup(); await vb.setup();
let pass = 0, fail = 0;
const step = async (label: string, run: (s: Server) => Promise<unknown>) => {
  const a = await run(pb).catch((e) => ({ error: String(e) })); const b = await run(vb).catch((e) => ({ error: String(e) }));
  const same = JSON.stringify(a) === JSON.stringify(b); same ? pass++ : fail++;
  console.log(`${same ? "PASS" : "FAIL"}  ${label.padEnd(46)} pb=${JSON.stringify(a).slice(0, 320)}${same ? "" : `\n      vb=${JSON.stringify(b).slice(0, 700)}`}`);
};
const body = (r: { status: number; json: unknown }) => ({ status: r.status, body: r.json });
const authShape = (j: Record<string, unknown> | null) => (j ? { keys: Object.keys(j).sort(), hasToken: typeof j.token === "string", recordKeys: Object.keys((j.record as object) ?? {}).sort(), email: (j.record as { email?: string })?.email, verified: (j.record as { verified?: boolean })?.verified } : null);
try {
  await step("request-otp validation", async (s) => body(await s.api("POST", "/api/collections/users/request-otp", { email: "bad" })));
  await step("request-otp unknown email still returns an id", async (s) => { const r = await s.api("POST", "/api/collections/users/request-otp", { email: "nobody@example.com" }); return { status: r.status, keys: Object.keys(r.json ?? {}), idLen: String(r.json?.otpId ?? "").length }; });
  await step("request-otp sends the code", async (s) => { await sinkClear(); const r = await s.api("POST", "/api/collections/users/request-otp", { email: USER.email }); const [m] = await sinkWait(1, 6000, otpForUser); s.st.otpId = String(r.json?.otpId ?? ""); s.st.otp = otpFrom(m); return { status: r.status, idLen: s.st.otpId.length, otpLen: s.st.otp.length, mail: normalize(m) }; });
  await step("auth-with-otp validation", async (s) => body(await s.api("POST", "/api/collections/users/auth-with-otp", { otpId: "", password: "x".repeat(80) })));
  await step("auth-with-otp wrong code", async (s) => body(await s.api("POST", "/api/collections/users/auth-with-otp", { otpId: s.st.otpId, password: "00000000" })));
  await step("auth-with-otp unknown id", async (s) => body(await s.api("POST", "/api/collections/users/auth-with-otp", { otpId: "nopenopenopenop", password: "12345678" })));
  await step("auth-with-otp signs in and verifies", async (s) => { const r = await s.api("POST", "/api/collections/users/auth-with-otp", { otpId: s.st.otpId, password: s.st.otp }); return { status: r.status, ...authShape(r.json) }; });
  await step("used otp is gone", async (s) => body(await s.api("POST", "/api/collections/users/auth-with-otp", { otpId: s.st.otpId, password: s.st.otp })));
  await step("otp disabled -> 403", async (s) => { await s.setUsers({ otp: { enabled: false } }); const r = await s.api("POST", "/api/collections/users/request-otp", { email: USER.email }); await s.setUsers({ otp: { enabled: true, duration: 180, length: 8 } }); return body(r); });
  // MFA: password first, then OTP with the mfaId
  await step("mfa: password login opens an MFA session", async (s) => { await s.setUsers({ mfa: { enabled: true, duration: 1800, rule: "" } }); const r = await s.api("POST", "/api/collections/users/auth-with-password", { identity: USER.email, password: USER.password }); s.st.mfaId = String(r.json?.mfaId ?? ""); return { status: r.status, keys: Object.keys(r.json ?? {}), idLen: s.st.mfaId.length }; });
  await step("mfa: same method again is refused", async (s) => body(await s.api("POST", "/api/collections/users/auth-with-password", { identity: USER.email, password: USER.password, mfaId: s.st.mfaId })));
  await step("mfa: unknown session", async (s) => body(await s.api("POST", "/api/collections/users/auth-with-password", { identity: USER.email, password: USER.password, mfaId: "nopenopenopenop" })));
  await step("mfa: otp with mfaId completes", async (s) => { await sinkClear(); const r1 = await s.api("POST", "/api/collections/users/request-otp", { email: USER.email }); const [m] = await sinkWait(1, 6000, otpForUser); const r = await s.api("POST", `/api/collections/users/auth-with-otp?mfaId=${s.st.mfaId}`, { otpId: r1.json?.otpId, password: otpFrom(m) }); s.st.userToken = String(r.json?.token ?? ""); return { status: r.status, ...authShape(r.json) }; });
  await step("mfa: session consumed", async (s) => body(await s.api("POST", "/api/collections/users/auth-with-password", { identity: USER.email, password: USER.password, mfaId: s.st.mfaId })));
  await step("mfa records visible to owner only", async (s) => { const mine = await s.api("GET", "/api/collections/_mfas/records", undefined, { authorization: s.st.userToken }); const anon = await s.api("GET", "/api/collections/_mfas/records"); return { mine: mine.status, anon: anon.status }; });
  await step("mfa rule excludes the user", async (s) => { await s.setUsers({ mfa: { enabled: true, duration: 1800, rule: "verified = false" } }); const r = await s.api("POST", "/api/collections/users/auth-with-password", { identity: USER.email, password: USER.password }); await s.setUsers({ mfa: { enabled: false } }); return { status: r.status, hasToken: !!r.json?.token }; });
  // impersonate
  await step("impersonate as superuser", async (s) => { const r = await s.api("POST", `/api/collections/users/impersonate/${s.userId}`, { duration: 3600 }, s.h); const claims = JSON.parse(atob(String(r.json?.token ?? "..").split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))); return { status: r.status, ...authShape(r.json), refreshable: claims.refreshable, expIn: Math.round((claims.exp - claims.iat) / 100) * 100 }; });
  await step("impersonate validation", async (s) => body(await s.api("POST", `/api/collections/users/impersonate/${s.userId}`, { duration: -1 }, s.h)));
  await step("impersonate unknown record", async (s) => body(await s.api("POST", `/api/collections/users/impersonate/nopenopenopenop`, {}, s.h)));
  await step("impersonate as regular user", async (s) => { const login = await s.api("POST", "/api/collections/users/auth-with-password", { identity: USER.email, password: USER.password }); return body(await s.api("POST", `/api/collections/users/impersonate/${s.userId}`, {}, { authorization: String(login.json?.token) })); });
  await step("impersonate anonymous", async (s) => body(await s.api("POST", `/api/collections/users/impersonate/${s.userId}`, {})));
  // auth alert: second login from a different user agent mails the alert
  await step("auth alert on a new location", async (s) => { await s.setUsers({ authAlert: { enabled: true } }); await sinkClear(); const a = await s.api("POST", "/api/collections/users/auth-with-password", { identity: USER.email, password: USER.password }, { "user-agent": "agent-one" }); await Bun.sleep(400); const first = (await sinkWait(1, 600, forUser)).length; const b = await s.api("POST", "/api/collections/users/auth-with-password", { identity: USER.email, password: USER.password }, { "user-agent": "agent-two" }); const [m] = await sinkWait(1, 6000, forUser); const origins = await s.api("GET", "/api/collections/_authOrigins/records", undefined, { authorization: String(b.json?.token) }); await s.setUsers({ authAlert: { enabled: false } }); return { first: a.status, mailsAfterFirst: first, second: b.status, mail: normalize(m), origins: (origins.json?.totalItems as number) }; });
} finally { await pb.teardown(); await vb.teardown(); }
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
