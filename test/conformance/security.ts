// Security review as a differential suite: injection attempts through filter/sort/fields/collection names, token
// misuse, superuser-only endpoints as a normal user, protected/ traversal file paths, disabled batch, view writes.
// Same request against the reference PocketBase and voidbase; status and message must match.
//   bun test/conformance/security.ts [pb=http://127.0.0.1:8090] [vb=http://127.0.0.1:5180]
const PB = process.argv[2] ?? "http://127.0.0.1:8090"; const VB = process.argv[3] ?? "http://127.0.0.1:5180";
type Res = { status: number; message: string; extra?: unknown };
async function call(base: string, method: string, path: string, opts: { token?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {}): Promise<Res & { json: Record<string, unknown> }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = opts.token;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(base + path, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : opts.raw });
  const text = await r.text(); let json: Record<string, unknown> = {}; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 60) }; }
  return { status: r.status, message: String(json.message ?? ""), json };
}
async function login(base: string, coll: string, identity: string, password: string) { const r = await call(base, "POST", `/api/collections/${coll}/auth-with-password`, { body: { identity, password } }); return { token: String(r.json.token ?? ""), id: String((r.json.record as { id: string } | undefined)?.id ?? "") }; }

interface Ctx { base: string; su: string; user: string; userId: string }
const cases: { name: string; run: (c: Ctx) => Promise<Res> }[] = [
  // filter / sort / fields injection through the public posts collection
  ...["title = 'x' OR 1=1 --", "title = \"x\"; DROP TABLE posts; --", "`title` = 'x'", "title ~ '%'", "id = 'x' || 1=1", "nonexistent.field = 1", "title = 'x' && (", "@collection.users.email != ''", "@request.auth.id != ''", "user.tokenKey != ''", "created:lower = 'x'"].map((f) => ({
    name: `guest filter ${JSON.stringify(f)}`,
    run: async (c: Ctx) => { const r = await call(c.base, "GET", `/api/collections/posts/records?filter=${encodeURIComponent(f)}`); return { status: r.status, message: r.message, extra: r.status === 200 ? typeof r.json.totalItems : undefined }; },
  })),
  ...["title; DROP TABLE posts", "-@rowid", "nonexistent", "user.tokenKey", "@random", "-created,+title"].map((s) => ({
    name: `guest sort ${JSON.stringify(s)}`,
    run: async (c: Ctx) => { const r = await call(c.base, "GET", `/api/collections/posts/records?perPage=1&sort=${encodeURIComponent(s)}`); return { status: r.status, message: r.message }; },
  })),
  ...["name;--", "*:excerpt(1)", "name,expand.nope.tokenKey", "`id`", "*,tokenKey,password", "email:excerpt(2,true)"].map((f) => ({
    name: `superuser fields ${JSON.stringify(f)} on users`,
    run: async (c: Ctx) => { const r = await call(c.base, "GET", `/api/collections/users/records?perPage=1&filter=${encodeURIComponent("email = 'user@example.com'")}&fields=${encodeURIComponent(f)}`, { token: c.su }); const item = ((r.json.items as Record<string, unknown>[]) ?? [])[0]; return { status: r.status, message: r.message, extra: r.status === 200 ? (item ? Object.entries(item).filter(([k]) => k !== "id" && k !== "created" && k !== "updated" && k !== "collectionId" && k !== "username").sort() : "no item") : undefined }; },
  })),
  ...["posts%60", "posts'--", "posts%3B", "..%2Fposts", "_superusers", "_params", "sqlite_master"].map((n) => ({
    name: `collection name ${n} public list`,
    run: async (c: Ctx) => { const r = await call(c.base, "GET", `/api/collections/${n}/records`); return { status: r.status, message: r.message }; },
  })),
  // hidden fields and system collections as a normal user
  { name: "user filters users by tokenKey (hidden)", run: async (c) => { const r = await call(c.base, "GET", `/api/collections/users/records?filter=${encodeURIComponent("tokenKey != ''")}`, { token: c.user }); return { status: r.status, message: r.message }; } },
  { name: "user sorts users by password (hidden)", run: async (c) => { const r = await call(c.base, "GET", `/api/collections/users/records?sort=password`, { token: c.user }); return { status: r.status, message: r.message }; } },
  { name: "user lists _superusers", run: async (c) => { const r = await call(c.base, "GET", `/api/collections/_superusers/records`, { token: c.user }); return { status: r.status, message: r.message }; } },
  { name: "user lists _externalAuths", run: async (c) => { const r = await call(c.base, "GET", `/api/collections/_externalAuths/records`, { token: c.user }); return { status: r.status, message: r.message }; } },
  { name: "user reads own record keeps password blank", run: async (c) => { const r = await call(c.base, "GET", `/api/collections/users/records/${c.userId}`, { token: c.user }); return { status: r.status, message: r.message, extra: { password: r.json.password, tokenKey: "tokenKey" in r.json } }; } },
  // superuser-only endpoints as a normal user and as a guest
  ...[["GET", "/api/settings"], ["GET", "/api/logs"], ["GET", "/api/crons"], ["POST", "/api/sql"], ["GET", "/api/collections"], ["GET", "/api/backups"], ["PUT", "/api/collections/import"], ["POST", "/api/collections/users/impersonate/x"], ["DELETE", "/api/collections/posts/truncate"]].map(([m, p]) => ({
    name: `${m} ${p} as user`,
    run: async (c: Ctx) => { const r = await call(c.base, m!, p!, { token: c.user, body: m === "GET" || m === "DELETE" ? undefined : {} }); return { status: r.status, message: r.message }; },
  })),
  ...[["GET", "/api/settings"], ["GET", "/api/logs"], ["POST", "/api/sql"], ["GET", "/api/collections"]].map(([m, p]) => ({
    name: `${m} ${p} as guest`,
    run: async (c: Ctx) => { const r = await call(c.base, m!, p!, { body: m === "GET" ? undefined : {} }); return { status: r.status, message: r.message }; },
  })),
  // token misuse
  { name: "file token used as auth", run: async (c) => { const t = await call(c.base, "POST", "/api/files/token", { token: c.user }); const r = await call(c.base, "GET", `/api/collections/users/records/${c.userId}`, { token: String(t.json.token ?? "") }); return { status: r.status, message: r.message, extra: t.status }; } },
  { name: "superuser token on wrong-collection refresh", run: async (c) => { const r = await call(c.base, "POST", "/api/collections/users/auth-refresh", { token: c.su }); return { status: r.status, message: r.message }; } },
  { name: "tampered token signature", run: async (c) => { const parts = c.user.split("."); const bad = `${parts[0]}.${parts[1]}.${parts[2]!.replace(/.$/, (ch) => (ch === "A" ? "B" : "A"))}`; const r = await call(c.base, "GET", `/api/collections/users/records/${c.userId}`, { token: bad }); return { status: r.status, message: r.message }; } },
  { name: "garbage authorization header", run: async (c) => { const r = await call(c.base, "GET", `/api/collections/users/records/${c.userId}`, { token: "Bearer not.a.jwt" }); return { status: r.status, message: r.message }; } },
  { name: "old token after password change", run: async (c) => {
    const fresh = await login(c.base, "users", "user@example.com", "changeme123");
    await call(c.base, "PATCH", `/api/collections/users/records/${c.userId}`, { token: c.su, body: { password: "changeme123x", passwordConfirm: "changeme123x" } });
    const r = await call(c.base, "POST", "/api/collections/users/auth-refresh", { token: fresh.token });
    await call(c.base, "PATCH", `/api/collections/users/records/${c.userId}`, { token: c.su, body: { password: "changeme123", passwordConfirm: "changeme123" } });
    return { status: r.status, message: r.message };
  } },
  // files
  { name: "file path traversal", run: async (c) => { const list = await call(c.base, "GET", "/api/collections/posts/records?perPage=1"); const id = String(((list.json.items as { id: string }[]) ?? [])[0]?.id ?? "x"); const r = await call(c.base, "GET", `/api/files/posts/${id}/..%2F..%2Fetc%2Fpasswd`); return { status: r.status, message: r.message }; } },
  { name: "file not in record", run: async (c) => { const list = await call(c.base, "GET", "/api/collections/posts/records?perPage=1"); const id = String(((list.json.items as { id: string }[]) ?? [])[0]?.id ?? "x"); const r = await call(c.base, "GET", `/api/files/posts/${id}/nope.png`); return { status: r.status, message: r.message }; } },
  { name: "file of unknown collection", run: async (c) => { const r = await call(c.base, "GET", `/api/files/nope/x/y.png`); return { status: r.status, message: r.message }; } },
  // batch disabled by default, writes to views, unknown routes
  { name: "batch while disabled", run: async (c) => { const r = await call(c.base, "POST", "/api/batch", { token: c.su, body: { requests: [{ method: "GET", url: "/api/health" }] } }); return { status: r.status, message: r.message }; } },
  { name: "create record in a view", run: async (c) => {
    await call(c.base, "DELETE", "/api/collections/ks_secview", { token: c.su });
    const cr = await call(c.base, "POST", "/api/collections", { token: c.su, body: { name: "ks_secview", type: "view", viewQuery: "select id, title from posts" } });
    const r = await call(c.base, "POST", "/api/collections/ks_secview/records", { token: c.su, body: { title: "x" } });
    const d = await call(c.base, "DELETE", "/api/collections/ks_secview/records/x", { token: c.su });
    await call(c.base, "DELETE", "/api/collections/ks_secview", { token: c.su });
    return { status: r.status, message: r.message, extra: [cr.status, d.status] };
  } },
  { name: "guest creates a user with verified=true and a superuser email", run: async (c) => {
    const email = `sec-${Date.now()}@example.com`;
    const r = await call(c.base, "POST", "/api/collections/users/records", { body: { email, password: "changeme123", passwordConfirm: "changeme123", verified: true, emailVisibility: true } });
    const id = String(r.json.id ?? "");
    if (id) await call(c.base, "DELETE", `/api/collections/users/records/${id}`, { token: c.su });
    return { status: r.status, message: r.message, extra: { verified: r.json.verified } };
  } },
  { name: "user updates another user's record", run: async (c) => {
    const others = await call(c.base, "GET", `/api/collections/users/records?perPage=50`, { token: c.su });
    const other = ((others.json.items as { id: string }[]) ?? []).find((u) => u.id !== c.userId);
    if (!other) return { status: -1, message: "no second user" };
    const r = await call(c.base, "PATCH", `/api/collections/users/records/${other.id}`, { token: c.user, body: { name: "pwned" } });
    return { status: r.status, message: r.message };
  } },
  { name: "superuser token on users request-email-change", run: async (c) => { const r = await call(c.base, "POST", "/api/collections/users/request-email-change", { token: c.su, body: { newEmail: "x@example.com" } }); return { status: r.status, message: r.message }; } },
  { name: "malformed JSON on record update", run: async (c) => { const r = await call(c.base, "PATCH", `/api/collections/users/records/${c.userId}`, { token: c.su, raw: "{bad", headers: { "content-type": "application/json" } }); return { status: r.status, message: r.message }; } },
  { name: "malformed JSON on collection create", run: async (c) => { const r = await call(c.base, "POST", "/api/collections", { token: c.su, raw: "{bad", headers: { "content-type": "application/json" } }); return { status: r.status, message: r.message }; } },
  { name: "malformed JSON on collection update", run: async (c) => { const r = await call(c.base, "PATCH", "/api/collections/posts", { token: c.su, raw: "{bad", headers: { "content-type": "application/json" } }); return { status: r.status, message: r.message }; } },
  { name: "malformed JSON on import", run: async (c) => { const r = await call(c.base, "PUT", "/api/collections/import", { token: c.su, raw: "{bad", headers: { "content-type": "application/json" } }); return { status: r.status, message: r.message }; } },
  { name: "malformed JSON on auth-with-password", run: async (c) => { const r = await call(c.base, "POST", "/api/collections/users/auth-with-password", { raw: "{bad", headers: { "content-type": "application/json" } }); return { status: r.status, message: r.message }; } },
  { name: "malformed JSON on realtime subscriptions", run: async (c) => { const r = await call(c.base, "POST", "/api/realtime", { raw: "{bad", headers: { "content-type": "application/json" } }); return { status: r.status, message: r.message }; } },
  { name: "unknown api route", run: async (c) => { const r = await call(c.base, "GET", "/api/nope"); return { status: r.status, message: r.message }; } },
  { name: "malformed JSON body", run: async (c) => { const r = await call(c.base, "POST", "/api/collections/posts/records", { token: c.su, raw: "{not json", headers: { "content-type": "application/json" } }); return { status: r.status, message: r.message }; } },
];

async function ctx(base: string): Promise<Ctx> {
  const su = await login(base, "_superusers", "admin@example.com", "changeme123");
  const user = await login(base, "users", "user@example.com", "changeme123");
  if (!su.token || !user.token) throw new Error(`${base}: login failed`);
  return { base, su: su.token, user: user.token, userId: user.id };
}
const [pb, vb] = await Promise.all([ctx(PB), ctx(VB)]);
let pass = 0, fail = 0;
for (const t of cases) {
  const [a, b] = await Promise.all([t.run(pb), t.run(vb)]);
  const ok = JSON.stringify(a) === JSON.stringify(b);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${t.name}  -> ${b.status} ${b.message}${b.extra !== undefined ? " " + JSON.stringify(b.extra) : ""}`);
  if (!ok) console.log(`   pb ${JSON.stringify(a)}`);
}
console.log(`\n${pass} pass, ${fail} fail`); process.exit(fail ? 1 : 0);
