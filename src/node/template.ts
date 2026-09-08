// `voidbase init <dir> --template <what>`: start from somebody's working project instead of an empty directory.
//
// A template is a public GitHub repository. It is fetched as a zipball rather than a tarball because fflate, which
// is already a dependency for the executable's self-update, reads zip and not tar; that keeps this from adding a
// dependency for one command.
//
// Nothing is cloned: no .git, no history, no remote pointing at somebody else's repository. What you get is the
// files, which is what "start from" should mean.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { unzipSync } from "fflate";

/** where the marketplace's accepted templates are listed, overridable for a registry of your own */
export const REGISTRY =
  process.env.VOIDBASE_TEMPLATE_REGISTRY ||
  "https://raw.githubusercontent.com/voidbase-cloud/voidbase-marketplace/master/registry/templates.json";

export interface Listed { repository: string; title: string; summary: string }

/** "owner/name", a GitHub URL, or the name of something listed in the marketplace */
export function parseRepository(input: string): string | null {
  const cleaned = input.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(cleaned);
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function listed(registry = REGISTRY): Promise<Listed[]> {
  const res = await fetch(registry, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`reading the template registry (${registry}): HTTP ${res.status}`);
  const body = (await res.json()) as { entries?: Listed[] };
  return body.entries ?? [];
}

/** A name that is not owner/name is looked up in the registry, by title or by the repository's own name. */
export async function resolveTemplate(input: string, registry = REGISTRY): Promise<{ repository: string; from: "direct" | "registry" }> {
  const direct = parseRepository(input);
  if (direct) return { repository: direct, from: "direct" };
  const wanted = input.trim().toLowerCase();
  const all = await listed(registry);
  const hit = all.find((e) => e.title.toLowerCase() === wanted || e.repository.split("/")[1]?.toLowerCase() === wanted);
  if (!hit) {
    const names = all.map((e) => e.repository).join(", ");
    throw new Error(`no template called "${input}". Give it as owner/name, or pick one of: ${names || "(the registry is empty)"}`);
  }
  return { repository: hit.repository, from: "registry" };
}

/** GitHub serves a zip of any ref here, with no authentication for a public repository */
const zipUrl = (repository: string, ref: string) => `https://codeload.github.com/${repository}/zip/${ref}`;

async function defaultBranch(repository: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repository}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "voidbase-init", ...(process.env.GH_TOKEN ? { authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) throw new Error(`no such public repository: ${repository}`);
  if (!res.ok) throw new Error(`asking GitHub about ${repository}: HTTP ${res.status}`);
  return ((await res.json()) as { default_branch?: string }).default_branch || "main";
}

/** A directory we are willing to unpack into: missing, empty, or holding nothing but the usual noise. */
export function isEmptyEnough(dir: string): boolean {
  if (!existsSync(dir)) return true;
  return readdirSync(dir).filter((f) => f !== "." && f !== ".." && f !== ".git" && f !== ".DS_Store").length === 0;
}

export interface FetchResult { repository: string; ref: string; files: number }

export async function fetchTemplate(input: string, dir: string, o: { ref?: string; registry?: string; log?: (l: string) => void } = {}): Promise<FetchResult> {
  const log = o.log ?? (() => undefined);
  const { repository, from } = await resolveTemplate(input, o.registry);
  log(`template ${repository}${from === "registry" ? " (from the registry)" : ""}`);

  const target = resolve(dir);
  if (!isEmptyEnough(target)) throw new Error(`${target} is not empty. Starting from a template writes a whole project, so it wants an empty directory.`);

  const ref = o.ref ?? (await defaultBranch(repository));
  const res = await fetch(zipUrl(repository, ref), { headers: { "user-agent": "voidbase-init" }, redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`downloading ${repository} at ${ref}: HTTP ${res.status}`);
  const zip = new Uint8Array(await res.arrayBuffer());
  log(`downloaded ${(zip.byteLength / 1024).toFixed(0)} kB`);

  const entries = unzipSync(zip);
  mkdirSync(target, { recursive: true });
  let files = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    // GitHub wraps everything in "<repo>-<ref>/", which is an artefact of the download rather than part of the template
    const rel = name.slice(name.indexOf("/") + 1);
    if (!rel || rel.endsWith("/")) continue;
    const out = join(target, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes);
    files++;
  }
  return { repository, ref, files };
}
