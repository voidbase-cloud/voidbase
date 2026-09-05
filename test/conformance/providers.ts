// Provider catalog conformance: every provider PocketBase ships is configured on both servers and auth-methods
// is compared (display name, endpoints, scopes, PKCE, logo presence).
//   bun test/conformance/providers.ts [pb] [vb]
const PB = process.argv[2] ?? "http://127.0.0.1:8090";
const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
const NAMES = ["apple", "bitbucket", "box", "discord", "facebook", "gitea", "gitee", "github", "gitlab", "google", "kakao", "lark", "linear", "livechat", "mailcow", "microsoft", "monday", "notion", "oidc", "oidc2", "oidc3", "patreon", "planningcenter", "spotify", "strava", "trakt", "twitch", "twitter", "vk", "wakatime", "yandex"];
const providers = NAMES.map((name) => ({ name, clientId: `client-${name}`, clientSecret: "secret", ...(name === "mailcow" || name.startsWith("oidc") ? { authURL: `https://${name}.example/authorize`, tokenURL: `https://${name}.example/token`, userInfoURL: `https://${name}.example/userinfo` } : {}) }));
class Server {
  h: Record<string, string> = {}; saved: unknown = null;
  constructor(public base: string) {}
  async api(method: string, path: string, body?: object) { const r = await fetch(`${this.base}${path}`, { method, headers: { ...this.h, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null }; }
  async setup() { const a = await this.api("POST", "/api/collections/_superusers/auth-with-password", CREDS); this.h = { authorization: String(a.json?.token) }; this.saved = (await this.api("GET", "/api/collections/users")).json?.oauth2; const r = await this.api("PATCH", "/api/collections/users", { oauth2: { enabled: true, providers, mappedFields: { id: "", name: "name", username: "", avatarURL: "" } } }); if (r.status !== 200) throw new Error(`${this.base} ${r.status} ${JSON.stringify(r.json)}`); }
  async teardown() { const s = (this.saved ?? {}) as Record<string, unknown>; await this.api("PATCH", "/api/collections/users", { oauth2: { ...s, enabled: false, providers: [] } }); }
}
const pb = new Server(PB), vb = new Server(VB); await pb.setup(); await vb.setup();
let pass = 0, fail = 0;
// exact string with the per-request values blanked: parameter order matters to the SDK, which appends redirect_uri
const shape = (u: string) => u.replace(/state=[A-Za-z0-9]+/, "state=<S>").replace(/code_challenge=[A-Za-z0-9_-]+/, "code_challenge=<C>");
try {
  const [a, b] = await Promise.all([pb.api("GET", "/api/collections/users/auth-methods"), vb.api("GET", "/api/collections/users/auth-methods")]);
  const A = ((a.json?.oauth2 as { providers: Record<string, string>[] }).providers), B = ((b.json?.oauth2 as { providers: Record<string, string>[] }).providers);
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const count = { pb: A.length, vb: B.length }; count.pb === count.vb ? pass++ : fail++;
  console.log(`${count.pb === count.vb ? "PASS" : "FAIL"}  provider count ${JSON.stringify(count)}`);
  for (const name of NAMES) {
    const x = A.find((p) => p.name === name), y = B.find((p) => p.name === name);
    const nx = x ? { displayName: x.displayName, logo: !!x.logo, pkce: x.codeChallengeMethod, authURL: shape(x.authURL!) } : null;
    const ny = y ? { displayName: y.displayName, logo: !!y.logo, pkce: y.codeChallengeMethod, authURL: shape(y.authURL!) } : null;
    const ok = same(nx, ny); ok ? pass++ : fail++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(16)} ${ok ? JSON.stringify(nx).slice(0, 140) : `\n      pb=${JSON.stringify(nx)}\n      vb=${JSON.stringify(ny)}`}`);
  }
} finally { await pb.teardown(); await vb.teardown(); }
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
