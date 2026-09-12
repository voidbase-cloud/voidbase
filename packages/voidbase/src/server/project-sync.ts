// A project's plugins, changed by one commit to its repository.
//
// An instance deployed from a repository (voidbase.cloud's project instances, the demo, any app whose pipeline is a
// push) holds its plugins there, in pb_plugins/ and voidbase.lock, exactly as `voidbase plugins add` writes them.
// The installer core plugin (plugins/installer.ts) turns a request into that commit, through GitHub's Git Data
// API: the bundle is downloaded and verified here, pb_plugins/<name>/{bundle.js,release.json} are written or
// deleted, the lockfile entry is added or removed, one commit, and the repository's own build deploys it. Plain
// fetch, so it runs on Workers and on Bun alike.
import type { PluginVersion } from "../node/registry";

export const PLUGINS_DIR = "pb_plugins";
export const LOCKFILE = "voidbase.lock";
const DEFAULT_MARKETPLACES = ["https://marketplace.voidbase.cloud"];

/** voidbase.lock as src/node/installed.ts writes it; the writer there sorts the same way */
export interface LockEntry { version: string; integrity: string; marketplace: string; source: { repository: string; commit: string }; installedOn: string }
export interface Lock { lockfileVersion: 1; marketplaces: string[]; plugins: Record<string, LockEntry>; disabled: string[] }
export const emptyLock = (): Lock => ({ lockfileVersion: 1, marketplaces: [...DEFAULT_MARKETPLACES], plugins: {}, disabled: [] });
export const parseLock = (text: string): Lock => {
  const raw = JSON.parse(text) as Partial<Lock>;
  if (raw.lockfileVersion !== 1) throw new Error(`${LOCKFILE}: lockfileVersion ${JSON.stringify(raw.lockfileVersion)} is not one this voidbase reads`);
  return { lockfileVersion: 1, marketplaces: raw.marketplaces ?? [...DEFAULT_MARKETPLACES], plugins: raw.plugins ?? {}, disabled: raw.disabled ?? [] };
};
export const lockText = (lock: Lock): string => `${JSON.stringify({ ...lock, plugins: Object.fromEntries(Object.entries(lock.plugins).sort(([a], [b]) => a.localeCompare(b))), disabled: [...new Set(lock.disabled)].sort() }, null, 2)}\n`;

export interface Repo { token: string; fullName: string; branch: string; api?: string }
const b64 = (bytes: Uint8Array): string => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const fromB64 = (s: string): string => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), (ch) => ch.charCodeAt(0)));

async function gh<T>(repo: Repo, method: string, path: string, body?: unknown, tolerate: number[] = []): Promise<{ status: number; data: T }> {
  const res = await fetch(`${(repo.api ?? "https://api.github.com").replace(/\/$/, "")}${path}`, { method, headers: { authorization: `Bearer ${repo.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "voidbase", ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data: unknown = null; try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
  if (!res.ok && !tolerate.includes(res.status)) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(data as { message?: string } | null)?.message ?? ""}`.trim());
  return { status: res.status, data: data as T };
}

/** the repository's lockfile at the head of its branch: what the project really runs */
export async function lockOf(repo: Repo): Promise<Lock> {
  const f = await gh<{ content?: string }>(repo, "GET", `/repos/${repo.fullName}/contents/${LOCKFILE}?ref=${encodeURIComponent(repo.branch)}`, undefined, [404]);
  return f.status === 404 ? emptyLock() : parseLock(fromB64(String(f.data.content ?? "")));
}

export interface PluginChange { add: { name: string; version: PluginVersion; marketplace: string; bytes: Uint8Array }[]; remove: string[] }
export interface Committed { sha: string; url: string; branch: string; lock: Lock }

/** the commit message `voidbase plugins` would leave, had it committed */
export const pluginsMessage = (change: PluginChange): string =>
  `plugins: ${[...change.add.map((a) => `add ${a.name} ${a.version.version}`), ...change.remove.map((n) => `remove ${n}`)].join(", ")}`;

/**
 * One commit on the branch: pb_plugins/<name>/{bundle.js,release.json} written or deleted and voidbase.lock updated
 * the way `voidbase plugins add|remove` would. Returns the commit and the lock it wrote.
 */
export async function commitPlugins(repo: Repo, change: PluginChange, message = pluginsMessage(change)): Promise<Committed> {
  const full = repo.fullName;
  const head = await gh<{ object: { sha: string } }>(repo, "GET", `/repos/${full}/git/ref/heads/${repo.branch}`);
  const headSha = head.data.object.sha;
  const commit = await gh<{ tree: { sha: string } }>(repo, "GET", `/repos/${full}/git/commits/${headSha}`);
  const lockFile = await gh<{ content?: string }>(repo, "GET", `/repos/${full}/contents/${LOCKFILE}?ref=${headSha}`, undefined, [404]);
  const lock = lockFile.status === 404 ? emptyLock() : parseLock(fromB64(String(lockFile.data.content ?? "")));
  const tree: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = [];
  const blob = async (content: string, encoding: "utf-8" | "base64") => (await gh<{ sha: string }>(repo, "POST", `/repos/${full}/git/blobs`, { content, encoding })).data.sha;
  for (const name of change.remove) {
    const dir = await gh<{ path: string; type: string }[]>(repo, "GET", `/repos/${full}/contents/${PLUGINS_DIR}/${name}?ref=${headSha}`, undefined, [404]);
    if (dir.status !== 404 && Array.isArray(dir.data)) for (const f of dir.data) if (f.type === "file") tree.push({ path: f.path, mode: "100644", type: "blob", sha: null });
    delete lock.plugins[name];
  }
  for (const a of change.add) {
    tree.push({ path: `${PLUGINS_DIR}/${a.name}/bundle.js`, mode: "100644", type: "blob", sha: await blob(b64(a.bytes), "base64") });
    tree.push({ path: `${PLUGINS_DIR}/${a.name}/release.json`, mode: "100644", type: "blob", sha: await blob(`${JSON.stringify(a.version, null, 2)}\n`, "utf-8") });
    lock.plugins[a.name] = { version: a.version.version, integrity: a.version.integrity, marketplace: a.marketplace, source: a.version.source, installedOn: new Date().toISOString().slice(0, 10) };
    lock.disabled = lock.disabled.filter((d) => d !== a.name);
  }
  tree.push({ path: LOCKFILE, mode: "100644", type: "blob", sha: await blob(lockText(lock), "utf-8") });
  const newTree = await gh<{ sha: string }>(repo, "POST", `/repos/${full}/git/trees`, { base_tree: commit.data.tree.sha, tree });
  const newCommit = await gh<{ sha: string; html_url?: string }>(repo, "POST", `/repos/${full}/git/commits`, { message, tree: newTree.data.sha, parents: [headSha] });
  await gh(repo, "PATCH", `/repos/${full}/git/refs/heads/${repo.branch}`, { sha: newCommit.data.sha, force: false });
  return { sha: newCommit.data.sha, url: newCommit.data.html_url ?? `https://github.com/${full}/commit/${newCommit.data.sha}`, branch: repo.branch, lock };
}
