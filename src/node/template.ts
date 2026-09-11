// `voidbase init [dir] --template <name|owner/name>` and `voidbase templates`: start from somebody's working project
// instead of an empty directory.
//
// A template is a public GitHub repository. The marketplace lists some of them in its index (docs/registry.md,
// `templates`), so a listed one is asked for by name; any other is asked for as owner/name. Either way the files come
// from GitHub's tarball of one ref, unpacked with the system tar, which Linux, macOS and Windows 10 and later ship.
//
// Nothing is cloned: no .git, no history, no remote pointing at somebody else's repository. What you get is the
// files, which is what "start from" should mean. The next steps are read from the files themselves.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { marketplacesFor, readLock } from "./installed";
import { fetchIndex, type TemplateListing } from "./registry";

/** a template as the CLI shows it: the listing plus the marketplace that lists it */
export interface Template { name: string; repository: string; title: string; summary: string; marketplace: string }

/** the name a listing is asked for by: its own, else the repository's name (owner/<name>) */
export const nameOf = (t: TemplateListing): string => t.name ?? t.repository.split("/")[1] ?? t.repository;

/** the marketplaces to list templates from, chosen the way plugins choose them: --marketplace, then the env, then the lockfile */
export const templateMarketplaces = (one?: string, env: Record<string, string | undefined> = process.env, root = process.cwd()): string[] =>
  marketplacesFor(readLock(root), env, one);

/** "owner/name" or a GitHub URL; anything else is a name to look up in the index */
export function parseRepository(input: string): string | null {
  const cleaned = input.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(cleaned);
  return m ? `${m[1]}/${m[2]}` : null;
}

export interface Listed { templates: Template[]; problems: string[] }

/** every template the marketplaces list; a marketplace that cannot be read is a problem to show, not a reason to stop */
export async function listTemplates(marketplaces: string[], fetchImpl: typeof fetch = fetch): Promise<Listed> {
  const templates: Template[] = []; const problems: string[] = [];
  for (const m of marketplaces) {
    try {
      const { index } = await fetchIndex(m, fetchImpl);
      for (const t of index.templates ?? []) templates.push({ name: nameOf(t), repository: t.repository, title: t.title, summary: t.summary, marketplace: m });
    } catch (err) { problems.push(err instanceof Error ? err.message : String(err)); }
  }
  return { templates, problems };
}

export interface Resolved { repository: string; listed?: Template }

/** owner/name as given; a bare name through the index, by name or title, case-insensitive; two marketplaces serving one name is refused */
export async function resolveTemplate(input: string, marketplaces: string[], fetchImpl: typeof fetch = fetch): Promise<Resolved> {
  const direct = parseRepository(input);
  if (direct) return { repository: direct };
  const wanted = input.trim().toLowerCase();
  if (!wanted) throw new Error("which template? A name from voidbase templates, or owner/name on GitHub");
  const { templates, problems } = await listTemplates(marketplaces, fetchImpl);
  const hits = templates.filter((t) => t.name.toLowerCase() === wanted || t.title.toLowerCase() === wanted);
  if (hits.length > 1) throw new Error(`${input} is listed by ${hits.map((h) => h.marketplace).join(" and ")}; say which: --marketplace <url>`);
  if (!hits[0]) {
    const names = templates.map((t) => t.name).join(", ");
    throw new Error(`no template called "${input}" on ${marketplaces.join(", ") || "any marketplace"}. Give it as owner/name, or pick one of: ${names || "(nothing is listed)"}${problems.length ? `\n  ${problems.join("\n  ")}` : ""}`);
  }
  return { repository: hits[0].repository, listed: hits[0] };
}

const github = (extra: Record<string, string> = {}) => ({ "user-agent": "voidbase-init", ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}), ...extra });

/** GitHub answers 404 for a private repository and for a missing one alike, so the message says both */
const notPublic = (repository: string) => `GitHub has no public repository called ${repository}: it is private, or it does not exist (GitHub answers the same for both)`;

/** the branch GitHub serves by default, which is what a template is started from when no --ref says otherwise */
export async function defaultBranch(repository: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`https://api.github.com/repos/${repository}`, { headers: github({ accept: "application/vnd.github+json" }), signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) throw new Error(notPublic(repository));
  if (!res.ok) throw new Error(`asking GitHub about ${repository}: HTTP ${res.status}`);
  return ((await res.json()) as { default_branch?: string }).default_branch || "main";
}

/** GitHub serves a tarball of any ref here, with no authentication for a public repository */
export const tarballUrl = (repository: string, ref: string): string => `https://codeload.github.com/${repository}/tar.gz/${ref}`;

/** the system tar, or where to get one; the one dependency this command has outside the package */
export const tarMissing = (): string | null =>
  Bun.which("tar") ? null : "tar was not found on PATH. A template is unpacked with the system tar, which Linux, macOS and Windows 10 and later ship; install it or put it on PATH";

/** a directory a template may be written into: absent, or existing and empty */
export function isEmpty(dir: string): boolean {
  if (!existsSync(dir)) return true;
  return readdirSync(dir).length === 0;
}

/** the tarball's top-level directory (`<name>-<ref>/`) is an artefact of the download, not part of the template */
export async function extractTarball(tgz: string, dir: string): Promise<void> {
  const missing = tarMissing(); if (missing) throw new Error(missing);
  mkdirSync(dir, { recursive: true });
  const p = Bun.spawn(["tar", "-xzf", tgz, "-C", dir, "--strip-components=1"], { stdout: "ignore", stderr: "pipe" });
  const code = await p.exited;
  if (code !== 0) throw new Error(`tar could not unpack the template: ${(await new Response(p.stderr).text()).trim() || `exit ${code}`}`);
}

/** how many files were written, for the one line that says what was made */
export function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
  return n;
}

/**
 * The next steps, read from what the template is: a voidbase stack app (void.json) installs and runs its dev
 * server; a PocketBase layout (pb_hooks or pb_data) serves; a package with scripts installs, and runs `dev` when it
 * has one. A template that is none of these is left to its README.
 */
export function nextSteps(dir: string): string[] {
  const steps: string[] = [];
  const has = (f: string) => existsSync(join(dir, f));
  let scripts: Record<string, string> = {};
  if (has("package.json")) { try { scripts = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}; } catch { scripts = {}; } }
  if (has("void.json")) steps.push("bun install", "bun run dev");
  else if (Object.keys(scripts).length) { steps.push("bun install"); if (scripts.dev) steps.push("bun run dev"); }
  if (has("pb_hooks") || has("pb_data")) steps.push("voidbase serve");
  return steps.length ? [...new Set(steps)] : ["read its README"];
}

export interface FetchOptions { ref?: string; marketplaces?: string[]; fetchImpl?: typeof fetch; log?: (line: string) => void }
export interface Fetched { repository: string; ref: string; dir: string; files: number; next: string[]; listed?: Template }

/** the whole command: resolve, check the directory, find the ref, download, unpack, drop any .git, read the next steps */
export async function fetchTemplate(input: string, dir: string | undefined, o: FetchOptions = {}): Promise<Fetched> {
  const fetchImpl = o.fetchImpl ?? fetch; const log = o.log ?? (() => undefined);
  const missing = tarMissing(); if (missing) throw new Error(missing);
  const { repository, listed } = await resolveTemplate(input, o.marketplaces ?? templateMarketplaces(), fetchImpl);
  log(`template ${repository}${listed ? ` (${listed.name}, listed by ${listed.marketplace})` : ""}`);

  const target = resolve(dir ?? repository.split("/")[1]!);
  if (!isEmpty(target)) throw new Error(`${target} is not empty. A template is a whole project, so it goes into an empty or absent directory`);

  const ref = o.ref ?? (await defaultBranch(repository, fetchImpl));
  const res = await fetchImpl(tarballUrl(repository, ref), { headers: github(), redirect: "follow", signal: AbortSignal.timeout(120_000) });
  if (res.status === 404) throw new Error(o.ref ? `GitHub has no ${ref} in ${repository}, or the repository is private or missing (GitHub answers 404 for all three)` : notPublic(repository));
  if (!res.ok) throw new Error(`downloading ${repository} at ${ref}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  log(`downloaded ${ref} (${(bytes.byteLength / 1024).toFixed(0)} kB)`);

  const scratch = mkdtempSync(join(tmpdir(), "voidbase-template-"));
  try {
    const tgz = join(scratch, "template.tar.gz");
    writeFileSync(tgz, bytes);
    await extractTarball(tgz, target);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  rmSync(join(target, ".git"), { recursive: true, force: true });
  return { repository, ref, dir: target, files: countFiles(target), next: nextSteps(target), listed };
}
