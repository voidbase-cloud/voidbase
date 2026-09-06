// Cloudflare REST control plane for voidbase instances, runnable anywhere fetch exists (a Worker, Bun, Node):
// provision an instance from a prebuilt release (D1 + R2 + queue + Worker script with its assets, cron trigger,
// Durable Object hub and workers.dev subdomain), destroy one, and list them. `voidbase deploy` (src/node/deploy-cf.ts)
// is the local counterpart that builds first; this module never builds, it uploads what `voidbase bundle` produced.
// Every request goes through `CfApi`, so a test can point it at test/cf-mock.ts.
export const CF_API_BASE = "https://api.cloudflare.com/client/v4";
// what a control plane must keep (OAuth tokens) goes to rest sealed with VOIDBASE_ENCRYPTION_KEY
export { sealSecret, openSecret, isSealed } from "../server/crypto";

export interface CfErrorItem { code: number; message: string }
export interface CfResult<T> { success: boolean; errors: CfErrorItem[]; messages: unknown[]; result: T; result_info?: { cursor?: string; is_truncated?: boolean; page?: number; total_pages?: number } }
export class CfError extends Error {
  constructor(public status: number, public errors: CfErrorItem[], public path: string) { super(`Cloudflare API ${path}: ${status} ${errors.map((e) => `${e.code} ${e.message}`).join("; ") || "unknown error"}`); }
  has(code: number) { return this.errors.some((e) => e.code === code); }
}

export class CfApi {
  constructor(public token: string, base: string = CF_API_BASE) { this.base = base.replace(/\/$/, ""); }
  base: string;
  async raw(method: string, path: string, init: { body?: BodyInit | null; headers?: Record<string, string>; token?: string } = {}): Promise<Response> {
    return fetch(`${this.base}${path}`, { method, body: init.body ?? null, headers: { authorization: `Bearer ${init.token ?? this.token}`, ...(init.headers ?? {}) } });
  }
  async json<T>(method: string, path: string, body?: unknown, tolerate: number[] = []): Promise<CfResult<T>> {
    const res = await this.raw(method, path, { body: body === undefined ? null : JSON.stringify(body), headers: body === undefined ? {} : { "content-type": "application/json" } });
    return this.unwrap<T>(res, path, tolerate);
  }
  async form<T>(method: string, path: string, form: FormData, extra: { token?: string } = {}): Promise<CfResult<T>> {
    const res = await this.raw(method, path, { body: form, token: extra.token });
    return this.unwrap<T>(res, path, []);
  }
  private async unwrap<T>(res: Response, path: string, tolerate: number[]): Promise<CfResult<T>> {
    const text = await res.text();
    let parsed: CfResult<T> | null = null;
    try { parsed = JSON.parse(text) as CfResult<T>; } catch { /* not JSON */ }
    if (!parsed) { if (res.ok) return { success: true, errors: [], messages: [], result: undefined as T }; throw new CfError(res.status, [{ code: 0, message: text.slice(0, 300) }], path); }
    if (parsed.success === false && !(parsed.errors ?? []).some((e) => tolerate.includes(e.code))) throw new CfError(res.status, parsed.errors ?? [], path);
    return parsed;
  }
}

// ---- accounts and identity --------------------------------------------------------------------------------
export interface CfAccount { id: string; name: string }
export interface CfUser { id: string; email: string; first_name?: string | null; last_name?: string | null; username?: string | null }
export async function listAccounts(cf: CfApi): Promise<CfAccount[]> {
  const out: CfAccount[] = [];
  for (let page = 1; page < 20; page++) {
    const r = await cf.json<CfAccount[]>("GET", `/accounts?page=${page}&per_page=50`);
    out.push(...(r.result ?? []).map((a) => ({ id: a.id, name: a.name })));
    if (!r.result_info || !r.result_info.total_pages || page >= r.result_info.total_pages) break;
  }
  return out;
}
export const currentUser = async (cf: CfApi): Promise<CfUser> => (await cf.json<CfUser>("GET", "/user")).result;
export async function resolveAccount(cf: CfApi, wanted?: string): Promise<CfAccount> {
  let accounts: CfAccount[];
  try { accounts = await listAccounts(cf); } catch (e) { throw new Error(`cannot list accounts with this token (${e instanceof Error ? e.message : e})`); }
  if (!accounts.length) throw new Error("the token reaches no account");
  if (wanted) { const a = accounts.find((x) => x.id === wanted || x.name === wanted); if (!a) throw new Error(`account ${wanted} is not reachable with this token (${accounts.map((x) => `${x.name} ${x.id}`).join(", ")})`); return a; }
  if (accounts.length > 1) throw new Error(`the token reaches ${accounts.length} accounts, pick one: ${accounts.map((x) => `${x.name} (${x.id})`).join(", ")}`);
  return accounts[0]!;
}

// ---- resources: one D1, one R2 bucket, one queue per instance, all named from the worker name -----------------
export const instanceResources = (name: string) => ({ db: `${name}-db`, bucket: `${name}-storage`, queue: `${name}-jobs`, dataset: `${name.replace(/-/g, "_")}_requests` });
export async function ensureD1(cf: CfApi, account: string, name: string): Promise<{ uuid: string; created: boolean }> {
  const list = await cf.json<{ uuid: string; name: string }[]>("GET", `/accounts/${account}/d1/database?name=${encodeURIComponent(name)}&per_page=100`);
  const hit = (list.result ?? []).find((d) => d.name === name);
  if (hit) return { uuid: hit.uuid, created: false };
  try { const made = await cf.json<{ uuid: string }>("POST", `/accounts/${account}/d1/database`, { name }); return { uuid: made.result.uuid, created: true }; }
  catch (e) { if (e instanceof CfError && e.has(7406)) throw new Error(`creating the D1 database ${name}: the account is at its D1 database limit (${e.errors.map((x) => x.message).join("; ")}). Delete an unused database or upgrade the Workers plan; nothing was created.`); throw e; }
}
export async function findD1(cf: CfApi, account: string, name: string): Promise<{ uuid: string } | null> {
  const list = await cf.json<{ uuid: string; name: string }[]>("GET", `/accounts/${account}/d1/database?name=${encodeURIComponent(name)}&per_page=100`);
  const hit = (list.result ?? []).find((d) => d.name === name); return hit ? { uuid: hit.uuid } : null;
}
export async function ensureR2(cf: CfApi, account: string, name: string): Promise<{ created: boolean }> {
  const head = await cf.raw("GET", `/accounts/${account}/r2/buckets/${encodeURIComponent(name)}`); await head.text();
  if (head.ok) return { created: false };
  await cf.json("POST", `/accounts/${account}/r2/buckets`, { name }, [10004]); return { created: true };
}
export async function findQueue(cf: CfApi, account: string, name: string): Promise<{ id: string } | null> {
  const list = await cf.json<{ queue_id: string; queue_name: string }[]>("GET", `/accounts/${account}/queues?per_page=100`);
  const hit = (list.result ?? []).find((q) => q.queue_name === name); return hit ? { id: hit.queue_id } : null;
}
export async function ensureQueue(cf: CfApi, account: string, name: string): Promise<{ id: string | null; created: boolean; reason?: string }> {
  try {
    const hit = await findQueue(cf, account, name); if (hit) return { id: hit.id, created: false };
    const made = await cf.json<{ queue_id: string }>("POST", `/accounts/${account}/queues`, { queue_name: name });
    return { id: made.result.queue_id, created: true };
  } catch (e) { return { id: null, created: false, reason: e instanceof Error ? e.message : String(e) }; }
}
export async function workersSubdomain(cf: CfApi, account: string): Promise<string | null> {
  try { const r = await cf.json<{ subdomain?: string }>("GET", `/accounts/${account}/workers/subdomain`); return r.result?.subdomain ?? null; } catch { return null; }
}
// Cloudflare shares rate-limit counters between bindings with the same namespace id, even across Workers: derive it per instance
export function rateLimitNamespace(name: string): string { let h = 2166136261; for (const ch of name) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; } return String(1000 + (h % 900000)); }

// ---- releases: what `voidbase bundle` produces -------------------------------------------------------------
export interface ReleaseModule { path: string; type: "esm" | "wasm" | "text" | "data"; size: number }
export interface ReleaseAsset { path: string; size: number; hash: string; contentType: string }
export interface ReleaseManifest {
  version: string; voidbase: string; builtAt: string;
  compatibilityDate: string; compatibilityFlags: string[]; mainModule: string;
  modules: ReleaseModule[]; assets: ReleaseAsset[]; migrations: { name: string; size: number }[];
  crons: string[]; durableObjects: { binding: string; className: string; tag: string }[];
  queueBinding: string | null; assetsConfig: Record<string, unknown>;
}
/** bytes of one release file: "worker/<module path>", "assets/<asset path>", "migrations/<file>" */
export interface ReleaseSource { manifest: ReleaseManifest; read(path: string): Promise<Uint8Array> }

export function toBase64(bytes: Uint8Array): string { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }
export async function assetHash(bytes: Uint8Array): Promise<string> { const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)); return [...d].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32); }
export function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return ({ html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", txt: "text/plain; charset=utf-8", map: "application/json", wasm: "application/wasm", xml: "application/xml", webmanifest: "application/manifest+json" } as Record<string, string>)[ext] ?? "application/octet-stream";
}
const moduleMime = (t: ReleaseModule["type"]) => ({ esm: "application/javascript+module", wasm: "application/wasm", text: "text/plain", data: "application/octet-stream" })[t];

// ---- provisioning ----------------------------------------------------------------------------------------
export interface ProvisionOptions {
  account: string; name: string; release: ReleaseSource;
  superuser: { email: string; password: string };
  /** plain-text worker vars and secrets (VOIDBASE_* knobs, the hooks' AUDITLOG, ...) */
  vars?: Record<string, string>; secrets?: Record<string, string>;
  queue?: boolean; hub?: boolean; cron?: boolean; rateLimit?: { limit: number; period: 10 | 60 } | null; smartPlacement?: boolean;
  /** send the Durable Object migrations: true on the first upload, false when the deployed script already has the tag */
  applyDoMigrations?: boolean;
  tags?: string[]; log?: (line: string) => void;
}
export interface ProvisionResult { name: string; account: string; url: string | null; d1: { uuid: string; created: boolean }; queue: { id: string; created: boolean } | null; bucket: { created: boolean }; release: string; assets: number; modules: number; migrationsApplied: string[] }

export async function provisionInstance(cf: CfApi, o: ProvisionOptions): Promise<ProvisionResult> {
  const log = o.log ?? (() => undefined); const m = o.release.manifest; const res = instanceResources(o.name);
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(o.name)) throw new Error(`invalid worker name "${o.name}": lowercase letters, digits and dashes, 1-63 chars`);
  const d1 = await ensureD1(cf, o.account, res.db); log(`D1 ${res.db} ${d1.created ? "created" : "exists"} (${d1.uuid})`);
  const bucket = await ensureR2(cf, o.account, res.bucket); log(`R2 ${res.bucket} ${bucket.created ? "created" : "exists"}`);
  let queue: ProvisionResult["queue"] = null;
  if (o.queue !== false && m.queueBinding) {
    const q = await ensureQueue(cf, o.account, res.queue);
    if (q.id) { queue = { id: q.id, created: q.created }; log(`Queue ${res.queue} ${q.created ? "created" : "exists"}`); }
    else log(`Queue ${res.queue} not created (${q.reason}); mail and backups run inline`);
  }
  const migrationsApplied = await applyD1Migrations(cf, o.account, d1.uuid, o.release, log);

  // static assets (the admin panel and the 404 shells): manifest, then the buckets the API asks for, then the completion token
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const a of m.assets) manifest[`/${a.path}`] = { hash: a.hash, size: a.size };
  let assetsJwt: string | null = null;
  if (m.assets.length) {
    const session = await cf.json<{ jwt: string; buckets: string[][] }>("POST", `/accounts/${o.account}/workers/scripts/${o.name}/assets-upload-session`, { manifest });
    assetsJwt = session.result.jwt;
    const byHash = new Map(m.assets.map((a) => [a.hash, a] as const));
    let uploaded = 0;
    for (const bucketHashes of session.result.buckets ?? []) {
      const form = new FormData();
      for (const h of bucketHashes) { const a = byHash.get(h); if (!a) throw new Error(`asset upload: unknown hash ${h}`); const bytes = await o.release.read(`assets/${a.path}`); form.append(h, new Blob([toBase64(bytes)], { type: a.contentType }), h); uploaded++; }
      const r = await cf.form<{ jwt?: string }>("POST", `/accounts/${o.account}/workers/assets/upload?base64=true`, form, { token: session.result.jwt });
      if (r.result?.jwt) assetsJwt = r.result.jwt;
    }
    log(`assets: ${m.assets.length} files, ${uploaded} uploaded`);
  }

  // the Worker itself: metadata part + every module of the release
  const bindings: Record<string, unknown>[] = [
    { type: "d1", name: "DB", id: d1.uuid },
    { type: "r2_bucket", name: "STORAGE", bucket_name: res.bucket },
    { type: "assets", name: "ASSETS" },
  ];
  if (queue && m.queueBinding) bindings.push({ type: "queue", name: m.queueBinding, queue_name: res.queue });
  if (o.hub !== false) for (const d of m.durableObjects) bindings.push({ type: "durable_object_namespace", name: d.binding, class_name: d.className });
  if (o.rateLimit) bindings.push({ type: "ratelimit", name: "RATE_LIMITER", namespace_id: rateLimitNamespace(o.name), simple: { limit: o.rateLimit.limit, period: o.rateLimit.period } });
  for (const [k, v] of Object.entries(o.vars ?? {})) bindings.push({ type: "plain_text", name: k, text: v });
  const secrets = { VOIDBASE_SUPERUSER_EMAIL: o.superuser.email, VOIDBASE_SUPERUSER_PASSWORD: o.superuser.password, ...(o.secrets ?? {}) };
  for (const [k, v] of Object.entries(secrets)) bindings.push({ type: "secret_text", name: k, text: v });
  const metadata: Record<string, unknown> = {
    main_module: m.mainModule, compatibility_date: m.compatibilityDate, compatibility_flags: m.compatibilityFlags, bindings,
    ...(o.smartPlacement === false ? {} : { placement: { mode: "smart" } }),
    ...(assetsJwt ? { assets: { jwt: assetsJwt, config: m.assetsConfig } } : {}),
    ...(o.hub !== false && o.applyDoMigrations !== false && m.durableObjects.length ? { migrations: m.durableObjects.map((d) => ({ tag: d.tag, new_sqlite_classes: [d.className] })) } : {}),
    tags: ["voidbase", `voidbase-release:${m.version}`, ...(o.tags ?? [])],
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  for (const mod of m.modules) form.append(mod.path, new Blob([await o.release.read(`worker/${mod.path}`) as BlobPart], { type: moduleMime(mod.type) }), mod.path);
  await cf.form("PUT", `/accounts/${o.account}/workers/scripts/${o.name}`, form);
  log(`worker ${o.name} uploaded (${m.modules.length} modules, release ${m.version})`);

  if (queue) {
    const consumers = await cf.json<{ script?: string; script_name?: string }[]>("GET", `/accounts/${o.account}/queues/${queue.id}/consumers`);
    if (!(consumers.result ?? []).some((c) => (c.script ?? c.script_name) === o.name)) await cf.json("POST", `/accounts/${o.account}/queues/${queue.id}/consumers`, { type: "worker", script_name: o.name, settings: { batch_size: 10, max_retries: 5, max_wait_time_ms: 1000, retry_delay: 30 } });
  }
  if (m.crons.length && o.cron !== false) {
    // Workers Free allows 5 cron triggers per account (code 10072): the instance still works, maintenance runs lazily in requests
    try { await cf.json("PUT", `/accounts/${o.account}/workers/scripts/${o.name}/schedules`, m.crons.map((cron) => ({ cron }))); }
    catch (e) { if (e instanceof CfError && e.has(10072)) log(`cron trigger skipped: ${e.errors[0]?.message ?? "account cron limit"}`); else throw e; }
  }
  await cf.json("POST", `/accounts/${o.account}/workers/scripts/${o.name}/subdomain`, { enabled: true, previews_enabled: false });
  const sub = await workersSubdomain(cf, o.account);
  const url = sub ? `https://${o.name}.${sub}.workers.dev` : null;
  log(`live: ${url ?? "(workers.dev subdomain not enabled on the account)"}`);
  return { name: o.name, account: o.account, url, d1, queue, bucket, release: m.version, assets: m.assets.length, modules: m.modules.length, migrationsApplied };
}

// D1 migrations through the REST /query endpoint, tracked in wrangler's d1_migrations table so a later local
// `voidbase deploy` (wrangler d1 migrations apply) sees them as applied
export async function applyD1Migrations(cf: CfApi, account: string, uuid: string, release: ReleaseSource, log: (l: string) => void = () => undefined): Promise<string[]> {
  const q = (sql: string, params: unknown[] = []) => cf.json<{ results: Record<string, unknown>[] }[]>("POST", `/accounts/${account}/d1/database/${uuid}/query`, { sql, params });
  await q("CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const done = new Set(((await q("SELECT name FROM d1_migrations")).result?.[0]?.results ?? []).map((r) => String(r.name)));
  const applied: string[] = [];
  for (const mig of [...release.manifest.migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (done.has(mig.name)) continue;
    const sql = new TextDecoder().decode(await release.read(`migrations/${mig.name}`));
    for (const stmt of sql.split(/-->\s*statement-breakpoint/).map((s) => s.trim()).filter(Boolean)) await q(stmt);
    await q("INSERT INTO d1_migrations (name) VALUES (?)", [mig.name]);
    applied.push(mig.name);
  }
  log(`D1 migrations: ${applied.length} applied, ${done.size} already there`);
  return applied;
}

// ---- custom domains (Workers Custom Domains: Cloudflare adds the DNS record and certificate; Workers Scripts Write suffices) ----
export interface CustomDomain { id: string; hostname: string; service: string; zone_id: string; zone_name?: string; environment?: string }
/** the zone of a hostname on the account: api.example.com -> example.com (walks the labels up) */
export async function findZone(cf: CfApi, hostname: string, account?: string): Promise<{ id: string; name: string } | null> {
  const labels = hostname.toLowerCase().split(".").filter(Boolean);
  for (let i = 0; i < labels.length - 1; i++) {
    const name = labels.slice(i).join(".");
    const r = await cf.json<{ id: string; name: string }[]>("GET", `/zones?name=${encodeURIComponent(name)}${account ? `&account.id=${account}` : ""}`);
    const z = (r.result ?? []).find((x) => x.name === name);
    if (z) return { id: z.id, name: z.name };
  }
  return null;
}
export async function listCustomDomains(cf: CfApi, account: string, filter: { service?: string; hostname?: string } = {}): Promise<CustomDomain[]> {
  const q = new URLSearchParams(); if (filter.service) q.set("service", filter.service); if (filter.hostname) q.set("hostname", filter.hostname);
  const r = await cf.json<CustomDomain[]>("GET", `/accounts/${account}/workers/domains${q.size ? `?${q}` : ""}`);
  return (r.result ?? []).filter((d) => (!filter.service || d.service === filter.service) && (!filter.hostname || d.hostname === filter.hostname));
}
export async function attachCustomDomain(cf: CfApi, account: string, o: { hostname: string; service: string; environment?: string; zoneId?: string }): Promise<CustomDomain & { created: boolean }> {
  const hostname = o.hostname.toLowerCase();
  const hit = (await listCustomDomains(cf, account, { hostname })).find((d) => d.service === o.service);
  if (hit) return { ...hit, created: false };
  const zone = o.zoneId ? { id: o.zoneId } : await findZone(cf, hostname, account);
  if (!zone) throw new Error(`no zone on account ${account} covers ${hostname}: add the domain to Cloudflare first`);
  const r = await cf.json<CustomDomain>("PUT", `/accounts/${account}/workers/domains`, { hostname, service: o.service, environment: o.environment ?? "production", zone_id: zone.id });
  return { ...r.result, created: true };
}
export async function detachCustomDomains(cf: CfApi, account: string, service: string): Promise<string[]> {
  const gone: string[] = [];
  for (const d of await listCustomDomains(cf, account, { service })) { await cf.json("DELETE", `/accounts/${account}/workers/domains/${d.id}`); gone.push(d.hostname); }
  return gone;
}

// ---- teardown ---------------------------------------------------------------------------------------------
export interface DestroyResult { name: string; deleted: string[]; skipped: string[]; errors: string[] }
export async function destroyInstance(cf: CfApi, o: { account: string; name: string; log?: (l: string) => void }): Promise<DestroyResult> {
  const log = o.log ?? (() => undefined); const res = instanceResources(o.name); const out: DestroyResult = { name: o.name, deleted: [], skipped: [], errors: [] };
  const attempt = async (label: string, fn: () => Promise<boolean>) => { try { (await fn()) ? out.deleted.push(label) : out.skipped.push(label); log(`${label}: ${out.deleted.includes(label) ? "deleted" : "not found"}`); } catch (e) { out.errors.push(`${label}: ${e instanceof Error ? e.message : e}`); log(`${label}: ${e instanceof Error ? e.message : e}`); } };
  await attempt(`custom domains of ${o.name}`, async () => (await detachCustomDomains(cf, o.account, o.name)).length > 0);
  // Cloudflare refuses to delete a Worker that consumes a queue (10064) and a queue a Worker still binds (11005):
  // the consumer goes first, then the script (so nothing keeps serving with bindings about to vanish), then the queue
  await attempt(`queue consumer of ${o.name}`, async () => {
    const q = await findQueue(cf, o.account, res.queue); if (!q) return false;
    const consumers = await cf.json<{ consumer_id?: string; id?: string; script?: string; script_name?: string }[]>("GET", `/accounts/${o.account}/queues/${q.id}/consumers`);
    let removed = false;
    for (const c of consumers.result ?? []) { if ((c.script ?? c.script_name) !== o.name) continue; await cf.json("DELETE", `/accounts/${o.account}/queues/${q.id}/consumers/${c.consumer_id ?? c.id}`); removed = true; }
    return removed;
  });
  await attempt(`worker ${o.name}`, async () => { const r = await cf.raw("DELETE", `/accounts/${o.account}/workers/scripts/${o.name}?force=true`); const body = await r.text(); if (r.status === 404) return false; if (!r.ok) throw new Error(`HTTP ${r.status} ${body.slice(0, 200)}`); return true; });
  await attempt(`queue ${res.queue}`, async () => { const q = await findQueue(cf, o.account, res.queue); if (!q) return false; await cf.json("DELETE", `/accounts/${o.account}/queues/${q.id}`); return true; });
  await attempt(`D1 ${res.db}`, async () => { const d = await findD1(cf, o.account, res.db); if (!d) return false; await cf.json("DELETE", `/accounts/${o.account}/d1/database/${d.uuid}`); return true; });
  await attempt(`R2 ${res.bucket}`, async () => {
    const head = await cf.raw("GET", `/accounts/${o.account}/r2/buckets/${encodeURIComponent(res.bucket)}`); await head.text(); if (head.status === 404) return false;
    for (let cursor: string | undefined; ;) { // a bucket must be empty before it can go
      const page = await cf.json<{ key: string }[]>("GET", `/accounts/${o.account}/r2/buckets/${encodeURIComponent(res.bucket)}/objects?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const obj of page.result ?? []) { const r = await cf.raw("DELETE", `/accounts/${o.account}/r2/buckets/${encodeURIComponent(res.bucket)}/objects/${encodeURIComponent(obj.key)}`); await r.text(); }
      if (!page.result_info?.is_truncated || !page.result_info.cursor) break; cursor = page.result_info.cursor;
    }
    await cf.json("DELETE", `/accounts/${o.account}/r2/buckets/${encodeURIComponent(res.bucket)}`); return true;
  });
  return out;
}

// ---- inspection --------------------------------------------------------------------------------------------
export interface WorkerInfo { name: string; tags: string[]; created_on?: string; modified_on?: string; release: string | null }
export async function listVoidbaseWorkers(cf: CfApi, account: string): Promise<WorkerInfo[]> {
  const r = await cf.json<{ id: string; tags?: string[]; created_on?: string; modified_on?: string }[]>("GET", `/accounts/${account}/workers/scripts`);
  return (r.result ?? []).filter((s) => (s.tags ?? []).includes("voidbase")).map((s) => ({ name: s.id, tags: s.tags ?? [], created_on: s.created_on, modified_on: s.modified_on, release: (s.tags ?? []).find((t) => t.startsWith("voidbase-release:"))?.slice("voidbase-release:".length) ?? null }));
}
export async function workerExists(cf: CfApi, account: string, name: string): Promise<boolean> {
  const r = await cf.raw("GET", `/accounts/${account}/workers/scripts/${name}/settings`); await r.text();
  if (r.status === 404) return false; if (!r.ok) throw new Error(`Cloudflare API workers/scripts/${name}/settings: HTTP ${r.status}`); return true;
}

// ---- OAuth token refresh (Cloudflare OAuth clients get refresh tokens with the offline_access scope) -----------
export interface OAuthTokens { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string; scope?: string }
export async function refreshOAuthToken(o: { tokenURL: string; clientId: string; clientSecret?: string; refreshToken: string }): Promise<OAuthTokens> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: o.refreshToken, client_id: o.clientId });
  if (o.clientSecret) body.set("client_secret", o.clientSecret);
  const res = await fetch(o.tokenURL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`token refresh failed (${res.status}): ${text.slice(0, 200)}`);
  return JSON.parse(text) as OAuthTokens;
}
