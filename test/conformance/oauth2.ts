// OAuth2 conformance against the reference PocketBase: the SDK's realtime flow replayed over raw HTTP with a mock
// OIDC provider (test/mock-oidc.ts on 5190): auth-methods provider info, @oauth2 realtime handoff from
// /api/oauth2-redirect, auth-with-oauth2 responses (new and returning user), and the error responses.
//   bun test/mock-oidc.ts &   then   bun test/conformance/oauth2.ts [pb=http://127.0.0.1:8090] [vb=http://127.0.0.1:5180]
const PB = process.argv[2] ?? "http://127.0.0.1:8090";
const VB = process.argv[3] ?? "http://127.0.0.1:5180";
const MOCK = "http://127.0.0.1:5190";
const CREDS = { identity: "admin@example.com", password: "changeme123" };
const PROVIDER = { name: "oidc", clientId: "voidbase-test", clientSecret: "s3cret", authURL: `${MOCK}/authorize`, tokenURL: `${MOCK}/token`, userInfoURL: `${MOCK}/userinfo`, displayName: "Mock OIDC", pkce: true };

class Server {
  h: Record<string, string> = {};
  savedOAuth2: unknown = null;
  constructor(public base: string) {}
  async api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const r = await fetch(`${this.base}${path}`, { method, headers: { ...this.h, ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json: Record<string, unknown> | null = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: r.status, json, headers: r.headers };
  }
  async setup() {
    const auth = await this.api("POST", "/api/collections/_superusers/auth-with-password", CREDS);
    this.h = { authorization: String(auth.json?.token) };
    const users = await this.api("GET", "/api/collections/users");
    this.savedOAuth2 = users.json?.oauth2;
    for (const email of ["mock.user@example.com", "second.mock@example.com"]) {
      const list = await this.api("GET", `/api/collections/users/records?filter=${encodeURIComponent(`email = "${email}"`)}`);
      for (const it of ((list.json?.items as { id: string }[]) ?? [])) await this.api("DELETE", `/api/collections/users/records/${it.id}`);
    }
    const upd = await this.api("PATCH", "/api/collections/users", { oauth2: { enabled: true, providers: [PROVIDER], mappedFields: { id: "", name: "name", username: "username", avatarURL: "" } } });
    if (upd.status !== 200) throw new Error(`${this.base} enable oauth2: ${upd.status} ${JSON.stringify(upd.json)}`);
  }
  async teardown() {
    for (const email of ["mock.user@example.com", "second.mock@example.com"]) {
      const list = await this.api("GET", `/api/collections/users/records?filter=${encodeURIComponent(`email = "${email}"`)}`);
      for (const it of ((list.json?.items as { id: string }[]) ?? [])) await this.api("DELETE", `/api/collections/users/records/${it.id}`);
    }
    const saved = (this.savedOAuth2 ?? { enabled: false, providers: [], mappedFields: {} }) as Record<string, unknown>;
    await this.api("PATCH", "/api/collections/users", { oauth2: { ...saved, enabled: false, providers: [] } });
  }
  // SSE client subscribed to @oauth2; resolves with the clientId and a promise for the @oauth2 message
  async realtimeClient() {
    const ac = new AbortController();
    const res = await fetch(`${this.base}/api/realtime`, { headers: { accept: "text/event-stream" }, signal: ac.signal });
    const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
    let resolveConnect!: (id: string) => void, resolveMsg!: (d: Record<string, unknown>) => void;
    const connected = new Promise<string>((r) => (resolveConnect = r)), message = new Promise<Record<string, unknown>>((r) => (resolveMsg = r));
    (async () => { for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const frame = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /^event:\s*(.*)$/m.exec(frame)?.[1]?.trim(); const data = /^data:\s*(.*)$/m.exec(frame)?.[1]; if (ev === "PB_CONNECT" && data) resolveConnect(JSON.parse(data).clientId); if (ev === "@oauth2" && data) resolveMsg(JSON.parse(data)); } } })().catch(() => {});
    const clientId = await Promise.race([connected, new Promise<string>((_, rej) => setTimeout(() => rej(new Error("PB_CONNECT timeout")), 8000))]);
    const sub = await this.api("POST", "/api/realtime", { clientId, subscriptions: ["@oauth2"] });
    return { clientId, subStatus: sub.status, message: Promise.race([message, new Promise<Record<string, unknown>>((_, rej) => setTimeout(() => rej(new Error("@oauth2 timeout")), 8000))]), close: () => ac.abort() };
  }
}

const pb = new Server(PB), vb = new Server(VB);
await pb.setup(); await vb.setup();
let pass = 0, fail = 0;
const step = async (label: string, run: (s: Server) => Promise<unknown>) => {
  const [a, b] = await Promise.all([run(pb).catch((e) => ({ error: String(e) })), run(vb).catch((e) => ({ error: String(e) }))]);
  const same = JSON.stringify(a) === JSON.stringify(b); same ? pass++ : fail++;
  console.log(`${same ? "PASS" : "FAIL"}  ${label.padEnd(44)} pb=${JSON.stringify(a).slice(0, 260)}${same ? "" : `\n      vb=${JSON.stringify(b).slice(0, 260)}`}`);
};
const authURLShape = (u: string) => { const url = new URL(u.replace(/&redirect_uri=$/, "")); return { host: url.host, path: url.pathname, params: [...url.searchParams.keys()].sort(), endsWithEmptyRedirect: u.endsWith("&redirect_uri="), scope: url.searchParams.get("scope"), method: url.searchParams.get("code_challenge_method") }; };
const state: Record<string, Record<string, string>> = { [PB]: {}, [VB]: {} };
try {
  await step("auth-methods lists the provider", async (s) => {
    const r = await s.api("GET", "/api/collections/users/auth-methods"); const p = (r.json!.oauth2 as { enabled: boolean; providers: Record<string, string>[] });
    const info = p.providers[0]!; state[s.base]!.codeVerifier = info.codeVerifier!; state[s.base]!.authURL = info.authURL!;
    return { status: r.status, enabled: p.enabled, count: p.providers.length, keys: Object.keys(info).sort(), name: info.name, displayName: info.displayName, hasLogo: !!info.logo, stateLen: info.state!.length, verifierLen: info.codeVerifier!.length, challengeLen: info.codeChallenge!.length, method: info.codeChallengeMethod, authURL: authURLShape(info.authURL!), legacy: Array.isArray(r.json!.authProviders) && (r.json!.authProviders as { logo: string }[])[0]!.logo === "" };
  });
  await step("realtime handoff: redirect delivers {state, code} to the @oauth2 subscriber", async (s) => {
    const rt = await s.realtimeClient();
    const redirectURL = `${s.base}/api/oauth2-redirect`;
    const url = new URL(state[s.base]!.authURL + redirectURL); url.searchParams.set("state", rt.clientId);
    const auth = await fetch(url, { redirect: "manual" });
    const back = new URL(auth.headers.get("location") ?? "");
    const cb = await fetch(back, { redirect: "manual" });
    const msg = await rt.message; rt.close();
    state[s.base]!.code = String(msg.code ?? "");
    return { subStatus: rt.subStatus, mockRedirect: auth.status, callbackStatus: cb.status, callbackLocation: cb.headers.get("location"), msgKeys: Object.keys(msg).sort(), stateMatches: msg.state === rt.clientId, hasCode: !!msg.code };
  });
  await step("redirect without a waiting client fails", async (s) => { const r = await fetch(`${s.base}/api/oauth2-redirect?state=nope&code=x`, { redirect: "manual" }); return { status: r.status, location: r.headers.get("location") }; });
  const recordShape = (j: Record<string, unknown>) => { const rec = j.record as Record<string, unknown>, meta = j.meta as Record<string, unknown>; return { keys: Object.keys(j).sort(), metaKeys: Object.keys(meta).sort(), meta: { id: meta.id, name: meta.name, username: meta.username, email: meta.email, avatarURL: meta.avatarURL, isNew: meta.isNew, hasToken: !!meta.accessToken, hasRefresh: !!meta.refreshToken, expiryShape: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(meta.expiry)), rawUserSub: (meta.rawUser as Record<string, unknown>)?.sub }, record: { email: rec.email, name: rec.name, username: rec.username, verified: rec.verified, emailVisibility: rec.emailVisibility, collectionName: rec.collectionName }, hasToken: typeof j.token === "string" }; };
  await step("auth-with-oauth2 creates and links a new user", async (s) => {
    const r = await s.api("POST", "/api/collections/users/auth-with-oauth2", { provider: "oidc", code: state[s.base]!.code, codeVerifier: state[s.base]!.codeVerifier, redirectURL: `${s.base}/api/oauth2-redirect`, createData: {} });
    if (r.status !== 200) return { status: r.status, body: r.json };
    state[s.base]!.recordId = String((r.json!.record as { id: string }).id);
    return { status: r.status, ...recordShape(r.json!) };
  });
  await step("second sign-in returns the same record (isNew false)", async (s) => {
    const methods = await s.api("GET", "/api/collections/users/auth-methods"); const info = (methods.json!.oauth2 as { providers: Record<string, string>[] }).providers[0]!;
    const redirectURL = `${s.base}/api/oauth2-redirect`;
    const url = new URL(info.authURL! + redirectURL); const auth = await fetch(url, { redirect: "manual" }); const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;
    const r = await s.api("POST", "/api/collections/users/auth-with-oauth2", { provider: "oidc", code, codeVerifier: info.codeVerifier, redirectURL });
    if (r.status !== 200) return { status: r.status, body: r.json };
    return { status: r.status, sameRecord: (r.json!.record as { id: string }).id === state[s.base]!.recordId, isNew: (r.json!.meta as { isNew: boolean }).isNew };
  });
  await step("bad code -> 400", async (s) => s.api("POST", "/api/collections/users/auth-with-oauth2", { provider: "oidc", code: "nope", codeVerifier: "x", redirectURL: `${s.base}/api/oauth2-redirect` }).then((r) => ({ status: r.status, body: r.json })));
  await step("unknown provider -> validation error", async (s) => s.api("POST", "/api/collections/users/auth-with-oauth2", { provider: "nothere", code: "x" }).then((r) => ({ status: r.status, body: r.json })));
  await step("missing fields -> validation error", async (s) => s.api("POST", "/api/collections/users/auth-with-oauth2", {}).then((r) => ({ status: r.status, body: r.json })));
  await step("oauth2 disabled -> 403", async (s) => { const saved = s.savedOAuth2 as Record<string, unknown> | null; await s.api("PATCH", "/api/collections/users", { oauth2: { enabled: false, providers: [PROVIDER], mappedFields: saved?.mappedFields ?? {} } }); const r = await s.api("POST", "/api/collections/users/auth-with-oauth2", { provider: "oidc", code: "x" }); return { status: r.status, body: r.json }; });
} finally { await pb.teardown(); await vb.teardown(); }
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
