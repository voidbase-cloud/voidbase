// Auto-merge (voidbase-stories git-connection.feature, 9.2): where a change to a side-loaded file made from the admin
// panel goes. A git connection alone opens nothing: the project still declares its side-loaded files, and a
// connection is not a reason to start editing them from the panel. Turning auto-merge on is the deliberate act that
// does, the way turning automigrate on is: a change is committed to the connected branch, which is merged, and the
// project's pipeline carries it from there.
//
//   instance     the instance holds its own files (a vanilla `voidbase serve`): written where they are served
//   repository   connected to git (VOIDBASE_PROJECT_REPO, VOIDBASE_GH_TOKEN) with VOIDBASE_AUTO_MERGE on: committed
//   refused      anything else, and the refusal names what to set so that it would work
import { repoOf } from "./installer-info";
import type { Repo } from "./project-sync";
import { readKnob } from "./response-policy";
import type { Bindings } from "./types";

export const AUTO_MERGE_VAR = "VOIDBASE_AUTO_MERGE";
export const autoMergeOn = (env?: object): boolean => ["1", "on", "true", "yes"].includes(readKnob(AUTO_MERGE_VAR, env).toLowerCase());

export type SideLoadedChange = { to: "instance" } | { to: "repository"; repo: Repo } | { to: "refused"; message: string };

export function sideLoadedChange(env: Bindings, holdsFiles: boolean): SideLoadedChange {
  if (holdsFiles) return { to: "instance" };
  const repo = repoOf(env);
  if (repo && autoMergeOn(env)) return { to: "repository", repo };
  if (repo) return { to: "refused", message: `This instance is connected to ${repo.fullName} with auto-merge off, so its side-loaded files are the project's: change them in the repository, or set ${AUTO_MERGE_VAR}=on on the instance to have a change made here committed and merged.` };
  return { to: "refused", message: `This instance cannot reach git, so its side-loaded files cannot be changed here: set VOIDBASE_PROJECT_REPO (owner/name) and VOIDBASE_GH_TOKEN on the instance, and ${AUTO_MERGE_VAR}=on, to have a change made here committed and merged.` };
}
