// Where this instance's plugins live: the one fact about the installer that is the core's and not a plugin's.
//
// The installer is a plugin (plugins/installer.ts) and is on its way to a package of its own. This is the part of
// it the core has to keep: `GET /api/plugins` answers `installer` whatever is loaded, because where an instance's
// plugins live is a fact about the instance rather than about a plugin and our own clients read into it
// (`voidbase cloud plugins <instance> ls` prints `installer.mode`). Assembling that answer is plugins/report.ts's
// job, and report.ts is the core: it cannot import a plugin module to answer for a plugin that may not be running,
// which is the whole of why the answer is built from what loaded. So the fact lives here, the plugin imports it
// like anything else, and lifting the installer out of this repository moves no part of this file.
//
// It sits beside project-sync.ts, which is the other half of the same fact: a project that keeps its plugins in a
// repository changes them by one commit there, and `mode: "repository"` is what says so.
import { filesystem as platformFilesystem } from "#platform/plugins";
import type { Repo } from "./project-sync";
import { rebuildsOnCloudflare } from "./rebuild/cloudflare";
import type { Bindings } from "./types";

export interface Listed { installed: { name: string; version: string; marketplace: string }[]; disabled: string[]; marketplaces: string[] }
export type Removed = "removed" | "already-removed";
export interface Declared { plugins: Record<string, { version: string; marketplace: string; source: { repository: string; commit: string; directory?: string } }>; disabled: string[]; marketplaces: string[] }

/** what the Bun platform provides: the project on disk (src/platform/node/plugins.ts); null on Workers, where a vanilla instance that rebuilds itself has the same over D1 (src/server/plugins/installer.ts) */
export interface FilesystemInstaller {
  root: string;
  list(): Listed | Promise<Listed>;
  add(spec: string, o: { marketplace?: string; voidbaseVersion: string; defaultConfig?: boolean }): Promise<{ name: string; version: string; marketplace: string; previous?: string; unchanged?: boolean }>;
  remove(name: string, o?: { force?: boolean }): Removed | Promise<Removed>;
  update(name: string | undefined, o: { voidbaseVersion: string; defaultConfig?: boolean }): Promise<{ updated: { name: string; from: string; to: string; marketplace: string }[]; current: string[] }>;
  /** queue a rebuild of the instance onto the changed declaration (src/node/rebuild.ts); false when this process has no rebuilder */
  rebuild?: (reason: string) => boolean | Promise<boolean>;
  /** a change is being made: the rebuild it will queue waits for it (src/server/rebuilds.ts, hold) */
  hold?: () => () => void;
  /** what the instance declares, with each plugin's commit: voidbase.lock on Bun, D1 on a Worker that rebuilds itself (voidbase wrap reads it) */
  declaration?: () => Promise<Declared>;
}

/** the three places an instance's plugins can live; the installer's routes read it to know what a change is */
export type Mode = "filesystem" | "declaration" | "repository" | "fixed";

/** the repository this instance deploys from, and the token that commits there, or nothing when it has neither */
export const repoOf = (env: Bindings): Repo | null => {
  const e = env as unknown as Record<string, string | undefined>;
  const fullName = String(e.VOIDBASE_PROJECT_REPO ?? "").trim().toLowerCase(); const token = String(e.VOIDBASE_GH_TOKEN ?? "");
  if (!fullName || !token) return null;
  return { fullName, token, branch: String(e.VOIDBASE_PROJECT_BRANCH ?? "").trim() || "master", api: e.GITHUB_API_BASE || undefined };
};

/** where this instance's plugins live, for /api/plugins and the dashboard */
export function installerInfo(env: Bindings, filesystem: FilesystemInstaller | null = platformFilesystem): { mode: Mode; repository?: string; branch?: string; hint?: string } {
  if (filesystem) return { mode: "filesystem" };
  const repo = repoOf(env); if (repo) return { mode: "repository", repository: repo.fullName, branch: repo.branch };
  // a vanilla instance on Cloudflare that rebuilds itself: its declaration is in its own D1 (src/server/rebuild)
  if (rebuildsOnCloudflare(env as never)) return { mode: "declaration" };
  return { mode: "fixed", hint: "This instance's plugins were fixed when its Worker was built. Deploy it from a repository and set VOIDBASE_PROJECT_REPO and VOIDBASE_GH_TOKEN on it, and a change here becomes a commit that the repository's build deploys." };
}
