// A vanilla instance rebuilding itself on this machine (voidbase-stories, voidbase/vanilla-rebuild.feature: "Rebuilding a
// local instance", "A rebuild is durable", "Installing several plugins at once", "A rebuild produces a new version").
//
// The declaration is the project's pb_plugins and voidbase.lock, which the admin panel's installer changes. The instance
// runs a version: a copy of the declaration assembled under pb_data/versions/<n> and put in place at pb_data/active,
// which `voidbase serve` loads plugins from once it exists (src/node/serve.ts). A rebuild is five steps, each recorded in
// pb_data/rebuilds.json before and after it runs:
//
//   declare   read the declaration as it stands when the run starts, not when it was queued
//   fetch     verify every declared plugin's files against voidbase.lock, the way the instance does before loading
//   assemble  copy the declaration into the next version
//   upload    put that version in place as the one the instance runs
//   restart   start this process again, onto it
//
// A step that throws fails the run with its reason, and a retry starts from that step: the ones before it stay done.
// Changes made while a run waits fold into it; a change made while one runs queues exactly one more. Nothing here is
// timed by a schedule: a rebuild is started by what someone did.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RebuildRun, RebuildState, Rebuilds, StepName } from "../server/rebuilds";
import { type CoreRecord, writeCoreRecord } from "./core";
import { lockPath, pluginsDirOf, readLock, verifyInstalled } from "./installed";

export const STEPS: StepName[] = ["declare", "fetch", "assemble", "upload", "restart"];

export interface RebuilderOptions {
  /** the project root: pb_plugins and voidbase.lock, as the panel declares them */
  root: string;
  /** pb_data: rebuilds.json, versions/ and active/ */
  dataDir: string;
  /** start the instance again onto the active version; the run is recorded as done before this is called */
  restart: () => void | Promise<void>;
  /** how long a queued run waits for more changes to fold in */
  delayMs?: number;
  now?: () => Date;
  /** the files of the declaration checked against its lock (verifyInstalled unless a test says otherwise) */
  verify?: (root: string) => Promise<unknown>;
  /**
   * the core a version runs on (src/node/core.ts): the voidbase serving now, how it runs, whether a version of it is
   * already on this machine, and how to bring one in. Without it versions pin no core and run whatever starts them.
   */
  core?: { current: string; self?: CoreRecord; has(version: string): boolean; fetch(version: string): Promise<void> };
}

/** copy a declaration (voidbase.lock and pb_plugins) from one directory into another, replacing what is there */
function copyDeclaration(from: string, to: string, withCore = false): void {
  mkdirSync(to, { recursive: true });
  rmSync(join(to, "pb_plugins"), { recursive: true, force: true });
  rmSync(join(to, "voidbase.lock"), { force: true });
  // the core a version runs on goes with it into pb_data/active, and never into the project root
  if (withCore) { rmSync(join(to, "core.json"), { force: true }); if (existsSync(join(from, "core.json"))) cpSync(join(from, "core.json"), join(to, "core.json")); }
  if (existsSync(pluginsDirOf(from))) cpSync(pluginsDirOf(from), join(to, "pb_plugins"), { recursive: true });
  if (existsSync(lockPath(from))) cpSync(lockPath(from), join(to, "voidbase.lock"));
}

/** the voidbase version a version directory runs on, when it pins one */
const coreOf = (dir: string): string | undefined => { try { return (JSON.parse(readFileSync(join(dir, "core.json"), "utf8")) as { version?: string }).version; } catch { return undefined; } };

export function createRebuilder(o: RebuilderOptions): Rebuilds {
  const statePath = join(o.dataDir, "rebuilds.json");
  const versionDir = (n: number) => join(o.dataDir, "versions", String(n));
  const activeDir = join(o.dataDir, "active");
  const now = () => (o.now ? o.now() : new Date()).toISOString();
  const read = (): RebuildState => (existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")) as RebuildState) : { runs: [], versions: [], current: null });
  const save = (s: RebuildState) => {
    mkdirSync(o.dataDir, { recursive: true });
    writeFileSync(`${statePath}.next`, `${JSON.stringify(s, null, 2)}\n`);
    renameSync(`${statePath}.next`, statePath);
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  const fresh = (id: number, reasons: string[]): RebuildRun => ({ id, reasons, status: "queued", steps: STEPS.map((name) => ({ name, status: "pending" })), queuedAt: now() });

  async function perform(name: StepName, run: RebuildRun, s: RebuildState): Promise<void> {
    if (name === "declare") {
      const lock = readLock(o.root);
      run.declared = Object.fromEntries(Object.entries(lock.plugins).map(([n, e]) => [n, { version: e.version, commit: e.source.commit }]));
      run.disabled = [...lock.disabled];
      // a rebuild for any other reason keeps the core in place; an update named its own when it was queued
      if (o.core) run.core ??= coreOf(activeDir) ?? o.core.current;
    } else if (name === "fetch") {
      await (o.verify ?? verifyInstalled)(o.root);
      if (o.core) {
        // the voidbase serving now is recorded the first time, so a rollback can come back to it
        if (o.core.self && !o.core.has(o.core.self.version)) writeCoreRecord(o.dataDir, o.core.self);
        if (run.core && !o.core.has(run.core)) await o.core.fetch(run.core);
      }
    } else if (name === "assemble") {
      const n = (s.versions.at(-1)?.number ?? 0) + 1;
      const partial = `${versionDir(n)}.partial`;
      rmSync(partial, { recursive: true, force: true });
      copyDeclaration(o.root, partial);
      if (run.core) writeFileSync(join(partial, "core.json"), `${JSON.stringify({ version: run.core })}\n`);
      rmSync(versionDir(n), { recursive: true, force: true });
      renameSync(partial, versionDir(n));
      s.versions.push({ number: n, at: now(), plugins: run.declared ?? {}, disabled: run.disabled ?? [], from: s.current, run: run.id, ...(run.core ? { core: run.core } : {}) });
      run.version = n;
    } else if (name === "upload") {
      if (run.version === undefined) throw new Error("no version was assembled for this run");
      copyDeclaration(versionDir(run.version), activeDir, true);
      s.current = run.version;
    }
  }

  async function runOne(): Promise<void> {
    if (running) return;
    const s = read();
    const run = s.runs.find((r) => r.status === "queued");
    if (!run) return;
    running = true;
    try {
      run.status = "running"; run.startedAt ??= now(); save(s);
      for (const step of run.steps) {
        if (step.status === "done" || step.status === "skipped") continue;
        step.status = "running"; step.startedAt = now(); delete step.detail; save(s);
        if (step.name === "restart") {
          // recorded as done first: the restart ends this process, and the one it starts reads this file
          step.status = "done"; step.finishedAt = now(); run.status = "done"; run.finishedAt = now(); save(s);
          running = false;
          await o.restart();
          return;
        }
        try {
          await perform(step.name, run, s);
          step.status = "done"; step.finishedAt = now(); save(s);
        } catch (err) {
          step.status = "failed"; step.finishedAt = now(); step.detail = err instanceof Error ? err.message : String(err);
          run.status = "failed"; run.finishedAt = now(); save(s);
          return;
        }
      }
      run.status = "done"; run.finishedAt = now(); save(s);
    } finally {
      running = false;
    }
    // a change made while this one ran: it is queued, and it runs now
    if (read().runs.some((r) => r.status === "queued")) await runOne();
  }

  // changes still being made: an install downloading can take longer than the wait, and must still fold in
  let holds = 0;
  const schedule = (delay = o.delayMs ?? 1500) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (holds > 0) return;
    timer = setTimeout(() => { timer = null; void runOne(); }, delay);
  };

  return {
    hold() {
      holds++;
      if (timer) { clearTimeout(timer); timer = null; }
      let released = false;
      return () => {
        if (released) return;
        released = true; holds--;
        if (holds === 0 && !running && read().runs.some((r) => r.status === "queued")) schedule();
      };
    },
    queue(reason, opts) {
      const s = read();
      const waiting = s.runs.find((r) => r.status === "queued");
      if (waiting) { waiting.reasons.push(reason); if (opts?.core) waiting.core = opts.core; save(s); if (!running) schedule(); return waiting; }
      const run = fresh((s.runs.at(-1)?.id ?? 0) + 1, [reason]);
      if (opts?.core) run.core = opts.core;
      s.runs.push(run); save(s);
      if (!running) schedule();
      return run;
    },
    retry() {
      const s = read();
      const last = s.runs.at(-1);
      if (!last || last.status !== "failed") return null;
      const failed = last.steps.find((step) => step.status === "failed");
      if (failed) { failed.status = "pending"; failed.detail = `retried after: ${failed.detail ?? "a failure"}`; }
      last.status = "queued"; delete last.finishedAt; save(s);
      schedule(0);
      return last;
    },
    rollback(version) {
      const s = read();
      if (!s.versions.some((v) => v.number === version)) throw new Error(`there is no version ${version} to roll back to (versions: ${s.versions.map((v) => v.number).join(", ") || "none"})`);
      // the declaration becomes that version's, so what the panel declares is again what the instance runs
      copyDeclaration(versionDir(version), o.root);
      const run = fresh((s.runs.at(-1)?.id ?? 0) + 1, [`roll back to version ${version}`]);
      for (const step of run.steps) if (step.name === "declare" || step.name === "fetch" || step.name === "assemble") { step.status = "skipped"; step.detail = `version ${version} is already assembled`; }
      run.version = version;
      s.runs.push(run); save(s);
      schedule(0);
      return run;
    },
    state: read,
  };
}

let current: Rebuilds | null = null;
/** the rebuilder of the instance this process serves, set when it starts (src/node/serve.ts) */
export const setRebuilder = (r: Rebuilds | null): void => { current = r; };
export const currentRebuilder = (): Rebuilds | null => current;
