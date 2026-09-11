// The previews plugin's deploy-time half: a preview instance per pull request (src/node/deploy-plugin.ts).
//
// `voidbase deploy --preview <branch>` (or VOIDBASE_PREVIEW=<branch>, which a Workers build sets from
// WORKERS_CI_BRANCH) deploys the project as a Worker of its own, `<name>-pr-<slug>` (the rule is in
// src/server/plugins/previews.ts), so every resource the deploy names after the Worker (D1, R2, the queue) is the
// preview's own. Before the upload this plugin bakes VOIDBASE_PREVIEW and VOIDBASE_PREVIEW_OF as vars and keeps the
// Worker on workers.dev; the domains plugin, which runs after it, sees the var and attaches no production hostname.
// After the upload it seeds the preview from production through the backups API over HTTP (a `schema` archive by
// default: the collections' definitions and nothing else; VOIDBASE_PREVIEW_SEED=data brings the rows and files
// too), then finds the branch's open pull request and posts, or updates, one comment carrying the address. On
// `voidbase deploy --remove --preview <branch>` the deploy takes the Worker and its resources down and this plugin
// turns the comment into "removed". On a production deploy with VOIDBASE_PREVIEW_PRUNE=1 it removes every preview
// whose pull request is merged or closed, which is how a preview disappears on merge.
//
// The pull request needs a token and a repository: VOIDBASE_GH_TOKEN (contents: read, pull requests: write) and
// VOIDBASE_PROJECT_REPO (owner/name), else the checkout's origin remote. Workers Builds sets no repository variable
// (the ones it sets, per developers.cloudflare.com/workers/ci-cd/builds/configuration/#environment-variables, are
// CI, WORKERS_CI, WORKERS_CI_BUILD_UUID, WORKERS_CI_COMMIT_SHA and WORKERS_CI_BRANCH), so `voidbase sync --previews`
// stores the repository on the trigger.
import { destroyInstance, workersSubdomain, type CfApi, type DestroyResult } from "../../cloud/rest";
import { PREVIEW_OF_VAR, PREVIEW_VAR, previewPrefix, previewWorkerName, previews, type PreviewShape } from "../../server/plugins/previews";
import { PREVIEW_HEADER, PREVIEW_PARAM } from "../../server/records/preview";
import { VERSION } from "../../server/version";
import type { DeployContext, DeployPlugin } from "../deploy-plugin";
import { call, canBackup, listBackups, normalizeUrl, short, signIn } from "../migrate";
import { repoFromGit } from "../sync";

export { branchHash, branchSlug, previewPrefix, previewWorkerName } from "../../server/plugins/previews";
export type { PreviewShape } from "../../server/plugins/previews";

/** the knob: the same name as the var it bakes; `--preview <branch>` is its flag form, WORKERS_CI_BRANCH its CI source */
export const PREVIEW_KNOB = PREVIEW_VAR;
/** what the preview is seeded with: `schema` (default), `data`, or `none` (`0`, `off`) */
export const SEED_KNOB = "VOIDBASE_PREVIEW_SEED";
/** where production answers, when it is not `https://<production>.<subdomain>.workers.dev` (a custom domain, say) */
export const SOURCE_URL_KNOB = "VOIDBASE_PREVIEW_SOURCE_URL";
/** `1` on the production build: every production deploy removes the previews whose pull request is merged or closed */
export const PRUNE_KNOB = "VOIDBASE_PREVIEW_PRUNE";
/** the GitHub token the pull request comment and the prune need */
export const GH_TOKEN_KNOB = "VOIDBASE_GH_TOKEN";
/** the repository, owner/name; the checkout's origin remote when unset */
export const REPO_KNOB = "VOIDBASE_PROJECT_REPO";
/** the branch variable Workers Builds sets in every build */
export const CI_BRANCH_VAR = "WORKERS_CI_BRANCH";
/** which shape a preview takes: `instance` (the default, a Worker of its own) or `flagged` (a lane on production) */
export const SHAPE_KNOB = "VOIDBASE_PREVIEW_SHAPE";
/** the mark that makes the comment ours to update, never to duplicate */
export const MARKER = "<!-- voidbase-preview -->";
export type SeedKind = "schema" | "data" | "none";
/** the shape the flag or the knob names; unset means an instance of its own, so nothing changes for anyone */
export function shapeOf(env: Record<string, string | undefined>, flag?: string): PreviewShape {
  const raw = (flag ?? env[SHAPE_KNOB] ?? "").trim().toLowerCase();
  if (!raw || raw === "instance") return "instance";
  if (raw === "flagged") return "flagged";
  throw new Error(`--shape ${raw} is not one of instance, flagged (${SHAPE_KNOB})`);
}
const SEED_TIMEOUT_MS = 120_000;
const REACH_TIMEOUT_MS = 60_000;

const on = (v: string | undefined) => v !== undefined && ["1", "true", "on", "yes"].includes(v.trim().toLowerCase());

/** the seed kind the knob names; unset means schema */
export function seedKindOf(env: Record<string, string | undefined>): SeedKind {
  const raw = (env[SEED_KNOB] ?? "").trim().toLowerCase();
  if (!raw || raw === "schema") return "schema";
  if (raw === "data") return "data";
  if (["0", "none", "off", "false", "no"].includes(raw)) return "none";
  throw new Error(`${SEED_KNOB}=${raw} is not one of schema, data, none`);
}

// ---- GitHub: the pull request and its one comment ---------------------------------------------------------------
export interface GitHubTarget { token: string; repo: string; api: string }
export interface PullRequest { number: number; state: "open" | "closed"; merged: boolean; html_url: string; head: string }

/** the token and the repository the environment names, or null when either is missing; the API base honours GITHUB_API_URL */
export function githubOf(env: Record<string, string | undefined>, cwd = "."): GitHubTarget | null {
  const token = (env[GH_TOKEN_KNOB] ?? "").trim(); if (!token) return null;
  const repo = (env[REPO_KNOB] ?? "").trim() || repoFromGit(cwd) || "";
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) return null;
  return { token, repo, api: (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "") };
}

async function gh<T>(t: GitHubTarget, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${t.api}${path}`, { method, headers: { authorization: `Bearer ${t.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "voidbase-previews", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

/** the pull requests whose head is the branch, open ones first, newest first */
export async function pullRequestsFor(t: GitHubTarget, branch: string): Promise<PullRequest[]> {
  const owner = t.repo.split("/")[0]!;
  const list = await gh<{ number: number; state: string; merged_at: string | null; html_url: string; head?: { ref?: string } }[]>(t, "GET", `/repos/${t.repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&sort=updated&direction=desc&per_page=20`);
  return list.filter((p) => !p.head?.ref || p.head.ref === branch).map((p): PullRequest => ({ number: p.number, state: p.state === "open" ? "open" : "closed", merged: !!p.merged_at, html_url: p.html_url, head: p.head?.ref ?? branch })).sort((a, b) => (a.state === b.state ? 0 : a.state === "open" ? -1 : 1));
}

/** what a preview's pull requests say about the preview: keep it while one is open, remove it once they are all merged or closed */
export function pruneDecision(prs: Pick<PullRequest, "state" | "merged">[]): "keep" | "remove" | "no pull request" {
  if (!prs.length) return "no pull request";
  return prs.some((p) => p.state === "open") ? "keep" : "remove";
}

export interface CommentInput { branch: string; url: string | null; of: string; seed: SeedKind; seeded: boolean | string; version?: string; at?: string; removed?: boolean; shape?: PreviewShape }
/** the comment's body: the marker first, then the address, what it was seeded with, and the version */
export function previewComment(o: CommentInput): string {
  const at = o.at ?? new Date().toISOString(); const version = o.version ?? VERSION;
  if ((o.shape ?? "instance") === "flagged") return flaggedComment(o, at, version);
  if (o.removed) return `${MARKER}\n**voidbase preview** for \`${o.branch}\`: removed ${at}. The Worker, its database, its bucket and its queue are gone; a push to the branch makes a new one.`;
  const seed = o.seed === "none" ? "not seeded" : o.seeded === true ? `seeded from \`${o.of}\` (${o.seed})` : `seeding from \`${o.of}\` (${o.seed}) failed${typeof o.seeded === "string" ? `: ${o.seeded}` : ""}`;
  const where = o.url ? `${o.url}\n\n- REST API: ${o.url}/api/\n- Dashboard: ${o.url}/_/` : "no workers.dev address (enable the subdomain on the account)";
  return `${MARKER}\n**voidbase preview** for \`${o.branch}\`: ${where}\n- ${seed}\n- voidbase ${version}, updated ${at}\n\nThe preview goes when the pull request is merged or closed (\`voidbase previews prune --merged\`, which the production build runs with \`${PRUNE_KNOB}=1\`).`;
}

/** the flagged shape's comment: the same address as production, with the branch on it, and what the shape cannot do */
function flaggedComment(o: CommentInput, at: string, version: string): string {
  const head = `${MARKER}\n**voidbase preview** for \`${o.branch}\` (flagged, on \`${o.of}\`)`;
  if (o.removed) return `${head}: removed ${at}. The branch's rows are gone from \`${o.of}\`; a write carrying \`${PREVIEW_HEADER}: ${o.branch}\` makes new ones.`;
  const q = `${PREVIEW_PARAM}=${encodeURIComponent(o.branch)}`;
  const where = o.url
    ? `${flaggedAddress(o.url, o.branch)}\n\n- REST API: ${o.url}/api/ with \`?${q}\`, or the header \`${PREVIEW_HEADER}: ${o.branch}\` on any request\n- Dashboard: ${o.url}/_/ (production's rows; the branch's are behind the header)`
    : `no address for \`${o.of}\` (set ${SOURCE_URL_KNOB})`;
  return `${head}: ${where}\n- no Worker, database, bucket or queue of its own: the branch writes to \`${o.of}\` with a mark, and production reads filter the marked rows out\n- a write to a row \`${o.of}\` already has is refused, not previewed: this shape isolates new rows and cannot isolate a change to an existing one\n- voidbase ${version}, updated ${at}\n\nThe branch's rows go when the pull request is merged or closed (\`voidbase previews prune --merged --shape flagged\`, which the production build runs with \`${PRUNE_KNOB}=1\` and \`${SHAPE_KNOB}=flagged\`).`;
}

/** where a flagged preview answers: production's own address with the branch on it, which is all the asset layer allows */
export const flaggedAddress = (url: string, branch: string): string => `${url.replace(/\/$/, "")}/?${PREVIEW_PARAM}=${encodeURIComponent(branch)}`;

/** the one comment marked as ours on the pull request, created the first time and updated after; never a second one */
export async function upsertPreviewComment(t: GitHubTarget, number: number, body: string): Promise<{ id: number; created: boolean }> {
  const existing = await findPreviewComment(t, number);
  if (existing) { await gh(t, "PATCH", `/repos/${t.repo}/issues/comments/${existing.id}`, { body }); return { id: existing.id, created: false }; }
  const made = await gh<{ id: number }>(t, "POST", `/repos/${t.repo}/issues/${number}/comments`, { body });
  return { id: made.id, created: true };
}
export async function findPreviewComment(t: GitHubTarget, number: number): Promise<{ id: number; body: string } | null> {
  for (let page = 1; page < 20; page++) {
    const list = await gh<{ id: number; body?: string }[]>(t, "GET", `/repos/${t.repo}/issues/${number}/comments?per_page=100&page=${page}`);
    const hit = list.find((c) => (c.body ?? "").includes(MARKER));
    if (hit) return { id: hit.id, body: hit.body ?? "" };
    if (list.length < 100) return null;
  }
  return null;
}

/** post or update the comment for the branch's open pull request; says what it did, or why not */
export async function commentOnPullRequest(t: GitHubTarget | null, branch: string, body: string, opts: { onlyUpdate?: boolean } = {}): Promise<string> {
  if (!t) return `pull request: not commented (set ${GH_TOKEN_KNOB}, and ${REPO_KNOB} when the checkout has no GitHub origin)`;
  const prs = await pullRequestsFor(t, branch);
  const pr = prs[0];
  if (!pr) return `pull request: none for ${branch} in ${t.repo} yet; the next deploy of the branch comments once one is open`;
  if (opts.onlyUpdate) {
    const existing = await findPreviewComment(t, pr.number);
    if (!existing) return `pull request #${pr.number}: no preview comment to update`;
    await gh(t, "PATCH", `/repos/${t.repo}/issues/comments/${existing.id}`, { body });
    return `pull request #${pr.number}: preview comment updated (${pr.html_url})`;
  }
  const r = await upsertPreviewComment(t, pr.number, body);
  return `pull request #${pr.number}: preview comment ${r.created ? "posted" : "updated"} (${pr.html_url})`;
}

// ---- seeding: a backup on production, restored on the preview, over HTTP alone ---------------------------------
export interface SeedOptions { source: string; target: string; email: string; password: string; kind: Exclude<SeedKind, "none">; log?: (l: string) => void; timeoutMs?: number; reachTimeoutMs?: number }

/** sign in on the preview, which may still be propagating right after its upload: retried for a minute */
async function reach(side: { url: string; email: string; password: string }, label: string, budgetMs: number): Promise<string> {
  const deadline = Date.now() + budgetMs; let last = "";
  for (;;) {
    try { return await signIn(side, label); } catch (e) { last = e instanceof Error ? e.message : String(e); }
    if (Date.now() >= deadline) throw new Error(last);
    await Bun.sleep(2000);
  }
}

/** a `schema` (or `data`) archive taken on production, uploaded to the preview and restored there with createMissing; the archive is deleted on both sides */
export async function seedPreview(o: SeedOptions): Promise<{ name: string; restored: string[] }> {
  const log = o.log ?? (() => undefined); const timeout = o.timeoutMs ?? SEED_TIMEOUT_MS;
  const from = normalizeUrl(o.source), to = normalizeUrl(o.target);
  const fromToken = await signIn({ url: from, email: o.email, password: o.password }, "production");
  const toToken = await reach({ url: to, email: o.email, password: o.password }, "preview", o.reachTimeoutMs ?? REACH_TIMEOUT_MS);
  const name = `preview_seed_${new Date().toISOString().replace(/[-:.tz]/gi, "").slice(0, 14)}.zip`;
  const create = await call(from, "POST", "/api/backups", { token: fromToken, json: { name, kind: o.kind } });
  if (create.status !== 204) throw new Error(`POST ${from}/api/backups: ${short(create)}`);
  let listed = false;
  for (const started = Date.now(); !listed && Date.now() - started < timeout; ) { listed = (await listBackups(from, fromToken)).includes(name); if (!listed) await Bun.sleep(500); }
  if (!listed) throw new Error(`production did not list ${name} within ${timeout / 1000}s`);
  const ft = await call(from, "POST", "/api/files/token", { token: fromToken });
  if (ft.status !== 200 || typeof ft.json.token !== "string") throw new Error(`POST ${from}/api/files/token: ${short(ft)}`);
  const dl = await fetch(`${from}/api/backups/${encodeURIComponent(name)}?token=${encodeURIComponent(ft.json.token)}`);
  if (!dl.ok) throw new Error(`GET ${from}/api/backups/${name}: ${dl.status}`);
  const bytes = new Uint8Array(await dl.arrayBuffer());
  const fd = new FormData(); fd.set("file", new File([bytes as BlobPart], name, { type: "application/zip" }), name);
  const up = await call(to, "POST", "/api/backups/upload", { token: toToken, body: fd });
  if (up.status !== 204) throw new Error(`POST ${to}/api/backups/upload: ${short(up)}`);
  const rs = await call(to, "POST", `/api/backups/${encodeURIComponent(name)}/restore`, { token: toToken, json: { createMissing: true } });
  if (rs.status !== 204) throw new Error(`POST ${to}/api/backups/${name}/restore: ${short(rs)}`);
  // the restore runs in the background behind the lock /api/health shows as canBackup; a data restore keeps the
  // preview's superusers (never a system collection), so the preview's own token stays good
  let done = false;
  for (const started = Date.now(); !done && Date.now() - started < timeout; ) { await Bun.sleep(500); done = (await canBackup(to, toToken)) === true; }
  if (!done) throw new Error(`the preview did not finish restoring ${name} within ${timeout / 1000}s`);
  const list = await call(to, "GET", "/api/backups", { token: toToken });
  const entry = ((list.json as unknown as { key: string; restore?: { restored?: string[] } }[]) ?? []).find((b) => b.key === name);
  const restored = entry?.restore?.restored ?? [];
  await call(from, "DELETE", `/api/backups/${encodeURIComponent(name)}`, { token: fromToken });
  await call(to, "DELETE", `/api/backups/${encodeURIComponent(name)}`, { token: toToken });
  log(`seeded ${to} from ${from} (${o.kind}: ${restored.length ? restored.join(", ") : "nothing to restore"})`);
  return { name, restored };
}

// ---- the previews on the account: listing, taking one down, pruning ---------------------------------------------
export interface PreviewInfo { name: string; branch: string | null; of: string | null; url: string | null; created: string | null; modified: string | null }

/** the Workers named `<production>-pr-*` on the account, with the branch each was deployed for (read from its vars) */
export async function listPreviews(api: CfApi, account: string, production: string): Promise<PreviewInfo[]> {
  const prefix = previewPrefix(production);
  const r = await api.json<{ id: string; created_on?: string; modified_on?: string }[]>("GET", `/accounts/${account}/workers/scripts`);
  const sub = await workersSubdomain(api, account);
  const out: PreviewInfo[] = [];
  for (const s of (r.result ?? []).filter((s) => s.id.startsWith(prefix)).sort((a, b) => a.id.localeCompare(b.id))) {
    const vars = await workerVars(api, account, s.id);
    out.push({ name: s.id, branch: vars[PREVIEW_VAR] ?? null, of: vars[PREVIEW_OF_VAR] ?? null, url: sub ? `https://${s.id}.${sub}.workers.dev` : null, created: s.created_on ?? null, modified: s.modified_on ?? null });
  }
  return out;
}
/** the plain-text vars of a Worker, from its settings' bindings */
async function workerVars(api: CfApi, account: string, name: string): Promise<Record<string, string>> {
  try {
    const r = await api.json<{ bindings?: { type?: string; name?: string; text?: string }[] }>("GET", `/accounts/${account}/workers/scripts/${name}/settings`);
    return Object.fromEntries((r.result?.bindings ?? []).filter((b) => b.type === "plain_text" && b.name && typeof b.text === "string").map((b) => [b.name!, b.text!]));
  } catch { return {}; }
}

/** the preview's Worker, database, bucket and queue deleted, and its comment turned into "removed" */
export async function takeDownPreview(o: { api: CfApi; account: string; name: string; branch: string; of: string; github: GitHubTarget | null; log: (l: string) => void }): Promise<DestroyResult> {
  const out = await destroyInstance(o.api, { account: o.account, name: o.name, log: (l) => o.log(`  ${l}`) });
  if (out.errors.length) throw new Error(`removing the preview ${o.name}: ${out.errors.join("; ")}`);
  o.log(`preview ${o.name} (${o.branch}) removed: ${out.deleted.length} deleted, ${out.skipped.length} not there`);
  try { o.log(await commentOnPullRequest(o.github, o.branch, previewComment({ branch: o.branch, url: null, of: o.of, seed: "none", seeded: false, removed: true }), { onlyUpdate: true })); }
  catch (e) { o.log(`pull request: comment not updated (${e instanceof Error ? e.message : e})`); }
  return out;
}

/** every preview of the production Worker whose pull request is merged or closed is taken down; the rest are reported */
export async function pruneMerged(o: { api: CfApi; account: string; production: string; github: GitHubTarget | null; dryRun?: boolean; log: (l: string) => void }): Promise<{ removed: string[]; kept: string[] }> {
  const list = await listPreviews(o.api, o.account, o.production);
  const removed: string[] = [], kept: string[] = [];
  if (!list.length) { o.log(`previews of ${o.production}: none`); return { removed, kept }; }
  if (!o.github) { o.log(`previews of ${o.production}: ${list.length} found, none pruned (set ${GH_TOKEN_KNOB}, and ${REPO_KNOB} when the checkout has no GitHub origin, to read their pull requests)`); return { removed, kept: list.map((p) => p.name) }; }
  for (const p of list) {
    if (!p.branch) { kept.push(p.name); o.log(`preview ${p.name}: kept, its branch is not known (no ${PREVIEW_VAR} var)`); continue; }
    const prs = await pullRequestsFor(o.github, p.branch); const decision = pruneDecision(prs);
    if (decision !== "remove") { kept.push(p.name); o.log(`preview ${p.name} (${p.branch}): kept, ${decision === "keep" ? `pull request #${prs[0]!.number} is open` : "no pull request yet"}`); continue; }
    const pr = prs[0]!;
    if (o.dryRun) { o.log(`dry run: would remove the preview ${p.name} (${p.branch}): pull request #${pr.number} is ${pr.merged ? "merged" : "closed"}`); removed.push(p.name); continue; }
    o.log(`preview ${p.name} (${p.branch}): pull request #${pr.number} is ${pr.merged ? "merged" : "closed"}, removing it`);
    await takeDownPreview({ api: o.api, account: o.account, name: p.name, branch: p.branch, of: p.of ?? o.production, github: o.github, log: o.log });
    removed.push(p.name);
  }
  return { removed, kept };
}

// ---- the flagged shape: a lane on production, reached over HTTP ------------------------------------------------
// Nothing is created here, because nothing is created at all: the branch's lane comes into being on its first
// flagged write, and it goes when its rows do. What the deploy half has to do is say where the preview answers
// (production's address with the branch on it) and keep the pull request comment true.
export interface FlaggedTarget { url: string; email: string; password: string }
export interface FlaggedRemoval { branch: string; rows: number; deleted: Record<string, number> }

/** the branch's rows taken away through the instance's own route (the previews plugin mounts it) */
export async function removeFlaggedRows(t: FlaggedTarget, branch: string): Promise<FlaggedRemoval> {
  const url = normalizeUrl(t.url);
  const token = await signIn({ url, email: t.email, password: t.password }, "production");
  const r = await call(url, "DELETE", `/api/previews?branch=${encodeURIComponent(branch)}`, { token });
  if (r.status !== 200) throw new Error(`DELETE ${url}/api/previews?branch=${branch}: ${short(r)}`);
  const out = r.json as unknown as FlaggedRemoval;
  return { branch, rows: Number(out?.rows ?? 0), deleted: out?.deleted ?? {} };
}

/** the branches that have rows on the instance right now, as GET /api/previews reports them */
export async function listFlagged(t: FlaggedTarget): Promise<{ branch: string; rows: number; collections: string[] }[]> {
  const url = normalizeUrl(t.url);
  const token = await signIn({ url, email: t.email, password: t.password }, "production");
  const r = await call(url, "GET", "/api/previews", { token });
  if (r.status !== 200) throw new Error(`GET ${url}/api/previews: ${short(r)}`);
  return ((r.json as unknown as { branches?: { branch: string; rows: number; collections: string[] }[] })?.branches) ?? [];
}

/** `voidbase deploy --preview <branch> --shape flagged`: no upload, no resource, the address on the pull request */
export async function flaggedPreview(o: { branch: string; of: string; url: string | null; github: GitHubTarget | null; dryRun?: boolean; log: (l: string) => void }): Promise<void> {
  const where = o.url ? flaggedAddress(o.url, o.branch) : `${o.of} (address unknown: set ${SOURCE_URL_KNOB})`;
  o.log(`flagged preview of ${o.of} for branch ${o.branch}: nothing is deployed. The branch writes to ${o.of} with ${PREVIEW_HEADER}: ${o.branch}, production reads filter those rows out, and the preview answers at ${where}`);
  if (o.dryRun) { o.log(`dry run: would ${o.github ? `post the address on the pull request for ${o.branch} in ${o.github.repo}` : `not comment on the pull request (set ${GH_TOKEN_KNOB} and ${REPO_KNOB})`}`); return; }
  try { o.log(await commentOnPullRequest(o.github, o.branch, previewComment({ branch: o.branch, url: o.url, of: o.of, seed: "none", seeded: false, shape: "flagged" }))); }
  catch (e) { o.log(`pull request: not commented (${e instanceof Error ? e.message : e})`); }
}

/** `voidbase previews remove <branch> --shape flagged`: the branch's rows, and only those, and the comment updated */
export async function removeFlaggedPreview(o: { branch: string; of: string; target: FlaggedTarget; github: GitHubTarget | null; dryRun?: boolean; log: (l: string) => void }): Promise<FlaggedRemoval> {
  if (o.dryRun) { o.log(`dry run: would delete the rows marked ${o.branch} on ${o.of} and mark the preview comment as removed`); return { branch: o.branch, rows: 0, deleted: {} }; }
  const out = await removeFlaggedRows(o.target, o.branch);
  const where = Object.entries(out.deleted).map(([c, n]) => `${c}: ${n}`).join(", ");
  o.log(`flagged preview ${o.branch} on ${o.of}: ${out.rows} row(s) deleted${where ? ` (${where})` : ""}; nothing else on ${o.of} was touched`);
  try { o.log(await commentOnPullRequest(o.github, o.branch, previewComment({ branch: o.branch, url: null, of: o.of, seed: "none", seeded: false, removed: true, shape: "flagged" }), { onlyUpdate: true })); }
  catch (e) { o.log(`pull request: comment not updated (${e instanceof Error ? e.message : e})`); }
  return out;
}

/** the flagged prune: every branch with rows whose pull request is merged or closed loses them */
export async function pruneFlaggedMerged(o: { of: string; target: FlaggedTarget; github: GitHubTarget | null; dryRun?: boolean; log: (l: string) => void }): Promise<{ removed: string[]; kept: string[] }> {
  const branches = await listFlagged(o.target);
  const removed: string[] = [], kept: string[] = [];
  if (!branches.length) { o.log(`flagged previews on ${o.of}: none`); return { removed, kept }; }
  if (!o.github) { o.log(`flagged previews on ${o.of}: ${branches.length} found, none pruned (set ${GH_TOKEN_KNOB}, and ${REPO_KNOB} when the checkout has no GitHub origin, to read their pull requests)`); return { removed, kept: branches.map((b) => b.branch) }; }
  for (const b of branches.sort((x, y) => (x.branch < y.branch ? -1 : 1))) {
    const prs = await pullRequestsFor(o.github, b.branch); const decision = pruneDecision(prs);
    if (decision !== "remove") { kept.push(b.branch); o.log(`flagged preview ${b.branch} (${b.rows} row(s)): kept, ${decision === "keep" ? `pull request #${prs[0]!.number} is open` : "no pull request yet"}`); continue; }
    const pr = prs[0]!;
    if (o.dryRun) { o.log(`dry run: would delete the ${b.rows} row(s) marked ${b.branch}: pull request #${pr.number} is ${pr.merged ? "merged" : "closed"}`); removed.push(b.branch); continue; }
    o.log(`flagged preview ${b.branch}: pull request #${pr.number} is ${pr.merged ? "merged" : "closed"}, deleting its rows`);
    await removeFlaggedPreview({ branch: b.branch, of: o.of, target: o.target, github: o.github, log: o.log });
    removed.push(b.branch);
  }
  return { removed, kept };
}

// ---- the hooks ------------------------------------------------------------------------------------------------
const branchOf = (ctx: DeployContext) => (ctx.env[PREVIEW_KNOB] ?? "").trim();
const productionOf = (ctx: DeployContext) => (ctx.env[PREVIEW_OF_VAR] ?? "").trim();
const credentialsOf = (env: Record<string, string | undefined>) => ({ email: (env.VOIDBASE_SUPERUSER_EMAIL || env.PB_SUPERUSER_EMAIL || "").trim(), password: env.VOIDBASE_SUPERUSER_PASSWORD || env.PB_SUPERUSER_PASSWORD || "" });

/** where the flagged shape acts: the production instance itself, signed into as a superuser, since it has no Worker */
export async function flaggedTarget(o: { env: Record<string, string | undefined>; api: CfApi; account: string; production: string }): Promise<FlaggedTarget> {
  const url = (o.env[SOURCE_URL_KNOB] ?? "").trim() || (await workersSubdomain(o.api, o.account).then((sub) => (sub ? `https://${o.production}.${sub}.workers.dev` : "")));
  if (!url) throw new Error(`the address of ${o.production} is not known: set ${SOURCE_URL_KNOB}`);
  const { email, password } = credentialsOf(o.env);
  if (!email || !password) throw new Error(`VOIDBASE_SUPERUSER_EMAIL and VOIDBASE_SUPERUSER_PASSWORD are needed to read and write ${o.production}'s preview rows`);
  return { url, email, password };
}

export const previewsDeploy: DeployPlugin = {
  name: "previews",
  manifest: previews.manifest,
  deploy: {
    async before(ctx) {
      const branch = branchOf(ctx); if (!branch) return;
      if (shapeOf(ctx.env) === "flagged") throw new Error(`${PREVIEW_KNOB}=${branch} with ${SHAPE_KNOB}=flagged, but the flagged shape makes no Worker: the preview is a marked lane on production, so an upload here would put the branch's build on production itself. Run \`voidbase deploy --preview ${branch} --shape flagged\`, which uploads nothing and posts the address.`);
      const of = productionOf(ctx);
      if (!of) throw new Error(`${PREVIEW_KNOB}=${branch} but the deploy did not say which Worker it previews (${PREVIEW_OF_VAR}); use voidbase deploy --preview ${branch}`);
      const expected = previewWorkerName(of, branch);
      if (ctx.name !== expected) throw new Error(`the Worker is ${ctx.name}, but a preview of ${of} for ${branch} is ${expected}`);
      const seed = seedKindOf(ctx.env);
      ctx.config.workers_dev = true;
      ctx.vars[PREVIEW_VAR] = branch; ctx.vars[PREVIEW_OF_VAR] = of;
      ctx.log(`preview of ${of} for branch ${branch}: Worker ${ctx.name} on workers.dev, with its own database, bucket and queue; custom domains stay production's; ${seed === "none" ? "not seeded" : `seeded from ${of} (${seed}) after the upload`}`);
    },
    async after(ctx) {
      const branch = branchOf(ctx);
      if (!branch) {
        // a production deploy: the previews whose pull request is over go, when the build asks for it
        if (!on(ctx.env[PRUNE_KNOB]) || ctx.local || !ctx.api) return;
        if (shapeOf(ctx.env) === "flagged") {
          // the flagged prune takes rows and not Workers, so it goes through the instance that was just deployed
          const url = (ctx.env[SOURCE_URL_KNOB] ?? "").trim() || ctx.url;
          const creds = credentialsOf(ctx.env);
          if (!url || !creds.email || !creds.password) { ctx.log(`prune: the flagged prune needs the instance's address and VOIDBASE_SUPERUSER_EMAIL / VOIDBASE_SUPERUSER_PASSWORD; nothing pruned`); return; }
          try { await pruneFlaggedMerged({ of: ctx.name, target: { url, email: creds.email, password: creds.password }, github: githubOf(ctx.env), dryRun: ctx.dryRun, log: ctx.log }); }
          catch (e) { ctx.log(`prune: the flagged prune failed (${e instanceof Error ? e.message : e})`); }
          return;
        }
        await pruneMerged({ api: ctx.api, account: ctx.account.id, production: ctx.name, github: githubOf(ctx.env), dryRun: ctx.dryRun, log: ctx.log });
        return;
      }
      if (ctx.local || !ctx.api) return;
      const { api, log } = ctx; const of = productionOf(ctx); const seed = seedKindOf(ctx.env); const github = githubOf(ctx.env);
      const source = (ctx.env[SOURCE_URL_KNOB] ?? "").trim() || (await workersSubdomain(api, ctx.account.id).then((s) => (s ? `https://${of}.${s}.workers.dev` : "")));
      const creds = credentialsOf(ctx.env);
      if (ctx.dryRun) {
        log(`dry run: would ${seed === "none" ? "not seed the preview" : `seed ${ctx.name} from ${source || "production (URL unknown: set " + SOURCE_URL_KNOB + ")"} (${seed}${creds.email && creds.password ? "" : `; needs VOIDBASE_SUPERUSER_EMAIL and VOIDBASE_SUPERUSER_PASSWORD`})`}, then ${github ? `post the address on the pull request for ${branch} in ${github.repo}` : `not comment on the pull request (set ${GH_TOKEN_KNOB} and ${REPO_KNOB})`}`);
        return;
      }
      let seeded: boolean | string = seed === "none" ? false : true;
      if (seed !== "none") {
        try {
          if (!source) throw new Error(`production's URL is not known: set ${SOURCE_URL_KNOB}`);
          if (!creds.email || !creds.password) throw new Error("VOIDBASE_SUPERUSER_EMAIL and VOIDBASE_SUPERUSER_PASSWORD are needed to read production and write the preview");
          if (!ctx.url) throw new Error("the preview has no workers.dev address to seed through");
          await seedPreview({ source, target: ctx.url, email: creds.email, password: creds.password, kind: seed, log });
        } catch (e) { seeded = e instanceof Error ? e.message : String(e); log(`seed: ${seeded}; the preview is up, unseeded`); }
      }
      try { log(await commentOnPullRequest(github, branch, previewComment({ branch, url: ctx.url, of, seed, seeded }))); }
      catch (e) { log(`pull request: not commented (${e instanceof Error ? e.message : e})`); }
    },
    async remove(ctx) {
      const branch = branchOf(ctx); if (!branch || !ctx.api) return;
      const of = productionOf(ctx) || ctx.name;
      if (ctx.dryRun) { ctx.log(`dry run: would mark the preview comment on the pull request for ${branch} as removed`); return; }
      try { ctx.log(await commentOnPullRequest(githubOf(ctx.env), branch, previewComment({ branch, url: null, of, seed: "none", seeded: false, removed: true }), { onlyUpdate: true })); }
      catch (e) { ctx.log(`pull request: comment not updated (${e instanceof Error ? e.message : e})`); }
    },
  },
};
