// In-memory Cloudflare REST API for tests: the endpoints `voidbase deploy` (D1/R2/queue provisioning) and
// `voidbase/cloud` (script upload with assets, schedules, subdomain, D1 query, teardown) use, with a fixed bearer token.
//   bun test/cf-mock.ts [port=5197]      token: cf-test-token   account: acc123
// A second token, cf-test-token-noqueues, is accepted everywhere except the Queues endpoints (a token without Queues edit);
// cf-test-user-token is the user token the Workers Builds endpoints (/builds/*) demand.
// GET /__state dumps everything, DELETE /__calls resets it, GET /__calls lists the requests made.
const port = Number(process.argv[2] ?? 5197); const TOKEN = "cf-test-token"; const TOKEN_NOQUEUES = "cf-test-token-noqueues"; const ACCOUNT = "acc123";
// The Workers Builds endpoints accept only the user token (the real API rejects account-owned tokens); GitHub's repository and
// release endpoints (scripts/cf-builds.ts setup, scripts/gh-release.ts) are served too, unauthenticated, under /repos.
const USER_TOKEN = "cf-test-user-token"; const GH_REPO = { id: 1359087906, name: "voidbase", owner: { id: 325612581, login: "voidbase-cloud" }, default_branch: "master" };
const UPLOAD_JWT = "upload-jwt", COMPLETION_JWT = "completion-jwt";
interface Script { tag: string; metadata: Record<string, unknown>; modules: string[]; schedules: string[]; subdomain: boolean; assets: string[]; migrationTag: string | null; created_on: string; modified_on: string; secrets?: string[] }
interface Trigger { trigger_uuid: string; external_script_id: string; repo_connection_uuid: string; build_token_uuid: string; trigger_name: string; [k: string]: unknown }
interface Build { build_uuid: string; status: string; build_outcome?: string; created_on: string; trigger: { trigger_uuid: string; external_script_id: string }; build_trigger_metadata: { branch?: string; commit_hash?: string }; build_trigger_source: string }
interface GhRelease { id: number; tag_name: string; html_url: string; body: string; upload_url: string; assets: { id: number; name: string; size: number }[] }
const d1 = new Map<string, string>(); const d1Migrations = new Map<string, string[]>(); const d1Queries = new Map<string, string[]>();
const r2 = new Map<string, Set<string>>(); const queues = new Map<string, string>(); const consumers = new Map<string, Record<string, unknown>[]>();
const scripts = new Map<string, Script>();
const connections = new Map<string, Record<string, unknown>>(); const triggers = new Map<string, Trigger>(); const builds = new Map<string, Build>(); const buildEnv = new Map<string, Record<string, { value: string; is_secret: boolean }>>();
const ghReleases = new Map<string, GhRelease>(); let ghIds = 100;
const seedGh = () => { ghReleases.clear(); ghReleases.set("v9.9.9", { id: 9, tag_name: "v9.9.9", html_url: "https://github.com/voidbase-cloud/voidbase/releases/tag/v9.9.9", body: "### Features\n\n* something new\n", upload_url: `http://127.0.0.1:${port}/__uploads/repos/voidbase-cloud/voidbase/releases/9/assets{?name,label}`, assets: [] }); };
seedGh(); const zones = [{ id: "zone123", name: "example.com" }]; const domains = new Map<string, { id: string; hostname: string; service: string; zone_id: string; environment: string }>(); const uploadedHashes = new Set<string>(); const pendingSessions = new Map<string, Set<string>>(); const calls: string[] = [];
const ok = (result: unknown, extra: Record<string, unknown> = {}, status = 200) => Response.json({ success: true, errors: [], messages: [], result, ...extra }, { status });
const err = (status: number, code: number, message: string) => Response.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
const reset = () => { calls.length = 0; connections.clear(); triggers.clear(); builds.clear(); buildEnv.clear(); seedGh(); domains.clear(); d1.clear(); d1Migrations.clear(); d1Queries.clear(); r2.clear(); queues.clear(); consumers.clear(); scripts.clear(); uploadedHashes.clear(); pendingSessions.clear(); };
const storeSecrets = new Map<string, { id: string; name: string; value: string; scopes: string[] }[]>();
const state = () => ({ storeSecrets: Object.fromEntries([...storeSecrets].map(([k, v]) => [k, v.map(({ id, name, scopes }) => ({ id, name, scopes }))])), connections: [...connections.values()], triggers: [...triggers.values()], builds: [...builds.values()], buildEnv: Object.fromEntries(buildEnv), ghReleases: [...ghReleases.values()], domains: [...domains.values()], d1: [...d1.entries()], d1Migrations: Object.fromEntries(d1Migrations), d1Queries: Object.fromEntries(d1Queries), r2: Object.fromEntries([...r2.entries()].map(([k, v]) => [k, [...v]])), queues: [...queues.entries()], consumers: Object.fromEntries(consumers), scripts: Object.fromEntries(scripts), uploadedHashes: [...uploadedHashes] });
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
  // ---- GitHub (unauthenticated in the mock): the repository, releases and asset uploads
  if (p === `/repos/${GH_REPO.owner.login}/${GH_REPO.name}`) return Response.json(GH_REPO);
  { const m = p.match(/^\/repos\/[^/]+\/[^/]+\/releases\/tags\/([^/]+)$/); if (m) { const r = ghReleases.get(decodeURIComponent(m[1]!)); return r ? Response.json(r) : Response.json({ message: "Not Found" }, { status: 404 }); } }
  { const m = p.match(/^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)$/); if (m && req.method === "PATCH") { const r = [...ghReleases.values()].find((x) => x.id === Number(m[1])); if (!r) return Response.json({ message: "Not Found" }, { status: 404 }); const b = (await req.json()) as { body?: string }; if (typeof b.body === "string") r.body = b.body; return Response.json(r); } }
  { const m = p.match(/^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/); if (m && req.method === "DELETE") { for (const r of ghReleases.values()) { const i = r.assets.findIndex((a) => a.id === Number(m[1])); if (i >= 0) { r.assets.splice(i, 1); return new Response(null, { status: 204 }); } } return Response.json({ message: "Not Found" }, { status: 404 }); } }
  { const m = p.match(/^\/__uploads\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets$/); if (m && req.method === "POST") { const r = [...ghReleases.values()].find((x) => x.id === Number(m[1])); const name = url.searchParams.get("name") ?? ""; if (!r || !name) return Response.json({ message: "bad upload" }, { status: 422 }); if (r.assets.some((a) => a.name === name)) return Response.json({ message: "Validation Failed: already_exists" }, { status: 422 }); const size = (await req.arrayBuffer()).byteLength; const asset = { id: ++ghIds, name, size }; r.assets.push(asset); return Response.json(asset, { status: 201 }); } }
  if (bearer !== `Bearer ${TOKEN}` && bearer !== `Bearer ${TOKEN_NOQUEUES}` && bearer !== `Bearer ${USER_TOKEN}`) return err(400, 10000, "Authentication error");
  // ---- workers builds (user token only)
  if (p.startsWith(`${A}/builds/`)) {
    if (bearer !== `Bearer ${USER_TOKEN}`) return err(401, 10000, "Authentication error");
    if (p === `${A}/builds/repos/connections` && req.method === "PUT") { const b = (await req.json()) as Record<string, unknown>; const existing = [...connections.values()].find((c) => c.provider_type === b.provider_type && c.repo_id === b.repo_id); if (existing) return ok(existing); const c = { repo_connection_uuid: crypto.randomUUID(), ...b }; connections.set(c.repo_connection_uuid, c); return ok(c); }
    if (p === `${A}/builds/tokens` && req.method === "GET") return ok([{ build_token_uuid: "bt-1", build_token_name: "Workers Builds - Test Account" }]);
    const byTag = (tag: string) => [...scripts.values()].some((s) => s.tag === tag);
    if (p === `${A}/builds/triggers` && req.method === "POST") { const b = (await req.json()) as Partial<Trigger>; if ([...triggers.values()].filter((t) => t.external_script_id === b.external_script_id).length >= 2) return err(400, 12030, "Number of triggers created exceeds limit"); if (!b.external_script_id || !byTag(b.external_script_id)) return err(404, 10000, "worker not found for external_script_id"); if (!b.repo_connection_uuid || !connections.has(b.repo_connection_uuid)) return err(400, 10000, "unknown repo_connection_uuid"); if (b.build_token_uuid !== "bt-1") return err(400, 10000, "unknown build_token_uuid"); const t = { ...b, trigger_uuid: crypto.randomUUID() } as Trigger; triggers.set(t.trigger_uuid, t); return ok(t); }
    { const m = p.match(new RegExp(`^${A}/builds/workers/([^/]+)/(triggers|builds)$`)); if (m && req.method === "GET") { const list = [...triggers.values()].filter((t) => t.external_script_id === m[1]); if (m[2] === "triggers") return ok(list); const uuids = new Set(list.map((t) => t.trigger_uuid)); return ok([...builds.values()].filter((b) => uuids.has(b.trigger.trigger_uuid)).reverse()); } }
    { const m = p.match(new RegExp(`^${A}/builds/triggers/([^/]+)(?:/(builds|environment_variables|purge_build_cache))?$`)); if (m) { const t = triggers.get(m[1]!); if (!t) return err(404, 10000, "trigger not found");
        if (!m[2] && req.method === "PATCH") { Object.assign(t, (await req.json()) as Record<string, unknown>); return ok(t); }
        if (!m[2] && req.method === "DELETE") { triggers.delete(t.trigger_uuid); buildEnv.delete(t.trigger_uuid); return ok(null); }
        if (m[2] === "builds" && req.method === "POST") { const b = (await req.json()) as { branch?: string; commit_hash?: string }; if (!b.branch && !b.commit_hash) return err(400, 10000, "branch or commit_hash required"); const pending = [...builds.values()].find((x) => x.trigger.trigger_uuid === t.trigger_uuid && x.status === "queued"); if (pending) return ok({ build_uuid: pending.build_uuid, status: pending.status, created_on: pending.created_on, already_exists: true }); const build: Build = { build_uuid: crypto.randomUUID(), status: "queued", created_on: new Date().toISOString(), trigger: { trigger_uuid: t.trigger_uuid, external_script_id: t.external_script_id }, build_trigger_metadata: { branch: b.branch ?? "master", commit_hash: b.commit_hash ?? "deadbeef".repeat(5) }, build_trigger_source: "api" }; builds.set(build.build_uuid, build); return ok({ build_uuid: build.build_uuid, status: build.status, branch: b.branch, worker: [...scripts.entries()].find(([, s]) => s.tag === t.external_script_id)?.[0] }); }
        if (m[2] === "environment_variables" && req.method === "GET") return ok(buildEnv.get(t.trigger_uuid) ?? {});
        if (m[2] === "environment_variables" && req.method === "PATCH") { const cur = buildEnv.get(t.trigger_uuid) ?? {}; Object.assign(cur, (await req.json()) as Record<string, { value: string; is_secret: boolean }>); buildEnv.set(t.trigger_uuid, cur); return ok(cur); }
        if (m[2] === "purge_build_cache" && req.method === "POST") return ok(null); } }
    { const m = p.match(new RegExp(`^${A}/builds/builds/([^/]+)(?:/(logs|cancel))?$`)); if (m) { const b = builds.get(m[1]!); if (!b) return err(404, 10000, "build not found");
        if (m[2] === "logs" && req.method === "GET") { if (b.status === "queued") b.status = "running"; else if (b.status === "running") { b.status = "stopped"; b.build_outcome = "success"; } const lines = [[Date.parse(b.created_on), `Initializing build environment (${b.build_trigger_metadata.branch} ${b.build_trigger_metadata.commit_hash})`], [Date.parse(b.created_on), "Executing user build command: bun run ci"], ...(b.status === "stopped" ? [[Date.now(), "Build completed"]] : [])]; return ok({ lines, truncated: false, cursor: "c1", events: [] }); }
        if (m[2] === "cancel" && req.method === "PUT") { b.status = "stopped"; b.build_outcome = "cancelled"; return ok(b); }
        if (!m[2] && req.method === "GET") return ok(b); } }
    return err(404, 7000, `no builds route for ${req.method} ${p}`);
  }
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
    const mc = p.match(new RegExp(`^${A}/queues/([^/]+)/consumers/([^/]+)$`));
    if (mc && req.method === "DELETE") { const list = consumers.get(mc[1]!) ?? []; const i = list.findIndex((c) => c.consumer_id === mc[2]); if (i < 0) return err(404, 11000, "consumer not found"); list.splice(i, 1); return ok(null); }
    if (p === `${A}/queues` && req.method === "GET") return ok([...queues.entries()].map(([queue_name, queue_id]) => ({ queue_name, queue_id })));
    if (p === `${A}/queues` && req.method === "POST") { const { queue_name } = (await req.json()) as { queue_name: string }; if (queues.has(queue_name)) return err(400, 11009, "queue already exists"); const id = crypto.randomUUID().replace(/-/g, ""); queues.set(queue_name, id); return ok({ queue_name, queue_id: id }); }
    if (m && !m[2] && req.method === "DELETE") { const name = [...queues.entries()].find(([, id]) => id === m[1])?.[0]; if (!name) return err(404, 11000, "queue not found"); if ((consumers.get(m[1]!) ?? []).length) return err(400, 11005, `Cannot delete queue '${name}' that is still referenced by a binding in a Worker`); queues.delete(name); consumers.delete(m[1]!); return ok(null); }
    if (m && m[2] && req.method === "GET") return ok(consumers.get(m[1]!) ?? []);
    if (m && m[2] && req.method === "POST") { const body = (await req.json()) as Record<string, unknown>; const list = consumers.get(m[1]!) ?? []; if (list.some((c) => c.script_name === body.script_name)) return err(400, 11010, "consumer already exists"); const row = { consumer_id: crypto.randomUUID().replace(/-/g, ""), ...body }; list.push(row); consumers.set(m[1]!, list); return ok(row); }
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
  if (p === `${A}/workers/scripts` && req.method === "GET") return ok([...scripts.entries()].map(([id, s]) => ({ id, tag: s.tag, tags: (s.metadata.tags as string[]) ?? [], created_on: s.created_on, modified_on: s.modified_on })));
  // the account's Secrets Store: names, values kept only to be replaced, never returned
  { const m = p.match(new RegExp(`^${A}/secrets_store/stores/([^/]+)/secrets(?:/([^/]+))?$`));
    if (m) { const list = storeSecrets.get(m[1]!) ?? (storeSecrets.set(m[1]!, []), storeSecrets.get(m[1]!)!); const id = m[2];
      if (!id && req.method === "GET") return ok(list.map(({ id, name, scopes }) => ({ id, name, scopes, store_id: m[1] })));
      if (!id && req.method === "POST") { const items = (await req.json()) as { name: string; value: string; scopes?: string[] }[]; const made = []; for (const it of items) { if (!it.name || / /.test(it.name)) return err(400, 10021, "a secret name cannot contain spaces"); if (list.some((x) => x.name === it.name)) return err(409, 10039, `secret ${it.name} already exists`); const row = { id: crypto.randomUUID().replace(/-/g, ""), name: it.name, value: it.value, scopes: it.scopes ?? [] }; list.push(row); made.push({ id: row.id, name: row.name, scopes: row.scopes }); } return ok(made); }
      if (id && req.method === "PATCH") { const row = list.find((x) => x.id === id); if (!row) return err(404, 10040, "secret not found"); const b = (await req.json()) as { value?: string; scopes?: string[] }; if (typeof b.value === "string") row.value = b.value; if (b.scopes) row.scopes = b.scopes; return ok({ id: row.id, name: row.name, scopes: row.scopes }); }
      if (id && req.method === "DELETE") { const i = list.findIndex((x) => x.id === id); if (i < 0) return err(404, 10040, "secret not found"); list.splice(i, 1); return ok(null); }
    } }
  { const m = p.match(new RegExp(`^${A}/workers/scripts/([^/]+)/secrets/([^/]+)$`));
    if (m && req.method === "DELETE") { const s = scripts.get(m[1]!); if (!s) return err(404, 10007, "workers.api.error.script_not_found"); s.secrets = (s.secrets ?? []).filter((n) => n !== decodeURIComponent(m[2]!)); return ok(null); } }
  { const m = p.match(new RegExp(`^${A}/workers/scripts/([^/]+)(?:/(settings|assets-upload-session|schedules|subdomain|secrets))?$`));
    if (m) { const name = m[1]!; const sub = m[2]; const s = scripts.get(name);
      if (!sub && req.method === "PUT") {
        const form = await req.formData(); const meta = form.get("metadata"); if (!meta || typeof meta === "string") return err(400, 10021, "metadata part missing");
        const metadata = JSON.parse(await meta.text()) as Record<string, unknown>; const modules = [...form.keys()].filter((k) => k !== "metadata");
        if (!modules.includes(String(metadata.main_module))) return err(400, 10021, `main_module ${metadata.main_module} is not among the uploaded modules`);
        if (metadata.assets && (metadata.assets as { jwt?: string }).jwt !== COMPLETION_JWT) return err(400, 10022, "assets: invalid completion token");
        // Cloudflare takes one migration object (or steps), never an array: what it answered voidbase.cloud with, verbatim
        if (Array.isArray(metadata.migrations)) return err(400, 10021, "json: cannot unmarshal array into Go struct field Metadata.migrations of type reader.ActorMigrations");
        const mig = metadata.migrations as { new_tag?: string; tag?: string; new_sqlite_classes?: string[] } | undefined;
        if (mig && (!mig.new_tag || !mig.new_sqlite_classes?.length)) return err(400, 10021, "migrations: new_tag and new_sqlite_classes are required");
        const tag = mig?.new_tag ?? s?.migrationTag ?? null;
        if (s && metadata.migrations && s.migrationTag === tag) return err(400, 10023, `migration tag ${tag} already applied`);
        const now = new Date().toISOString();
        scripts.set(name, { tag: s?.tag ?? crypto.randomUUID().replace(/-/g, ""), metadata, modules, schedules: s?.schedules ?? [], subdomain: s?.subdomain ?? false, assets: metadata.assets ? [...uploadedHashes] : (s?.assets ?? []), migrationTag: tag, created_on: s?.created_on ?? now, modified_on: now });
        return ok({ id: name, migration_tag: tag });
      }
      if (!sub && req.method === "DELETE") { if (!s) return err(404, 10007, "workers.api.error.script_not_found"); if ([...consumers.values()].some((l) => l.some((c) => c.script_name === name))) return err(403, 10064, "Cannot delete this Worker as it is a consumer for a Queue. Remove it from the Queue"); scripts.delete(name); return ok(null); }
      if (!sub && req.method === "GET") return s ? new Response("// script body", { headers: { "content-type": "application/javascript" } }) : err(404, 10007, "script not found");
      // the Worker's secrets (what `wrangler secret put` / `voidbase secrets push` call): names only, never values
      if (sub === "secrets" && req.method === "GET") return s ? ok((s.secrets ?? []).map((name) => ({ name, type: "secret_text" }))) : err(404, 10007, "workers.api.error.script_not_found");
      if (sub === "secrets" && req.method === "PUT") { if (!s) return err(404, 10007, "workers.api.error.script_not_found"); const b = (await req.json()) as { name: string; text: string }; if (!b.name || typeof b.text !== "string") return err(400, 10021, "name and text required"); s.secrets = [...new Set([...(s.secrets ?? []), b.name])]; return ok({ name: b.name, type: "secret_text" }); }
      if (sub === "settings" && req.method === "GET") return s ? ok({ migration_tag: s.migrationTag, bindings: s.metadata.bindings, tags: s.metadata.tags }) : err(404, 10007, "script not found");
      if (sub === "assets-upload-session" && req.method === "POST") { const { manifest } = (await req.json()) as { manifest: Record<string, { hash: string; size: number }> }; const hashes = Object.values(manifest).map((e) => e.hash); const missing = hashes.filter((h) => !uploadedHashes.has(h)); if (!missing.length) return ok({ jwt: COMPLETION_JWT, buckets: [] }); pendingSessions.set(name, new Set(missing)); const buckets: string[][] = []; for (let i = 0; i < missing.length; i += 3) buckets.push(missing.slice(i, i + 3)); return ok({ jwt: UPLOAD_JWT, buckets }); }
      if (sub === "schedules" && req.method === "PUT") { if (!s) return err(404, 10007, "script not found"); s.schedules = ((await req.json()) as { cron: string }[]).map((c) => c.cron); return ok({ schedules: s.schedules.map((cron) => ({ cron })) }); }
      if (sub === "subdomain" && req.method === "POST") { if (!s) return err(404, 10007, "script not found"); const body = (await req.json()) as { enabled: boolean }; s.subdomain = !!body.enabled; return ok({ enabled: s.subdomain }); }
      if (sub === "subdomain" && req.method === "GET") return ok({ enabled: s?.subdomain ?? false }); } }
  return err(404, 7000, `no route for ${req.method} ${p}`);
} });
console.log(`cloudflare api mock on http://127.0.0.1:${port} (token ${TOKEN}, account ${ACCOUNT})`);
