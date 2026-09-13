// A preview per pull request: what the instance knows about being one.
//
// A preview is a whole instance of its own (a Worker with its own database, bucket and queue), deployed for one
// branch and seeded from production, so a reviewer gets a working address that goes when the pull request does.
// All of that happens around a deploy, in the plugin's deploy-time half, which is not this package: it runs inside
// `voidbase deploy`, in the CLI's own process, against the Cloudflare API and GitHub's, so it stays in the core
// (`src/node/plugins/previews.ts`) and reads the two var names and the naming rule back through the entry the core
// keeps. What a deploy leaves the Worker is two vars, and this runtime half reports them on /api/plugins, so an
// instance (and the panel, and the SDK) can tell it is a preview and of what. The naming rule lives here too,
// because both halves need it and it depends on nothing.
//
// The second shape, `--shape flagged`, makes no instance at all: the branch shares production and its writes carry a
// mark, which production reads filter out (the core's records/preview module holds the mark and the filter; they are
// in the records path because every read has to agree about them, and `/records-preview` is what publishes the four
// names a plugin needs of it). What is here is what a shape needs from the instance: which shape this instance is
// in, which branches have rows, and the one route that takes a branch's rows away again, which is what
// `voidbase previews remove --shape flagged` calls.
//
// The file is the one that sat in `packages/voidbase/src/server/plugins/previews.ts`, with its ten relative imports
// written as the six published names they already resolved to: `#platform/env` becomes `/platform`; `../auth-slot`,
// `../collections/model`, `../db` and `../errors` are four modules and one entry, `/sdk`, which is where the names
// more than one shipped plugin uses are published; `../records/files` and `../records/preview` are `/records-files`
// and `/records-preview`; and `../kernel`, `../types` and `./manifest` keep their own names.
import { env as voidEnv } from "@voidbase-cloud/voidbase/platform";
import type { Context, Hono } from "hono";
import { all, badRequest, ident, listCollections, requireSuperuser, stmt } from "@voidbase-cloud/voidbase/sdk";
import { deleteAllRecordFiles } from "@voidbase-cloud/voidbase/records-files";
import { flaggedCollections, PREVIEW_FIELD, PREVIEW_HEADER } from "@voidbase-cloud/voidbase/records-preview";
import type { Kernel } from "@voidbase-cloud/voidbase/kernel";
import type { AppEnv, Bindings, Collection } from "@voidbase-cloud/voidbase/types";
import type { Plugin } from "@voidbase-cloud/voidbase/plugins";

export { PREVIEW_FIELD, PREVIEW_HEADER, PREVIEW_PARAM } from "@voidbase-cloud/voidbase/records-preview";

// the names voidbase deploy and voidbase previews share with this plugin are the core's (/plugins/previews-names)
export { branchHash, branchSlug, PREVIEW_OF_VAR, PREVIEW_VAR, previewPrefix, previewWorkerName, type PreviewShape } from "@voidbase-cloud/voidbase/plugins/previews-names";
import { PREVIEW_OF_VAR, PREVIEW_VAR, type PreviewShape } from "@voidbase-cloud/voidbase/plugins/previews-names";

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
