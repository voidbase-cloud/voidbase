// `voidbase update --cloudflare` and `voidbase rollback --cloudflare`: an instance on Cloudflare taking a new version of
// voidbase through its own rebuild (voidbase-stories voidbase/updating-core.feature, "Updating an instance on Cloudflare",
// "An update that goes badly"), which lands as a version like any other rebuild, rather than a release uploaded over it.
//
// The CLI holds the account's deploy token, so it does over the REST API what the instance's panel does through its
// bindings: it stages the release in the instance's bucket, applies the release's new D1 migrations, uploads its assets,
// then queues a run in the instance's own D1 and starts its Workflow (src/server/rebuild/cloudflare.ts), and waits for the
// run to land. The instance's Workflow does the rest with its own token.
//
// A release that adds a Durable Object class cannot come this way: a version upload carries no Durable Object migration.
import { applyD1Migrations, CfApi, findD1, instanceResources, type ReleaseManifest, type ReleaseSource, uploadReleaseAssets } from "../cloud/rest";
import { putObject } from "../cloud/worker-versions";
import type { RebuildState } from "../server/rebuilds";
import { cloudflareRebuilds } from "../server/rebuild/cloudflare";
import { readState, RELEASE_PREFIX, releaseModuleKeyIn, stagedReleasePrefix } from "../server/rebuild/run";

/** D1 over the REST query endpoint: the subset the rebuild state reads and writes */
export function d1OverRest(cf: CfApi, account: string, uuid: string): D1Database {
  const query = async (sql: string, params: unknown[]) => {
    const r = await cf.json<{ results?: Record<string, unknown>[]; meta?: Record<string, unknown> }[]>("POST", `/accounts/${account}/d1/database/${uuid}/query`, { sql, params });
    return r.result?.[0] ?? { results: [] };
  };
  const prepare = (sql: string) => {
    let params: unknown[] = [];
    const statement = {
      bind: (...values: unknown[]) => { params = values; return statement; },
      first: async (column?: string) => { const row = (await query(sql, params)).results?.[0] ?? null; return column && row ? row[column] : row; },
      all: async () => ({ results: (await query(sql, params)).results ?? [], success: true, meta: {} }),
      run: async () => ({ results: [], success: true, meta: (await query(sql, params)).meta ?? {} }),
      raw: async () => ((await query(sql, params)).results ?? []).map((row) => Object.values(row)),
    };
    return statement;
  };
  return {
    prepare,
    batch: async (statements: { run(): Promise<unknown> }[]) => { const out = []; for (const s of statements) out.push(await s.run()); return out; },
    exec: async (sql: string) => { await query(sql, []); return { count: 1, duration: 0 }; },
  } as unknown as D1Database;
}

/** the instance's rebuild Workflow, started over the REST API */
export const workflowOverRest = (cf: CfApi, account: string, workflow: string) => ({
  create: async (o: { id?: string; params?: unknown }) => (await cf.json("POST", `/accounts/${account}/workflows/${workflow}/instances`, { instance_id: o.id, params: o.params })).result,
});

const objectPath = (account: string, bucket: string, key: string) => `/accounts/${account}/r2/buckets/${encodeURIComponent(bucket)}/objects/${key.split("/").map(encodeURIComponent).join("/")}`;

export type Readiness = { ok: true; uuid: string; bucket: string } | { ok: false; reason: string };

/** whether this instance rebuilds itself: its database, its rebuild Workflow, and the release it was created from in its bucket */
export async function rebuildReadiness(cf: CfApi, account: string, name: string): Promise<Readiness> {
  const res = instanceResources(name);
  const d1 = await findD1(cf, account, res.db);
  if (!d1) return { ok: false, reason: `${name} has no database called ${res.db}` };
  const workflow = await cf.raw("GET", `/accounts/${account}/workflows/${name}-rebuild`); await workflow.text();
  if (!workflow.ok) return { ok: false, reason: `${name} has no rebuild Workflow (${name}-rebuild)` };
  const release = await cf.raw("GET", objectPath(account, res.bucket, `${RELEASE_PREFIX}manifest.json`)); await release.text();
  if (!release.ok) return { ok: false, reason: `${name} keeps no release to rebuild from in ${res.bucket}` };
  return { ok: true, uuid: d1.uuid, bucket: res.bucket };
}

async function readManifest(cf: CfApi, account: string, bucket: string, prefix: string): Promise<ReleaseManifest> {
  const r = await cf.raw("GET", objectPath(account, bucket, `${prefix}manifest.json`));
  if (!r.ok) throw new Error(`${bucket}: ${prefix}manifest.json is missing (HTTP ${r.status})`);
  return (await r.json()) as ReleaseManifest;
}

async function settle(db: D1Database, runId: number, log: (l: string) => void, pollMs: number): Promise<RebuildState> {
  const until = Date.now() + 20 * 60_000; let seen = "";
  for (;;) {
    const s = await readState(db);
    const run = s.runs.find((r) => r.id === runId);
    const now = run ? `${run.status}: ${run.steps.map((st) => `${st.name} ${st.status}`).join(", ")}` : "not recorded";
    if (now !== seen) { log(`rebuild ${runId} ${now}`); seen = now; }
    if (run?.status === "done") return s;
    if (run?.status === "failed") { const st = run.steps.find((x) => x.status === "failed"); throw new Error(`rebuild ${runId} failed at ${st?.name ?? "a step"}: ${st?.detail ?? "no reason recorded"}`); }
    if (Date.now() > until) throw new Error(`rebuild ${runId} did not land in 20 minutes`);
    await Bun.sleep(pollMs);
  }
}

export interface CloudOptions { cf: CfApi; account: string; name: string; log?: (line: string) => void; pollMs?: number }

export async function updateOnCloudflare(o: CloudOptions & { release: ReleaseSource }): Promise<{ run: number | null; from: string; to: string; version?: number }> {
  const log = o.log ?? (() => undefined);
  const ready = await rebuildReadiness(o.cf, o.account, o.name);
  if (!ready.ok) throw new Error(ready.reason);
  const db = d1OverRest(o.cf, o.account, ready.uuid);
  const before = await readState(db);
  const current = await readManifest(o.cf, o.account, ready.bucket, before.release ? stagedReleasePrefix(before.release) : RELEASE_PREFIX);
  const to = o.release.manifest.version;
  if (current.version === to) return { run: null, from: current.version, to };
  const classes = (m: ReleaseManifest) => (m.durableObjects ?? []).map((d) => `${d.className}@${d.tag}`).sort().join(", ");
  if (classes(current) !== classes(o.release.manifest)) throw new Error(`voidbase ${to} declares Durable Object classes (${classes(o.release.manifest) || "none"}) the instance does not have (${classes(current) || "none"}); a version upload cannot carry their migration`);
  await applyD1Migrations(o.cf, o.account, ready.uuid, o.release, log);
  const prefix = stagedReleasePrefix(to);
  for (const m of o.release.manifest.modules) await putObject(o.cf, o.account, ready.bucket, releaseModuleKeyIn(prefix, m.path), await o.release.read(`worker/${m.path}`));
  await putObject(o.cf, o.account, ready.bucket, `${prefix}manifest.json`, new TextEncoder().encode(JSON.stringify(o.release.manifest)), "application/json");
  log(`release ${to} staged in ${ready.bucket} (${o.release.manifest.modules.length} modules)`);
  const assets = await uploadReleaseAssets(o.cf, o.account, o.name, o.release, log);
  const rebuilds = cloudflareRebuilds({ DB: db, VOIDBASE_REBUILD: workflowOverRest(o.cf, o.account, `${o.name}-rebuild`) } as never);
  const run = await rebuilds.queue(`update voidbase ${current.version} -> ${to}`, { release: to, ...(assets ? { assets } : {}) });
  log(`rebuild ${run.id} queued`);
  const s = await settle(db, run.id, log, o.pollMs ?? 5000);
  return { run: run.id, from: current.version, to, version: s.runs.find((r) => r.id === run.id)?.version };
}

export async function rollbackOnCloudflare(o: CloudOptions & { to?: number }): Promise<{ to: number; release?: string }> {
  const log = o.log ?? (() => undefined);
  const res = instanceResources(o.name);
  const d1 = await findD1(o.cf, o.account, res.db);
  if (!d1) throw new Error(`${o.name} has no database called ${res.db}`);
  const db = d1OverRest(o.cf, o.account, d1.uuid);
  const s = await readState(db);
  if (s.current === null) throw new Error(`${o.name} has no versions yet, so there is nothing to roll back to`);
  const to = o.to ?? s.versions.find((v) => v.number === s.current)?.from ?? null;
  if (to === null) throw new Error(`version ${s.current} is the first one: there is nothing before it`);
  const rebuilds = cloudflareRebuilds({ DB: db, VOIDBASE_REBUILD: workflowOverRest(o.cf, o.account, `${o.name}-rebuild`) } as never);
  const run = await rebuilds.rollback(to);
  log(`rebuild ${run.id} queued: back to version ${to}`);
  const after = await settle(db, run.id, log, o.pollMs ?? 5000);
  return { to, release: after.release };
}
