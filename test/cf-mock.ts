// In-memory Cloudflare REST API for tests: the endpoints `voidbase deploy` (D1/R2/queue provisioning) and
// `voidbase/cloud` (script upload with assets, schedules, subdomain, D1 query, teardown) use, with a fixed bearer token.
//   bun test/cf-mock.ts [port=5197]      token: cf-test-token   account: acc123
// A second token, cf-test-token-noqueues, is accepted everywhere except the Queues endpoints (a token without Queues edit).
// GET /__state dumps everything, DELETE /__calls resets it, GET /__calls lists the requests made.
const port = Number(process.argv[2] ?? 5197); const TOKEN = "cf-test-token"; const TOKEN_NOQUEUES = "cf-test-token-noqueues"; const ACCOUNT = "acc123";
const UPLOAD_JWT = "upload-jwt", COMPLETION_JWT = "completion-jwt";
interface Script { metadata: Record<string, unknown>; modules: string[]; schedules: string[]; subdomain: boolean; assets: string[]; migrationTag: string | null; created_on: string; modified_on: string }
const d1 = new Map<string, string>(); const d1Migrations = new Map<string, string[]>(); const d1Queries = new Map<string, string[]>();
const r2 = new Map<string, Set<string>>(); const queues = new Map<string, string>(); const consumers = new Map<string, Record<string, unknown>[]>();
const scripts = new Map<string, Script>(); const zones = [{ id: "zone123", name: "example.com" }]; const domains = new Map<string, { id: string; hostname: string; service: string; zone_id: string; environment: string }>(); const uploadedHashes = new Set<string>(); const pendingSessions = new Map<string, Set<string>>(); const calls: string[] = [];
const ok = (result: unknown, extra: Record<string, unknown> = {}, status = 200) => Response.json({ success: true, errors: [], messages: [], result, ...extra }, { status });
const err = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
const reset = () => { calls.length = 0; domains.clear(); d1.clear(); d1Migrations.clear(); d1Queries.clear(); r2.clear(); queues.clear(); consumers.clear(); scripts.clear(); uploadedHashes.clear(); pendingSessions.clear(); };
const state = () => ({ domains: [...domains.values()], d1: [...d1.entries()], d1Migrations: Object.fromEntries(d1Migrations), d1Queries: Object.fromEntries(d1Queries), r2: Object.fromEntries([...r2.entries()].map(([k, v]) => [k, [...v]])), queues: [...queues.entries()], consumers: Object.fromEntries(consumers), scripts: Object.fromEntries(scripts), uploadedHashes: [...uploadedHashes] });
Bun.serve({ port, hostname: "127.0.0.1", maxRequestBodySize: 200 * 1024 * 1024, async fetch(req) {
  const url = new URL(req.url); const p = url.pathname; const A = `/accounts/${ACCOUNT}`;
  if (p === "/__calls") { if (req.method === "DELETE") { reset(); return new Response(null, { status: 204 }); } return Response.json(calls); }
  if (p === "/__state") return Response.json(state());
  calls.push(`${req.method} ${p}${url.search}`);
  const bearer = req.headers.get("authorization");
  if (p === `${A}/workers/assets/upload`) { // authenticated with the upload session JWT
    if (bearer !== `Bearer ${UPLOAD_JWT}`) return err(401, 10001, "invalid upload token");
    const form = await req.formData(); let done = false;
    for (const [hash, value] of form.entries()) { uploadedHashes.add(hash); if (typeof value !== "string" && !(await value.text()).length) return err(400, 10002, `empty asset ${hash}`); }
    for (const [, pending] of pendingSessions) { for (const h of [...pending]) if (uploadedHashes.has(h)) pending.delete(h); if (pending.size === 0) done = true; }
    return done ? ok({ jwt: COMPLETION_JWT }, {}, 201) : ok({});
  }
  if (bearer !== `Bearer ${TOKEN}` && bearer !== `Bearer ${TOKEN_NOQUEUES}`) return err(400, 10000, "Authentication error");
  if (p === "/zones") { const name = url.searchParams.get("name"); return ok(zones.filter((z) => !name || z.name === name)); }
  if (p === `${A}/workers/domains` && req.method === "GET") { const svc = url.searchParams.get("service"), host = url.searchParams.get("hostname"); return ok([...domains.values()].filter((d) => (!svc || d.service === svc) && (!host || d.hostname === host))); }
  if (p === `${A}/workers/domains` && req.method === "PUT") { const b = (await req.json()) as { hostname: string; service: string; zone_id: string; environment?: string }; if (!zones.some((z) => z.id === b.zone_id)) return err(404, 100116, "zone not found"); if (!scripts.has(b.service)) return err(404, 10007, "script not found"); const id = crypto.randomUUID().replace(/-/g, ""); const d = { id, hostname: b.hostname, service: b.service, zone_id: b.zone_id, environment: b.environment ?? "production" }; domains.set(id, d); return ok(d); }
  { const m = p.match(new RegExp(`^${A}/workers/domains/([^/]+)$`)); if (m && req.method === "DELETE") { if (!domains.has(m[1]!)) return err(404, 100117, "domain not found"); domains.delete(m[1]!); return new Response(null, { status: 204 }); } }
  if (p === "/user") return ok({ id: "cfuser1", email: "owner@example.com", first_name: "Test", last_name: "Owner", username: "testowner" });
  if (p === "/accounts") return ok([{ id: ACCOUNT, name: "Test Account" }], { result_info: { page: 1, total_pages: 1 } });
  if (p === "/memberships") return ok([{ id: "m1", status: "accepted", account: { id: ACCOUNT, name: "Test Account" } }]);
  // ---- queues
  if (p.startsWith(`${A}/queues`)) {
    if (bearer === `Bearer ${TOKEN_NOQUEUES}`) return err(403, 10000, "Authentication error: the token lacks Queues permissions");
    const m = p.match(new RegExp(`^${A}/queues/([^/]+)(/consumers)?$`));
    if (p === `${A}/queues` && req.method === "GET") return ok([...queues.entries()].map(([queue_name, queue_id]) => ({ queue_name, queue_id })));
    if (p === `${A}/queues` && req.method === "POST") { const { queue_name } = (await req.json()) as { queue_name: string }; if (queues.has(queue_name)) return err(400, 11009, "queue already exists"); const id = crypto.randomUUID().replace(/-/g, ""); queues.set(queue_name, id); return ok({ queue_name, queue_id: id }); }
    if (m && !m[2] && req.method === "DELETE") { const name = [...queues.entries()].find(([, id]) => id === m[1])?.[0]; if (!name) return err(404, 11000, "queue not found"); queues.delete(name); consumers.delete(m[1]!); return ok(null); }
    if (m && m[2] && req.method === "GET") return ok(consumers.get(m[1]!) ?? []);
    if (m && m[2] && req.method === "POST") { const body = (await req.json()) as Record<string, unknown>; const list = consumers.get(m[1]!) ?? []; if (list.some((c) => c.script_name === body.script_name)) return err(400, 11010, "consumer already exists"); list.push(body); consumers.set(m[1]!, list); return ok(body); }
  }
  // ---- d1
  if (p === `${A}/d1/database` && req.method === "GET") { const name = url.searchParams.get("name"); return ok([...d1.entries()].filter(([n]) => !name || n === name).map(([n, uuid]) => ({ name: n, uuid, version: "production" }))); }
  if (p === `${A}/d1/database` && req.method === "POST") { const { name } = (await req.json()) as { name: string }; if (d1.has(name)) return err(400, 7502, "already exists"); const uuid = crypto.randomUUID(); d1.set(name, uuid); return ok({ name, uuid }); }
  { const m = p.match(new RegExp(`^${A}/d1/database/([^/]+)(/query)?$`));
    if (m) { const uuid = m[1]!; const name = [...d1.entries()].find(([, u]) => u === uuid)?.[0]; if (!name) return err(404, 7404, "database not found");
      if (!m[2] && req.method === "DELETE") { d1.delete(name); d1Migrations.delete(uuid); return ok(null); }
      if (m[2] && req.method === "POST") { const { sql, params } = (await req.json()) as { sql: string; params?: unknown[] }; (d1Queries.get(uuid) ?? d1Queries.set(uuid, []).get(uuid)!).push(sql.slice(0, 80));
        const mig = d1Migrations.get(uuid) ?? d1Migrations.set(uuid, []).get(uuid)!;
        if (/^INSERT INTO d1_migrations/i.test(sql)) mig.push(String(params?.[0]));
        const results = /^SELECT name FROM d1_migrations/i.test(sql) ? mig.map((n) => ({ name: n })) : [];
        return ok([{ results, success: true, meta: {} }]); } } }
  // ---- r2
  if (p === `${A}/r2/buckets` && req.method === "POST") { const { name } = (await req.json()) as { name: string }; if (r2.has(name)) return err(409, 10004, "bucket already exists"); r2.set(name, new Set()); return ok({ name }); }
  { const m = p.match(new RegExp(`^${A}/r2/buckets/([^/]+)(/objects(?:/(.+))?)?$`));
    if (m) { const name = decodeURIComponent(m[1]!); const objs = r2.get(name); if (!objs) return err(404, 10006, "bucket not found");
      if (!m[2]) { if (req.method === "GET") return ok({ name }); if (req.method === "DELETE") { if (objs.size) return err(409, 10008, "bucket is not empty"); r2.delete(name); return ok(null); } }
      else if (!m[3]) { if (req.method === "GET") return ok([...objs].map((key) => ({ key, size: 1 })), { result_info: { is_truncated: false } }); }
      else { const key = decodeURIComponent(m[3]!); if (req.method === "PUT") { objs.add(key); return ok({ key }); } if (req.method === "DELETE") { objs.delete(key); return ok(null); } } } }
  // ---- workers
  if (p === `${A}/workers/subdomain`) return ok({ subdomain: "testsub" });
  if (p === `${A}/workers/scripts` && req.method === "GET") return ok([...scripts.entries()].map(([id, s]) => ({ id, tags: (s.metadata.tags as string[]) ?? [], created_on: s.created_on, modified_on: s.modified_on })));
  { const m = p.match(new RegExp(`^${A}/workers/scripts/([^/]+)(?:/(settings|assets-upload-session|schedules|subdomain))?$`));
    if (m) { const name = m[1]!; const sub = m[2]; const s = scripts.get(name);
      if (!sub && req.method === "PUT") {
        const form = await req.formData(); const meta = form.get("metadata"); if (!meta || typeof meta === "string") return err(400, 10021, "metadata part missing");
        const metadata = JSON.parse(await meta.text()) as Record<string, unknown>; const modules = [...form.keys()].filter((k) => k !== "metadata");
        if (!modules.includes(String(metadata.main_module))) return err(400, 10021, `main_module ${metadata.main_module} is not among the uploaded modules`);
        if (metadata.assets && (metadata.assets as { jwt?: string }).jwt !== COMPLETION_JWT) return err(400, 10022, "assets: invalid completion token");
        const tag = (metadata.migrations as { tag: string }[] | undefined)?.at(-1)?.tag ?? s?.migrationTag ?? null;
        if (s && metadata.migrations && s.migrationTag === tag) return err(400, 10023, `migration tag ${tag} already applied`);
        const now = new Date().toISOString();
        scripts.set(name, { metadata, modules, schedules: s?.schedules ?? [], subdomain: s?.subdomain ?? false, assets: metadata.assets ? [...uploadedHashes] : (s?.assets ?? []), migrationTag: tag, created_on: s?.created_on ?? now, modified_on: now });
        return ok({ id: name, migration_tag: tag });
      }
      if (!sub && req.method === "DELETE") { if (!s) return err(404, 10007, "workers.api.error.script_not_found"); scripts.delete(name); return ok(null); }
      if (!sub && req.method === "GET") return s ? new Response("// script body", { headers: { "content-type": "application/javascript" } }) : err(404, 10007, "script not found");
      if (sub === "settings" && req.method === "GET") return s ? ok({ migration_tag: s.migrationTag, bindings: s.metadata.bindings, tags: s.metadata.tags }) : err(404, 10007, "script not found");
      if (sub === "assets-upload-session" && req.method === "POST") { const { manifest } = (await req.json()) as { manifest: Record<string, { hash: string; size: number }> }; const hashes = Object.values(manifest).map((e) => e.hash); const missing = hashes.filter((h) => !uploadedHashes.has(h)); if (!missing.length) return ok({ jwt: COMPLETION_JWT, buckets: [] }); pendingSessions.set(name, new Set(missing)); const buckets: string[][] = []; for (let i = 0; i < missing.length; i += 3) buckets.push(missing.slice(i, i + 3)); return ok({ jwt: UPLOAD_JWT, buckets }); }
      if (sub === "schedules" && req.method === "PUT") { if (!s) return err(404, 10007, "script not found"); s.schedules = ((await req.json()) as { cron: string }[]).map((c) => c.cron); return ok({ schedules: s.schedules.map((cron) => ({ cron })) }); }
      if (sub === "subdomain" && req.method === "POST") { if (!s) return err(404, 10007, "script not found"); const body = (await req.json()) as { enabled: boolean }; s.subdomain = !!body.enabled; return ok({ enabled: s.subdomain }); }
      if (sub === "subdomain" && req.method === "GET") return ok({ enabled: s?.subdomain ?? false }); } }
  return err(404, 7000, `no route for ${req.method} ${p}`);
} });
console.log(`cloudflare api mock on http://127.0.0.1:${port} (token ${TOKEN}, account ${ACCOUNT})`);
