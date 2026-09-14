// A vanilla instance on Cloudflare rebuilding itself: the same Rebuilds a Bun instance has (src/node/rebuild.ts), kept in
// the instance's own D1 and run by its own Workflow (./workflow.ts, bound as VOIDBASE_REBUILD). Queueing a change folds it
// into a run that is still waiting, the way a person installing three plugins in a row gets one rebuild; the Workflow
// waits before its first step so the changes made meanwhile are in it. A retry starts a new Workflow instance on the same
// run, which resumes at the failed step. A rollback is a run whose first four steps are skipped: that version is already
// uploaded, so it is deployed again, and the declaration it was built from is put back.
import { STEPS_ORDER } from "../rebuilds";
import type { RebuildRun, Rebuilds } from "../rebuilds";
import { readState, restoreDeclaration, writeState, type RebuildEnv } from "./run";

/** how long a queued run waits for more changes before it starts */
export const FOLD_SECONDS = 20;

export interface CloudflareRebuildEnv extends RebuildEnv {
  VOIDBASE_REBUILD?: { create(options: { id?: string; params?: unknown }): Promise<unknown> };
}

/** whether this Worker can rebuild itself: the Workflow bound, and the token, account and name its upload needs */
export const rebuildsOnCloudflare = (env: Partial<CloudflareRebuildEnv>): boolean =>
  !!(env.VOIDBASE_REBUILD && env.VOIDBASE_REBUILD_TOKEN && env.VOIDBASE_ACCOUNT_ID && env.VOIDBASE_WORKER_NAME);

export function cloudflareRebuilds(env: CloudflareRebuildEnv, o: { now?: () => Date } = {}): Rebuilds {
  const now = () => (o.now ? o.now() : new Date()).toISOString();
  const fresh = (id: number, reasons: string[]): RebuildRun => ({ id, reasons, status: "queued", steps: STEPS_ORDER.map((name) => ({ name, status: "pending" })), queuedAt: now() });
  const start = async (run: RebuildRun, wait: number) => {
    if (!env.VOIDBASE_REBUILD) throw new Error("this instance has no rebuild Workflow bound (VOIDBASE_REBUILD)");
    await env.VOIDBASE_REBUILD.create({ id: `rebuild-${run.id}-${Date.now().toString(36)}`, params: { run: run.id, wait } });
  };
  return {
    async queue(reason, opts) {
      const s = await readState(env.DB);
      const waiting = s.runs.find((r) => r.status === "queued");
      if (waiting) { waiting.reasons.push(reason); if (opts?.release) waiting.release = opts.release; if (opts?.assets) waiting.assets = opts.assets; await writeState(env.DB, s); return waiting; }
      const run = fresh((s.runs.at(-1)?.id ?? 0) + 1, [reason]);
      if (opts?.release) run.release = opts.release;
      if (opts?.assets) run.assets = opts.assets;
      s.runs.push(run); await writeState(env.DB, s);
      await start(run, FOLD_SECONDS);
      return run;
    },
    // a change being made here is one request; the Workflow's wait is what folds several together
    hold: () => () => {},
    async retry() {
      const s = await readState(env.DB);
      const last = s.runs.at(-1);
      if (!last || last.status !== "failed") return null;
      const failed = last.steps.find((st) => st.status === "failed");
      if (failed) { failed.status = "pending"; failed.detail = `retried after: ${failed.detail ?? "a failure"}`; }
      last.status = "queued"; delete last.finishedAt; await writeState(env.DB, s);
      await start(last, 0);
      return last;
    },
    async rollback(version) {
      const s = await readState(env.DB);
      const v = s.versions.find((x) => x.number === version);
      if (!v) throw new Error(`there is no version ${version} to roll back to (versions: ${s.versions.map((x) => x.number).join(", ") || "none"})`);
      if (!v.workerVersion) throw new Error(`version ${version} was never uploaded, so there is nothing to roll back onto`);
      if (v.declaration) await restoreDeclaration(env.DB, v.declaration as Parameters<typeof restoreDeclaration>[1]);
      // the release that version was built on, which an update may since have moved the instance off
      if (v.release) s.release = v.release; else delete s.release;
      const run = fresh((s.runs.at(-1)?.id ?? 0) + 1, [`roll back to version ${version}`]);
      for (const st of run.steps) if (st.name !== "restart") { st.status = "skipped"; st.detail = `version ${version} is already uploaded`; }
      run.version = version; run.declared = v.plugins; run.disabled = v.disabled;
      s.runs.push(run); await writeState(env.DB, s);
      await start(run, 0);
      return run;
    },
    state: () => readState(env.DB),
  };
}
