// The Workflow a vanilla instance on Cloudflare rebuilds itself with, exported from the instance's Worker and bound as
// VOIDBASE_REBUILD (hooks-plugin.ts exports it from the entry; src/cloud/rest.ts binds it when it provisions). The steps
// are ./run.ts's. A step that fails is not retried by the runtime: its reason is recorded for the panel, and a person
// retries it (POST /api/rebuilds/retry), which starts a new instance on the same run.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { runRebuild, type RebuildEnv } from "./run";

export class VoidbaseRebuild extends WorkflowEntrypoint<RebuildEnv, { run: number; wait?: number }> {
  async run(event: WorkflowEvent<{ run: number; wait?: number }>, step: WorkflowStep): Promise<void> {
    await runRebuild(this.env, event.payload.run, {
      // a step answers its name, which is what the Workflow keeps; the work it did is recorded in D1 and R2
      do: async (name, fn) => { await step.do(name, { retries: { limit: 0, delay: 1000 } }, async () => { await fn(); return name; }); return name as never; },
      sleep: (name, seconds) => step.sleep(name, `${seconds} seconds`),
    }, event.payload.wait ?? 0);
  }
}
