// The "Cloudflare Workers and Pages" GitHub App covering a repository, arranged from this machine where GitHub lets it be.
//
// Workers Builds connects a repository only when that App is installed for it: a connection it does not cover fails with
// code 8000008 (./builds.ts). Installing an App is a person's click on github.com, once per account. What is not a click
// is adding a repository to an installation that exists and covers selected repositories: GitHub takes that from a
// classic personal access token with `repo`, from a user with admin on the repository (docs.github.com, "Add a
// repository to an app installation"), which is what the `gh` login on a developer's machine is. So:
//   an organisation   its installations are listed with the login's `read:org`: the App covering all repositories needs
//                     nothing, one covering selected repositories gets this one added, and no installation is a link
//   a personal account  GitHub lists a user's installations only to the App itself, so this cannot tell, and says where
//                     the one click is
import type { GithubRepo } from "./builds";

export const CLOUDFLARE_APP = "cloudflare-workers-and-pages";

/** the page that installs the App on the repository's owner, which is the one step a token cannot take */
export const appInstallLink = (owner: { id: number }): string => `https://github.com/apps/${CLOUDFLARE_APP}/installations/new/permissions?target_id=${owner.id}`;

export type Coverage =
  | { state: "covered"; installation: number }
  | { state: "added"; installation: number }
  | { state: "missing" | "unknown"; link: string; why: string };

interface Installation { id: number; app_slug: string; repository_selection: "all" | "selected" }

export async function coverRepo(repo: GithubRepo, opts: { token: string; api?: string; fetchImpl?: typeof fetch }): Promise<Coverage> {
  const api = (opts.api ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const f = opts.fetchImpl ?? fetch;
  const link = appInstallLink(repo.owner);
  if (!opts.token) return { state: "unknown", link, why: "no GitHub login on this machine (gh auth login) to look with" };
  if (repo.owner.type !== "Organization") return { state: "unknown", link, why: `${repo.owner.login} is a personal account, whose App installations GitHub shows only to the App` };
  const headers = { accept: "application/vnd.github+json", "user-agent": "voidbase", authorization: `Bearer ${opts.token}` };
  const listed = await f(`${api}/orgs/${repo.owner.login}/installations?per_page=100`, { headers });
  if (!listed.ok) return { state: "unknown", link, why: `GitHub answered ${listed.status} listing ${repo.owner.login}'s App installations (the login needs read:org, and to be an owner)` };
  const install = ((await listed.json()) as { installations?: Installation[] }).installations?.find((i) => i.app_slug === CLOUDFLARE_APP);
  if (!install) return { state: "missing", link, why: `the App is not installed on ${repo.owner.login}` };
  if (install.repository_selection === "all") return { state: "covered", installation: install.id };
  const added = await f(`${api}/user/installations/${install.id}/repositories/${repo.id}`, { method: "PUT", headers });
  if (added.status === 204 || added.ok) return { state: "added", installation: install.id };
  return { state: "unknown", link, why: `GitHub answered ${added.status} adding ${repo.owner.login}/${repo.name} to the App's installation (it takes a classic token with repo, from an admin of the repository)` };
}
