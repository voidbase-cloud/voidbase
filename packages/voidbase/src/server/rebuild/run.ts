// One rebuild of a vanilla instance on Cloudflare, step by step, inside the instance's own Workflow
// (voidbase-stories vanilla-rebuild.feature: "A rebuild is durable", "Seeing a rebuild happen", "There is nothing to
// compile"). The same five steps as a rebuild on Bun (src/node/rebuild.ts):
//
//   declare   read the declaration as it stands when the run starts, not when it was queued
//   fetch     each declared plugin's approved commit, checked against the hash the declaration pinned, kept in R2
//   assemble  the release this instance was provisioned with (kept in its own R2) and those plugins, as the next version
//   upload    that version uploaded to the Worker, serving nothing yet
//   restart   that version deployed: the instance runs on it
//
// Every step is recorded in D1 before and after it runs, so the panel reads which step is running and which failed,
// and a retry starts at the failed step with the work of the ones before it still in R2. Written as a function over an
// injected step API so the Bun suite runs it with no Workflows runtime; ./workflow.ts is the Workflow around it.
import type { RebuildRun, RebuildState, StepName } from "../rebuilds";
import { assemble, integrityOfFiles, pluginFilesFrom, untarGz, type ModuleFile } from "./assemble";
import { fetchCommit, readDeclaration, readValue, writeDeclaration, writeValue, type Declaration, type FetchOptions } from "./declaration";
import { CfApi } from "../../cloud/rest";
import { deployVersion, uploadVersion } from "../../cloud/worker-versions";

/** where the instance keeps the release it was provisioned with, and each run's work */
export const RELEASE_PREFIX = "_voidbase/release/";
export const runPrefix = (run: number) => `_voidbase/rebuilds/${run}/`;

export interface RebuildEnv {
  DB: D1Database; STORAGE: R2Bucket;
  VOIDBASE_REBUILD_TOKEN?: string; VOIDBASE_ACCOUNT_ID?: string; VOIDBASE_WORKER_NAME?: string;
}
export interface StepApi { do<T>(name: string, fn: () => Promise<T>): Promise<T>; sleep(name: string, seconds: number): Promise<void> }
export interface RunOptions extends FetchOptions { api?: string; now?: () => Date }

export const readState = (db: D1Database): Promise<RebuildState> => readValue<RebuildState>(db, "state", { runs: [], versions: [], current: null });
export const writeState = (db: D1Database, s: RebuildState): Promise<void> => writeValue(db, "state", s);

const bytesOf = async (bucket: R2Bucket, key: string): Promise<Uint8Array> => {
  const o = await bucket.get(key);
  if (!o) throw new Error(`${key} is not in this instance's bucket`);
  return new Uint8Array(await o.arrayBuffer());
};

interface ReleaseManifest { mainModule: string; compatibilityDate: string; compatibilityFlags: string[]; version: string; modules: { path: string; type: ModuleFile["type"] }[] }

export async function runRebuild(env: RebuildEnv, runId: number, step: StepApi, wait = 0, o: RunOptions = {}): Promise<RebuildRun | null> {
  const now = () => (o.now ? o.now() : new Date()).toISOString();
  if (wait > 0) await step.sleep("wait for more changes", wait);
  const s0 = await readState(env.DB);
  const run0 = s0.runs.find((r) => r.id === runId);
  if (!run0 || (run0.status !== "queued" && run0.status !== "running")) return run0 ?? null;
  const token = env.VOIDBASE_REBUILD_TOKEN; const account = env.VOIDBASE_ACCOUNT_ID; const script = env.VOIDBASE_WORKER_NAME;
  const cf = () => {
    if (!token || !account || !script) throw new Error("this instance has no VOIDBASE_REBUILD_TOKEN, VOIDBASE_ACCOUNT_ID or VOIDBASE_WORKER_NAME, so it cannot upload a version of itself");
    return new CfApi(token, o.api);
  };

  // one step's work, reading and writing the state around it: a step's own record is what the panel shows
  async function perform(name: StepName, run: RebuildRun, s: RebuildState): Promise<void> {
    const prefix = runPrefix(run.id);
    if (name === "declare") {
      const d = await readDeclaration(env.DB);
      run.declared = Object.fromEntries(Object.entries(d.plugins).map(([n, e]) => [n, { version: e.version, commit: e.source.commit }]));
      run.disabled = [...d.disabled];
      await env.STORAGE.put(`${prefix}declaration.json`, JSON.stringify(d));
    } else if (name === "fetch") {
      const d = JSON.parse(new TextDecoder().decode(await bytesOf(env.STORAGE, `${prefix}declaration.json`))) as Declaration;
      for (const [plugin, entry] of Object.entries(d.plugins)) {
        const tgz = await fetchCommit(entry.source, o);
        const files = pluginFilesFrom(await untarGz(tgz), entry.source.directory);
        const got = await integrityOfFiles(files);
        if (got !== entry.integrity) throw new Error(`${plugin} ${entry.version} at ${entry.source.repository}@${entry.source.commit} is not the files the declaration pinned (${entry.integrity}, fetched ${got})`);
        await env.STORAGE.put(`${prefix}plugins/${plugin}.tgz`, tgz);
      }
    } else if (name === "assemble") {
      const d = JSON.parse(new TextDecoder().decode(await bytesOf(env.STORAGE, `${prefix}declaration.json`))) as Declaration;
      const manifest = JSON.parse(new TextDecoder().decode(await bytesOf(env.STORAGE, `${RELEASE_PREFIX}manifest.json`))) as ReleaseManifest;
      const release = new Map<string, ModuleFile>();
      for (const m of manifest.modules) release.set(m.path, { type: m.type, bytes: await bytesOf(env.STORAGE, `${RELEASE_PREFIX}worker/${m.path}`) });
      const plugins = [];
      for (const [plugin, entry] of Object.entries(d.plugins)) {
        plugins.push({ name: plugin, version: entry.version, marketplace: entry.marketplace, files: pluginFilesFrom(await untarGz(await bytesOf(env.STORAGE, `${prefix}plugins/${plugin}.tgz`)), entry.source.directory) });
      }
      const next = assemble({ release, plugins, disabled: d.disabled });
      const modules: { path: string; type: ModuleFile["type"] }[] = [];
      for (const [path, m] of next) { await env.STORAGE.put(`${prefix}modules/${path}`, m.bytes); modules.push({ path, type: m.type }); }
      await env.STORAGE.put(`${prefix}modules.json`, JSON.stringify({ mainModule: manifest.mainModule, compatibilityDate: manifest.compatibilityDate, compatibilityFlags: manifest.compatibilityFlags, release: manifest.version, modules }));
      run.version = (s.versions.at(-1)?.number ?? 0) + 1;
    } else if (name === "upload") {
      if (run.version === undefined) throw new Error("no version was assembled for this run");
      const index = JSON.parse(new TextDecoder().decode(await bytesOf(env.STORAGE, `${prefix}modules.json`))) as { mainModule: string; compatibilityDate: string; compatibilityFlags: string[]; modules: { path: string; type: ModuleFile["type"] }[] };
      const modules = new Map<string, ModuleFile>();
      for (const m of index.modules) modules.set(m.path, { type: m.type, bytes: await bytesOf(env.STORAGE, `${prefix}modules/${m.path}`) });
      const d = JSON.parse(new TextDecoder().decode(await bytesOf(env.STORAGE, `${prefix}declaration.json`))) as Declaration;
      const versionId = await uploadVersion(cf(), account!, script!, modules, { mainModule: index.mainModule, compatibilityDate: index.compatibilityDate, compatibilityFlags: index.compatibilityFlags, message: `rebuild ${run.id}: ${run.reasons.join(", ")}`, tag: `rebuild-${run.version}` });
      s.versions = s.versions.filter((v) => v.number !== run.version);
      s.versions.push({ number: run.version, at: now(), plugins: run.declared ?? {}, disabled: run.disabled ?? [], from: s.current, run: run.id, workerVersion: versionId, declaration: d });
    } else if (name === "restart") {
      const v = s.versions.find((x) => x.number === run.version);
      if (!v?.workerVersion) throw new Error(`version ${run.version} was never uploaded`);
      await deployVersion(cf(), account!, script!, v.workerVersion, `rebuild ${run.id}: onto version ${run.version}`, run.reasons.some((r) => r.startsWith("roll back")));
      s.current = run.version ?? null;
    }
  }

  const s = await readState(env.DB);
  const run = s.runs.find((r) => r.id === runId)!;
  run.status = "running"; run.startedAt ??= now(); await writeState(env.DB, s);
  for (const st of run.steps) {
    if (st.status === "done" || st.status === "skipped") continue;
    st.status = "running"; st.startedAt = now(); delete st.detail; await writeState(env.DB, s);
    try {
      await step.do(st.name, async () => { await perform(st.name, run, s); return st.name; });
      st.status = "done"; st.finishedAt = now(); await writeState(env.DB, s);
    } catch (err) {
      st.status = "failed"; st.finishedAt = now(); st.detail = err instanceof Error ? err.message : String(err);
      run.status = "failed"; run.finishedAt = now(); await writeState(env.DB, s);
      return run;
    }
  }
  run.status = "done"; run.finishedAt = now(); await writeState(env.DB, s);
  return run;
}

/** the declaration a version was built from, put back: a rollback leaves the panel declaring what the instance runs */
export async function restoreDeclaration(db: D1Database, d: Declaration): Promise<void> { await writeDeclaration(db, d); }
