// Settings API conformance: PATCH validation and responses, test endpoints, Apple secret validation.
//   bun test/conformance/settings.ts [pb=http://127.0.0.1:8090] [vb=http://127.0.0.1:5180]
const PB = process.argv[2] ?? "http://127.0.0.1:8090";
const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
class Server {
  h: Record<string, string> = {}; saved: Record<string, unknown> = {};
  constructor(public base: string) {}
  async api(method: string, path: string, body?: unknown, auth = true) {
    const r = await fetch(`${this.base}${path}`, { method, headers: { ...(auth ? this.h : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json: Record<string, unknown> | null = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json };
  }
  async setup() { const a = await this.api("POST", "/api/collections/_superusers/auth-with-password", CREDS, false); this.h = { authorization: String(a.json?.token) }; this.saved = (await this.api("GET", "/api/settings")).json!; }
  async teardown() { await this.api("PATCH", "/api/settings", { meta: this.saved.meta, smtp: this.saved.smtp, batch: this.saved.batch, logs: this.saved.logs, superuserIPs: this.saved.superuserIPs, rateLimits: this.saved.rateLimits, backups: { cron: (this.saved.backups as { cron: string }).cron }, s3: this.saved.s3 }); }
}
const pb = new Server(PB), vb = new Server(VB); await pb.setup(); await vb.setup();
let pass = 0, fail = 0;
const step = async (label: string, run: (s: Server) => Promise<unknown>) => {
  const [a, b] = await Promise.all([run(pb).catch((e) => ({ error: String(e) })), run(vb).catch((e) => ({ error: String(e) }))]);
  const same = JSON.stringify(a) === JSON.stringify(b); same ? pass++ : fail++;
  console.log(`${same ? "PASS" : "FAIL"}  ${label.padEnd(46)} pb=${JSON.stringify(a).slice(0, 300)}${same ? "" : `\n      vb=${JSON.stringify(b).slice(0, 300)}`}`);
};
const body = (r: { status: number; json: Record<string, unknown> | null }) => ({ status: r.status, body: r.json });
try {
  await step("PATCH meta.appName", async (s) => { const r = await s.api("PATCH", "/api/settings", { meta: { appName: "Settings Test" } }); return { status: r.status, keys: Object.keys(r.json ?? {}).sort(), appName: (r.json?.meta as { appName: string })?.appName, smtpKeys: Object.keys((r.json?.smtp as object) ?? {}).sort(), s3Keys: Object.keys((r.json?.s3 as object) ?? {}).sort() }; });
  await step("GET reflects the change", async (s) => ({ appName: ((await s.api("GET", "/api/settings")).json?.meta as { appName: string }).appName }));
  await step("invalid meta", async (s) => body(await s.api("PATCH", "/api/settings", { meta: { appName: "", appURL: "nope", senderAddress: "bad", senderName: "", accentColor: "#12" } })));
  await step("accentColor not hex", async (s) => body(await s.api("PATCH", "/api/settings", { meta: { accentColor: "#zzzzzz" } })));
  await step("smtp enabled without host/port", async (s) => body(await s.api("PATCH", "/api/settings", { smtp: { enabled: true, host: "", port: 0, authMethod: "NOPE", localName: "bad host!" } })));
  await step("s3 enabled without fields", async (s) => body(await s.api("PATCH", "/api/settings", { s3: { enabled: true, endpoint: "nope" } })));
  await step("backups s3 + bad cron", async (s) => body(await s.api("PATCH", "/api/settings", { backups: { cron: "bad", s3: { enabled: true } } })));
  await step("batch enabled with zeros", async (s) => body(await s.api("PATCH", "/api/settings", { batch: { enabled: true, maxRequests: 0, timeout: 0, maxBodySize: -1 } })));
  await step("superuserIPs invalid", async (s) => body(await s.api("PATCH", "/api/settings", { superuserIPs: ["10.0.0.1", "nope", ""] })));
  await step("rate limit rules", async (s) => body(await s.api("PATCH", "/api/settings", { rateLimits: { enabled: true, rules: [{ label: "*:auth", audience: "", duration: 3, maxRequests: 2 }, { label: "*:auth", audience: "", duration: 0, maxRequests: 0 }, { label: "bad label", audience: "@nope", duration: 1, maxRequests: 1 }] } })));
  await step("logs negative", async (s) => body(await s.api("PATCH", "/api/settings", { logs: { maxDays: -1, maxDataSize: -5 } })));
  await step("valid full round trip keeps secrets hidden", async (s) => { const r = await s.api("PATCH", "/api/settings", { smtp: { enabled: false, host: "smtp.example.com", port: 587, username: "u", password: "p", authMethod: "LOGIN", tls: true, localName: "mail.example.com" }, s3: { enabled: false, secret: "x" } }); return { status: r.status, smtp: r.json?.smtp, s3: r.json?.s3 }; });
  await step("test email validation", async (s) => body(await s.api("POST", "/api/settings/test/email", { email: "bad", template: "nope", collection: "posts" })));
  await step("test email missing", async (s) => body(await s.api("POST", "/api/settings/test/email", {})));
  await step("test s3 bad filesystem", async (s) => body(await s.api("POST", "/api/settings/test/s3", { filesystem: "nope" })));
  await step("test s3 missing filesystem", async (s) => body(await s.api("POST", "/api/settings/test/s3", {})));
  await step("apple secret validation", async (s) => body(await s.api("POST", "/api/settings/apple/generate-client-secret", { clientId: "", teamId: "short", keyId: "", privateKey: "nope", duration: 0 })));
  await step("apple secret duration too long", async (s) => body(await s.api("POST", "/api/settings/apple/generate-client-secret", { clientId: "c", teamId: "ABCDEFGHIJ", keyId: "ABCDEFGHIJ", privateKey: "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END PRIVATE KEY-----", duration: 99999999 })));
  await step("anon PATCH", async (s) => body(await s.api("PATCH", "/api/settings", { meta: { appName: "x" } }, false)));
  await step("anon test email", async (s) => body(await s.api("POST", "/api/settings/test/email", { email: "a@b.co", template: "otp" }, false)));
} finally { await pb.teardown(); await vb.teardown(); }
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
