// Not a plugin: the names the previews plugin, `voidbase deploy --preview` and `voidbase previews` agree on, so that the
// CLI can name, find and take down a preview without importing what the plugin does. The previews plugin is a tier 3
// plugin an instance has because someone installed it (voidbase-stories plugin-kinds.feature); these stay in the core
// for the reason /plugins/ai-binding and /plugins/seo-paths do.

/** the branch the preview is for: baked by the deploy (and the deploy knob's name, `--preview` on the command line) */
export const PREVIEW_VAR = "VOIDBASE_PREVIEW";
/** the production Worker the preview is a preview of: baked by the deploy */
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

/** the two shapes a preview can take: an instance of its own, or a marked lane on this one */
export type PreviewShape = "instance" | "flagged";
