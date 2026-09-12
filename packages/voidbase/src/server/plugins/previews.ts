// A preview per pull request: what the instance knows about being one.
//
// A preview is a whole instance of its own (a Worker with its own database, bucket and queue), deployed for one
// branch and seeded from production, so a reviewer gets a working address that goes when the pull request does.
// All of that happens around a deploy, in the plugin's deploy-time half (src/node/plugins/previews.ts): the naming,
// the seeding, the pull request comment, the removal. What it leaves the Worker is two vars, and this runtime half
// reports them on /api/plugins, so an instance (and the panel, and the SDK) can tell it is a preview and of what.
// The naming rule lives here too, because both halves need it and it depends on nothing.
//
// The second shape, `--shape flagged`, makes no instance at all: the branch shares production and its writes carry a
// mark, which production reads filter out (src/server/records/preview.ts holds the mark and the filter; they are in
// the records path because every read has to agree about them). What is here is what a shape needs from the
// instance: which shape this instance is in, which branches have rows, and the one route that takes a branch's rows
// away again, which is what `voidbase previews remove --shape flagged` calls.
import { env as voidEnv } from "#platform/env";
import type { Context, Hono } from "hono";
import { requireSuperuser } from "../auth-slot";
import { listCollections, type Collection } from "../collections/model";
import { all, ident, stmt } from "../db";
import { badRequest } from "../errors";
import { deleteAllRecordFiles } from "../records/files";
import { flaggedCollections, PREVIEW_FIELD, PREVIEW_HEADER, PREVIEW_PARAM } from "../records/preview";
import type { Kernel } from "../kernel";
import type { AppEnv, Bindings } from "../types";
import type { Plugin } from "./manifest";

export { PREVIEW_FIELD, PREVIEW_HEADER, PREVIEW_PARAM } from "../records/preview";

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

/** the two shapes a preview can take: an instance of its own, or a marked lane on this one */
export type PreviewShape = "instance" | "flagged";
export interface PreviewsInfo { shape: PreviewShape; of?: string; branch?: string }

/**
 * What GET /api/plugins says in its `previews` field. An instance the deploy baked the vars into is a preview
 * instance and says so; every other instance is in flagged mode, because a request carrying the header is all a
 * flagged preview takes. The branches with rows are added by `previewsReport`, which needs the database.
 */
export const previewsInfo = (env?: object): PreviewsInfo => {
  const read = (k: string) => String((env as Record<string, unknown> | undefined)?.[k] ?? (voidEnv as Record<string, unknown>)[k] ?? "").trim();
  const of = read(PREVIEW_OF_VAR), branch = read(PREVIEW_VAR);
  if (of || branch) return { shape: "instance", ...(of ? { of } : {}), ...(branch ? { branch } : {}) };
  return { shape: "flagged" };
};

/** one branch with rows on this instance: how many, and in which collections */
export interface FlaggedBranch { branch: string; rows: number; collections: string[] }

/** the branches that have rows here, newest count first; empty on an instance nobody has previewed this way */
export async function flaggedBranches(db: D1Database, collections: Collection[]): Promise<FlaggedBranch[]> {
  const byBranch = new Map<string, FlaggedBranch>();
  for (const c of flaggedCollections(collections)) {
    const rows = await all<{ branch: string; n: number }>(db, `SELECT ${ident(PREVIEW_FIELD)} AS branch, COUNT(*) AS n FROM ${ident(c.name)} WHERE ${ident(PREVIEW_FIELD)} != '' GROUP BY ${ident(PREVIEW_FIELD)}`);
    for (const r of rows) {
      const entry = byBranch.get(String(r.branch)) ?? { branch: String(r.branch), rows: 0, collections: [] };
      entry.rows += Number(r.n); entry.collections.push(c.name);
      byBranch.set(entry.branch, entry);
    }
  }
  for (const e of byBranch.values()) e.collections.sort();
  return [...byBranch.values()].sort((a, b) => b.rows - a.rows || (a.branch < b.branch ? -1 : 1));
}

/** the `previews` field in full: the shape, and in flagged mode the branches with rows */
export async function previewsReport(env: Bindings): Promise<PreviewsInfo & { branches?: FlaggedBranch[] }> {
  const info = previewsInfo(env);
  if (info.shape !== "flagged") return info;
  try { return { ...info, branches: await flaggedBranches(env.DB, await listCollections(env.DB)) }; }
  catch { return { ...info, branches: [] } ; }
}

/** every row of a branch taken away, collection by collection, with the files those rows owned */
export async function removeFlagged(env: Bindings, branch: string): Promise<{ branch: string; deleted: Record<string, number>; rows: number }> {
  const deleted: Record<string, number> = {};
  let total = 0;
  for (const c of flaggedCollections(await listCollections(env.DB))) {
    const ids = await all<{ id: string }>(env.DB, `SELECT id FROM ${ident(c.name)} WHERE ${ident(PREVIEW_FIELD)} = ?`, [branch]);
    if (!ids.length) continue;
    await stmt(env.DB, `DELETE FROM ${ident(c.name)} WHERE ${ident(PREVIEW_FIELD)} = ?`, [branch]).run();
    deleted[c.name] = ids.length; total += ids.length;
    for (const r of ids) { try { await deleteAllRecordFiles(env.STORAGE, c.id, String(r.id)); } catch { /* the rows are gone either way */ } }
  }
  return { branch, deleted, rows: total };
}

/** the branch a request names for the remove route, refused rather than guessed at when it is not one */
const branchParam = (c: Context<AppEnv>): string => {
  const raw = (c.req.query("branch") ?? "").trim();
  if (!/^[A-Za-z0-9][\w./-]{0,99}$/.test(raw)) throw badRequest(`branch is required: DELETE /api/previews?branch=<branch> (the value of ${PREVIEW_HEADER} the preview writes with).`);
  return raw;
};

function mountRoutes(app: Hono<AppEnv>) {
  // the same report /api/plugins carries, on its own so a CLI can ask for it without the whole inventory
  app.get("/api/previews", async (c) => { requireSuperuser(c); return c.json(await previewsReport(c.env)); });
  // what `voidbase previews remove <branch> --shape flagged` and the flagged prune call: the branch's rows go,
  // and nothing else does. A row production already had was never the branch's, so it is not here to delete.
  app.delete("/api/previews", async (c) => { requireSuperuser(c); return c.json(await removeFlagged(c.env, branchParam(c))); });
}

export const previews: Plugin = {
  manifest: { name: "previews", version: "0.1.0", tier: "official", voidbase: "*" },
  info: (env) => previewsReport(env),
  apply(ctx: Kernel) { mountRoutes(ctx.app); },
};
