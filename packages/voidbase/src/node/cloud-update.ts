// `voidbase update --cloudflare <name>`: an instance on Cloudflare rebuilt onto the voidbase this CLI is, as a new
// version of its Worker. Only the site could do this before (its upgradeInstance); the CLI builds the release itself
// (src/node/bundle.ts) and uploads it the same way the site does (provisionInstance, secrets inherited).
//
// One kind of instance must not be updated this way. A release is voidbase as shipped, so an instance that was
// deployed from a project -- its pb_hooks, its plugins, its entry point -- would lose all of that to an upload of the
// release. The two are told apart by the Worker's tags: an instance provisioned from a release carries
// `voidbase-release:<version>`, set in the upload metadata, and one from `voidbase deploy` carries none, because that
// path uploads through wrangler, whose metadata is not ours to add to (src/cloud/rest.ts, listVoidbaseWorkers).
//
// The tags are read for the one Worker being updated and nothing else on the account.
import { workerExists, type CfApi } from "../cloud/rest";

export type UpdatePlan = { ok: true; from: string; keepTags: string[] } | { ok: false; reason: string };

/** what an update of `name` may do, given its Worker's tags, or null when there is no such Worker */
export function updatePlan(name: string, tags: string[] | null): UpdatePlan {
  if (tags === null) return { ok: false, reason: `there is no Worker called ${name} on this account (voidbase instances --cloudflare lists the voidbase ones)` };
  const release = tags.find((t) => t.startsWith("voidbase-release:"))?.slice("voidbase-release:".length);
  if (!release) {
    return { ok: false, reason: `${name} was deployed from a project, so it updates where it came from: voidbase deploy in the project, or a push if its repository is connected. Updating it from a release would replace the project's hooks and plugins with voidbase as shipped.` };
  }
  // the upload sets `voidbase` and the new release tag itself; anything else on the Worker (an owner, say) is kept
  return { ok: true, from: release, keepTags: tags.filter((t) => t !== "voidbase" && !t.startsWith("voidbase-release:")) };
}

/** the tags of one Worker, or null when the account has no Worker by that name */
export async function workerTags(api: CfApi, account: string, name: string): Promise<string[] | null> {
  if (!(await workerExists(api, account, name))) return null;
  const r = await api.json<{ tags?: string[] | null }>("GET", `/accounts/${account}/workers/scripts/${name}/settings`);
  return r.result?.tags ?? [];
}
