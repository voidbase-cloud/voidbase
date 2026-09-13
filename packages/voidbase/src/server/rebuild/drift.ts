// Drift, noticed on a schedule (voidbase-stories vanilla-rebuild.feature: "Noticing drift"): what a vanilla instance on
// Cloudflare runs compared with what its admin panel declares. Every version a rebuild uploads is tagged with the hash of
// the declaration it was built from (./run.ts), so the check reads the deployed version's tag and the declaration's hash
// now, and records whether they agree. A declaration changed with no rebuild after it, or a version deployed some other
// way, is drift. The schedule exists to notice it; it never builds (src/server/crons.ts runs it hourly).
import { CfApi } from "../../cloud/rest";
import { deployedVersion } from "../../cloud/worker-versions";
import type { Drift } from "../rebuilds";
import { declarationHash, readDeclaration } from "./declaration";
import { readState, writeState, type RebuildEnv } from "./run";

export async function checkDrift(env: RebuildEnv, o: { api?: string; now?: () => Date } = {}): Promise<Drift> {
  const checkedAt = (o.now ? o.now() : new Date()).toISOString();
  const declared = await declarationHash(await readDeclaration(env.DB));
  let drift: Drift;
  if (!env.VOIDBASE_REBUILD_TOKEN || !env.VOIDBASE_ACCOUNT_ID || !env.VOIDBASE_WORKER_NAME) {
    drift = { checkedAt, declared, deployed: null, drifted: false, detail: "this instance has no rebuild token, so what it runs cannot be read" };
  } else {
    try {
      const v = await deployedVersion(new CfApi(env.VOIDBASE_REBUILD_TOKEN, o.api), env.VOIDBASE_ACCOUNT_ID, env.VOIDBASE_WORKER_NAME);
      const tag = v?.tag ?? null;
      const deployed = tag?.match(/-([0-9a-f]{12})$/)?.[1] ?? null;
      drift = deployed === declared
        ? { checkedAt, declared, deployed, drifted: false }
        : { checkedAt, declared, deployed, drifted: true, detail: deployed ? `the deployed version (${tag}) was built from another declaration` : `the deployed version${tag ? ` (${tag})` : ""} was not uploaded by a rebuild` };
    } catch (err) {
      drift = { checkedAt, declared, deployed: null, drifted: false, detail: `the deployment could not be read: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const s = await readState(env.DB);
  s.drift = drift;
  await writeState(env.DB, s);
  return drift;
}
