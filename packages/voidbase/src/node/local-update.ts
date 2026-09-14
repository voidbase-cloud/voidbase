// Taking a new version of voidbase on this machine, and going back (voidbase-stories voidbase/updating-core.feature:
// "Updating a local instance", "An update that goes badly"). An update is a rebuild that pins a newer voidbase as the
// instance's next version (src/node/core.ts, src/node/rebuild.ts); a rollback puts an earlier version back, its voidbase
// included. A running instance owns its rebuilds and its restart, so it is asked, through a request file and a signal,
// and the answer is the instance coming back on the version asked for. A stopped one is rebuilt here, and runs the new
// version when it starts: the CLI hands over to the pinned voidbase then (`handOver`).
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RebuildState, Rebuilds } from "../server/rebuilds";
import { activeCoreVersion, coreRecord, type CoreRecord, fetchCore, handoffFor, type RebuildRequest, runningInstance, takeRequest, writeRequest, writeServeInfo } from "./core";
import { createRebuilder } from "./rebuild";

export interface LocalOptions {
  /** the instance's directory: its pb_plugins and voidbase.lock */
  root: string;
  /** its pb_data */
  dataDir: string;
  /** the voidbase running this CLI */
  running: string;
  shape: "executable" | "package";
  log?: (line: string) => void;
}

const readState = (dataDir: string): RebuildState => {
  const path = join(dataDir, "rebuilds.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as RebuildState) : { runs: [], versions: [], current: null };
};
const self = (o: LocalOptions): CoreRecord => ({ version: o.running, argv: o.shape === "executable" ? [process.execPath] : [process.execPath, resolve(import.meta.dir, "../../bin/voidbase.ts")] });
const failure = (s: RebuildState): string | null => {
  const last = s.runs.at(-1); if (last?.status !== "failed") return null;
  const step = last.steps.find((x) => x.status === "failed");
  return `the rebuild failed at ${step?.name ?? "a step"}: ${step?.detail ?? "no reason recorded"}`;
};
async function healthVersion(http: string): Promise<string | null> {
  if (!http) return null;
  try { const r = await fetch(`${http}/api/health`, { signal: AbortSignal.timeout(3000) }); return ((await r.json()) as { data?: { voidbase?: { version?: string } } }).data?.voidbase?.version ?? null; } catch { return null; }
}

/** the rebuilder of a stopped instance, run in this process: it restarts nothing, since nothing is running */
function offline(o: LocalOptions): Rebuilds {
  return createRebuilder({
    root: o.root, dataDir: o.dataDir, delayMs: 10, restart: () => undefined,
    core: { current: o.running, self: self(o), has: (v) => !!coreRecord(o.dataDir, v), fetch: async (v) => { await fetchCore({ dataDir: o.dataDir, version: v, shape: o.shape, log: o.log }); } },
  });
}
async function settle(r: Rebuilds): Promise<RebuildState> {
  const until = Date.now() + 15 * 60_000;
  for (;;) {
    const s = (await r.state()) as RebuildState;
    const failed = failure(s); if (failed) throw new Error(failed);
    if (!s.runs.some((x) => x.status === "queued" || x.status === "running")) return s;
    if (Date.now() > until) throw new Error("the rebuild did not finish in 15 minutes");
    await Bun.sleep(100);
  }
}

/** ask the instance serving this pb_data, when one is; false when none is running */
async function askRunning(o: LocalOptions, request: Parameters<typeof writeRequest>[1], landed: (s: RebuildState, version: string | null) => boolean, what: string): Promise<boolean> {
  const info = runningInstance(o.dataDir);
  if (!info) return false;
  if (info.requests !== true) throw new Error(`this instance runs voidbase ${info.version}, which cannot take ${what} while it runs: stop it, run this again, then start it`);
  const before = readState(o.dataDir).runs.length;
  writeRequest(o.dataDir, request);
  process.kill(info.pid, "SIGUSR2");
  o.log?.(`asked the running instance (pid ${info.pid}) for ${what}`);
  const until = Date.now() + 15 * 60_000;
  for (;;) {
    const s = readState(o.dataDir);
    if (s.runs.length > before) {
      const failed = failure(s); if (failed) throw new Error(failed);
      if (s.runs.at(-1)?.status === "done" && landed(s, await healthVersion(info.http))) return true;
    }
    if (Date.now() > until) throw new Error(`${what} did not finish in 15 minutes`);
    await Bun.sleep(1000);
  }
}

export async function updateLocalInstance(o: LocalOptions & { target: string }): Promise<void> {
  const log = o.log ?? (() => undefined);
  const pinned = activeCoreVersion(o.dataDir) ?? runningInstance(o.dataDir)?.version ?? o.running;
  if (pinned === o.target) { log(`this instance already runs voidbase ${o.target}`); return; }
  if (await askRunning(o, { update: o.target }, (_s, version) => version === o.target, `an update to voidbase ${o.target}`)) {
    log(`updated in place: the instance is back, running voidbase ${o.target}`);
    return;
  }
  const r = offline(o);
  r.queue(`update voidbase ${pinned} -> ${o.target}`, { core: o.target });
  const s = await settle(r);
  log(`updated: version ${s.current} runs voidbase ${o.target}, which is what the instance runs when it starts`);
}

export async function rollbackLocalInstance(o: LocalOptions & { to?: number }): Promise<void> {
  const log = o.log ?? (() => undefined);
  const s = readState(o.dataDir);
  if (s.current === null) throw new Error("this instance has no versions yet, so there is nothing to roll back to");
  const to = o.to ?? s.versions.find((v) => v.number === s.current)?.from ?? null;
  if (to === null) throw new Error(`version ${s.current} is the first one: there is nothing before it`);
  const version = s.versions.find((v) => v.number === to);
  if (!version) throw new Error(`there is no version ${to} (versions: ${s.versions.map((v) => v.number).join(", ")})`);
  const what = `a rollback to version ${to}${version.core ? ` (voidbase ${version.core})` : ""}`;
  if (await askRunning(o, { rollback: to }, (state, running) => state.current === to && (!version.core || running === version.core), what)) {
    log(`rolled back in place: the instance is back on version ${to}${version.core ? `, running voidbase ${version.core}` : ""}`);
    return;
  }
  const r = offline(o);
  r.rollback(to);
  await settle(r);
  log(`rolled back to version ${to}${version.core ? `, voidbase ${version.core}` : ""}, which is what the instance runs when it starts`);
}

/**
 * Start the voidbase the version in place pins, when it is not this one, with the same arguments; null when this one
 * is it. A pinned voidbase older than the update protocol takes no requests, so this process takes them for it: asked
 * for an update or a rollback, it stops the pinned one, rebuilds the instance here as a stopped one is rebuilt, and
 * starts whichever voidbase the instance pins now (voidbase-stories a-binary-vanilla.feature, "Updating the instance":
 * the CLI update rebuilds it in place whatever it runs). It forwards the signals a person stops it with.
 */
export async function handOver(dataDir: string, running: string, http?: string, shape: LocalOptions["shape"] = "package"): Promise<number | null> {
  let record = handoffFor(dataDir, running);
  if (!record) return null;
  // handed to this version already, and it says it is another: stop rather than start one process after another
  if (process.env.VOIDBASE_CORE_HANDOFF === record.version) throw new Error(`pb_data/cores/${record.version} does not run voidbase ${record.version} (it runs ${running}): update again, or roll back`);
  const url = http ? `http://${http}` : "http://127.0.0.1:8090";
  const o: LocalOptions = { root: resolve(dataDir, ".."), dataDir, running, shape, log: (l) => console.log(`voidbase: ${l}`) };
  let child: ReturnType<typeof Bun.spawn> | null = null;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { if (child) child.kill(signal); else process.exit(0); });
  for (;;) {
    const env: Record<string, string | undefined> = { ...process.env, VOIDBASE_CORE_HANDOFF: record?.version };
    delete env.VOIDBASE_RESTART_ARGV; delete env.VOIDBASE_RESTART_ENV;
    // pinned to another voidbase: that one serves; pinned to this one again (a rollback past an update): this CLI, fresh
    const argv = record ? [...record.argv, ...process.argv.slice(2)] : [process.execPath, ...process.argv.slice(1)];
    if (!record) {
      // back on this CLI's own voidbase, which records itself and takes requests: this process gives up the record first
      // (a server that finds a live one recorded leaves it alone) and passes a request's signal on instead of dying of it
      delete env.VOIDBASE_CORE_HANDOFF;
      if (runningInstance(dataDir)?.pid === process.pid) rmSync(join(dataDir, ".serve.json"), { force: true });
    }
    const started = Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env: env as Record<string, string> });
    child = started;
    if (!record) { process.on("SIGUSR2", () => { try { started.kill("SIGUSR2"); } catch { /* already gone */ } }); return await started.exited; }
    writeServeInfo(dataDir, { pid: process.pid, http: url, version: record.version, requests: true });
    let request: RebuildRequest | null = null;
    const onRequest = () => { const r = takeRequest(dataDir); if (!r) return; request = r; started.kill("SIGTERM"); };
    process.on("SIGUSR2", onRequest);
    const code = await started.exited;
    process.off("SIGUSR2", onRequest);
    child = null;
    const asked = request as RebuildRequest | null;
    if (!asked) return code;
    try {
      const r = offline(o);
      if ("update" in asked) r.queue(`update voidbase ${record.version} -> ${asked.update}`, { core: asked.update }); else r.rollback(asked.rollback);
      await settle(r);
    } catch (err) { console.error(`voidbase: ${err instanceof Error ? err.message : String(err)}; starting the instance on what it pinned before`); }
    record = handoffFor(dataDir, running);
  }
}
