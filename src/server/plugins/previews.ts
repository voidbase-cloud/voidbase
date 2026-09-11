// A preview per pull request: what the instance knows about being one.
//
// A preview is a whole instance of its own (a Worker with its own database, bucket and queue), deployed for one
// branch and seeded from production, so a reviewer gets a working address that goes when the pull request does.
// All of that happens around a deploy, in the plugin's deploy-time half (src/node/plugins/previews.ts): the naming,
// the seeding, the pull request comment, the removal. What it leaves the Worker is two vars, and this runtime half
// reports them on /api/plugins, so an instance (and the panel, and the SDK) can tell it is a preview and of what.
// The naming rule lives here too, because both halves need it and it depends on nothing.
import { env as voidEnv } from "#platform/env";
import type { Plugin } from "./manifest";

/** the branch the preview is for: baked by the deploy plugin (and the deploy knob's name, `--preview` on the command line) */
export const PREVIEW_VAR = "VOIDBASE_PREVIEW";
/** the production Worker the preview is a preview of: baked by the deploy plugin */
export const PREVIEW_OF_VAR = "VOIDBASE_PREVIEW_OF";
/** a Worker name is at most 63 characters (Cloudflare's limit) */
const NAME_MAX = 63;
const SLUG_MAX = 20;

/** a 4-character base-36 hash of the branch (FNV-1a), so two branches with one slug never share a Worker */
export function branchHash(branch: string): string {
  let h = 2166136261;
  for (const ch of branch) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return (h >>> 0).toString(36).padStart(4, "0").slice(-4);
}

/**
 * The branch as a Worker name segment: lowercase, anything but [a-z0-9] to a dash, dashes collapsed and trimmed, at
 * most 20 characters, then a dash and the branch's hash. `feature/Login-Flow` -> `feature-login-flow-<hash>`.
 */
export function branchSlug(branch: string, max = SLUG_MAX): string {
  if (max <= 0) return branchHash(branch); // no room beside a long production name: the hash alone still tells branches apart
  const words = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
  return `${words || "branch"}-${branchHash(branch)}`;
}

/** the preview's Worker name: `<production>-pr-<slug>`, the slug shortened when the whole would exceed Cloudflare's 63 characters */
export function previewWorkerName(production: string, branch: string): string {
  const budget = NAME_MAX - production.length - "-pr-".length - 5; // the dash and the 4-character hash
  return `${production}-pr-${branchSlug(branch, Math.min(SLUG_MAX, budget))}`;
}
/** the prefix every preview of a production Worker shares, which is how `voidbase previews list` finds them */
export const previewPrefix = (production: string) => `${production}-pr-`;

export interface PreviewsInfo { of?: string; branch?: string }

/** what GET /api/plugins says in its `previews` field: the two vars the deploy baked, or nothing on a production instance */
export const previewsInfo = (env?: object): PreviewsInfo => {
  const read = (k: string) => String((env as Record<string, unknown> | undefined)?.[k] ?? (voidEnv as Record<string, unknown>)[k] ?? "").trim();
  const of = read(PREVIEW_OF_VAR), branch = read(PREVIEW_VAR);
  return { ...(of ? { of } : {}), ...(branch ? { branch } : {}) };
};

export const previews: Plugin = {
  manifest: { name: "previews", version: "0.1.0", tier: "official", voidbase: "*" },
};
