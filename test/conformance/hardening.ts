// Rate limits and trusted proxies against PocketBase: rule matching (exact, *:tag, prefix), audiences, superuser
// and excluded IPs exemptions, fixed windows, leftmost/rightmost proxy IP. Security headers and body limit too.
//   bun test/conformance/hardening.ts [pb] [vb]
const PB = process.argv[2] ?? "http://127.0.0.1:8090";
const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
class Server {
  h: Record<string, string> = {}; saved: Record<string, unknown> = {};
  constructor(public base: string) {}
  async api(method: string, path: string, body?: object, headers: Record<string, string> = {}) { const r = await fetch(`${this.base}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null, headers: r.headers }; }
  async setup() { const a = await this.api("POST", "/api/collections/_superusers/auth-with-password", CREDS); this.h = { authorization: String(a.json?.token) }; const s = (await this.api("GET", "/api/settings", undefined, this.h)).json!; this.saved = { rateLimits: s.rateLimits, trustedProxy: s.trustedProxy }; }
  async limits(rules: object[], extra: object = {}) { const r = await this.api("PATCH", "/api/settings", { rateLimits: { enabled: true, rules, excludedIPs: [] }, ...extra }, this.h); if (r.status !== 200) throw new Error(`${this.base} settings ${r.status} ${JSON.stringify(r.json)}`); }
  async teardown() { await this.api("PATCH", "/api/settings", this.saved, this.h); }
}
const pb = new Server(PB), vb = new Server(VB); await pb.setup(); await vb.setup();
let pass = 0, fail = 0;
const step = async (label: string, run: (s: Server) => Promise<unknown>) => {
  const a = await run(pb).catch((e) => ({ error: String(e) })); const b = await run(vb).catch((e) => ({ error: String(e) }));
  const same = JSON.stringify(a) === JSON.stringify(b); same ? pass++ : fail++;
  console.log(`${same ? "PASS" : "FAIL"} ${label.padEnd(54)} pb=${JSON.stringify(a).slice(0, 220)}${same ? "" : `\n      vb=${JSON.stringify(b).slice(0, 500)}`}`);
};
const burst = async (s: Server, n: number, method: string, path: string, body?: object, headers: Record<string, string> = {}) => { const out: number[] = []; for (let i = 0; i < n; i++) out.push((await s.api(method, path, body, headers)).status); return out; };
try {
  await step("exact path rule: GET /api/health 2 per 3s", async (s) => { await s.limits([{ label: "/api/health", audience: "", duration: 3, maxRequests: 2 }]); await Bun.sleep(3100); const codes = await burst(s, 4, "GET", "/api/health"); const last = await s.api("GET", "/api/health"); return { codes, body: last.json }; });
  await step("superusers are exempt", async (s) => burst(s, 4, "GET", "/api/health", undefined, s.h));
  await step("*:auth rule on failed logins", async (s) => { await s.limits([{ label: "*:auth", audience: "", duration: 3, maxRequests: 2 }]); await Bun.sleep(3100); return burst(s, 4, "POST", "/api/collections/users/auth-with-password", { identity: "nobody@example.com", password: "wrong" }); });
  await step("collection tag rule users:list", async (s) => { await s.limits([{ label: "users:list", audience: "", duration: 3, maxRequests: 1 }]); await Bun.sleep(3100); return { users: await burst(s, 3, "GET", "/api/collections/users/records"), posts: await burst(s, 3, "GET", "/api/collections/posts/records?perPage=1") }; });
  await step("prefix rule /api/ hits plain routes, not collection routes", async (s) => { await s.limits([{ label: "/api/", audience: "", duration: 3, maxRequests: 1 }]); await Bun.sleep(3100); return { health: await burst(s, 3, "GET", "/api/health"), posts: await burst(s, 3, "GET", "/api/collections/posts/records?perPage=1") }; });
  await step("@guest audience does not limit authenticated users", async (s) => { await s.limits([{ label: "/api/health", audience: "@guest", duration: 3, maxRequests: 1 }]); await Bun.sleep(3100); const u = await s.api("POST", "/api/collections/users/auth-with-password", { identity: "user@example.com", password: "changeme123" }); return { guest: await burst(s, 3, "GET", "/api/health"), authed: await burst(s, 3, "GET", "/api/health", undefined, { authorization: String(u.json?.token) }) }; });
  await step("excludedIPs bypass", async (s) => { await s.limits([{ label: "/api/health", audience: "", duration: 3, maxRequests: 1 }], { rateLimits: { enabled: true, rules: [{ label: "/api/health", audience: "", duration: 3, maxRequests: 1 }], excludedIPs: ["127.0.0.1"] } }); await Bun.sleep(3100); return burst(s, 3, "GET", "/api/health"); });
  await step("trusted proxy rightmost IP", async (s) => { await s.api("PATCH", "/api/settings", { trustedProxy: { headers: ["X-Forwarded-For"], useLeftmostIP: false }, rateLimits: { enabled: true, rules: [{ label: "/api/health", audience: "", duration: 3, maxRequests: 1 }], excludedIPs: ["10.0.0.9"] } }, s.h); await Bun.sleep(3100); return { excludedAsRightmost: await burst(s, 3, "GET", "/api/health", undefined, { "X-Forwarded-For": "1.2.3.4, 10.0.0.9" }), notExcluded: await burst(s, 3, "GET", "/api/health", undefined, { "X-Forwarded-For": "10.0.0.9, 5.6.7.8" }) }; });
  await step("trusted proxy leftmost IP", async (s) => { await s.api("PATCH", "/api/settings", { trustedProxy: { headers: ["X-Forwarded-For"], useLeftmostIP: true }, rateLimits: { enabled: true, rules: [{ label: "/api/health", audience: "", duration: 3, maxRequests: 1 }], excludedIPs: ["10.0.0.9"] } }, s.h); await Bun.sleep(3100); return { excludedAsLeftmost: await burst(s, 3, "GET", "/api/health", undefined, { "X-Forwarded-For": "10.0.0.9, 5.6.7.8" }) }; });
  await step("disabled limits", async (s) => { await s.api("PATCH", "/api/settings", { trustedProxy: { headers: [], useLeftmostIP: false }, rateLimits: { enabled: false, rules: [{ label: "/api/health", audience: "", duration: 3, maxRequests: 1 }], excludedIPs: [] } }, s.h); await Bun.sleep(3100); return burst(s, 3, "GET", "/api/health"); });
  await step("security headers", async (s) => { const r = await s.api("GET", "/api/health"); return ["x-content-type-options", "x-frame-options", "x-xss-protection"].map((h) => r.headers.get(h)); }); // Cross-Origin-Opener-Policy is 0.40-only, kept in voidbase
  await step("oversized body", async (s) => { const r = await fetch(`${s.base}/api/collections/posts/records`, { method: "POST", headers: { "content-type": "application/json", "content-length": String(40 * 1024 * 1024) }, body: "{}", ...(s.h) }).catch((e) => ({ status: -1, json: async () => String(e) } as unknown as Response)); return { status: r.status }; });
} finally { await pb.teardown(); await vb.teardown(); }
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
