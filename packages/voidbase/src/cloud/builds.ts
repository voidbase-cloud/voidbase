// Cloudflare Workers Builds, through its REST API: the pieces `voidbase sync` uses to connect a GitHub repository
// to a deployed instance so that a push builds and deploys it (docs/deploy.md). scripts/cf-builds.ts, which wires
// this repository's own CI, does the same by hand.
//
// Two things a connection needs first. The "Cloudflare Workers and Pages" GitHub App has to cover the repository (a
// connection it does not cover fails with code 8000008): ./github-app.ts adds the repository to an installation that
// exists, and names the one click on github.com otherwise. And the account needs a build token, which builds run with:
// `ensureBuildToken` makes one from an API token it creates, given a token that may create tokens
// (CLOUDFLARE_TOKEN_CREATOR, User > API Tokens > Edit). Every endpoint here wants a *user* API token with "Workers
// Builds Configuration: Edit" and "Workers Scripts: Edit".
import { CfError, type CfApi } from "./rest";
import { createAccountToken } from "./tokens";

export interface Trigger {
  trigger_uuid: string; trigger_name: string; external_script_id?: string; repo_connection_uuid?: string; build_token_uuid?: string;
  build_command?: string; deploy_command?: string; root_directory?: string; branch_includes?: string[]; branch_excludes?: string[]; path_includes?: string[]; path_excludes?: string[];
  build_caching?: boolean;
}
export type TriggerSpec = Omit<Trigger, "trigger_uuid" | "external_script_id" | "repo_connection_uuid" | "build_token_uuid">;
export type BuildEnv = Record<string, { value: string; is_secret: boolean }>;
export interface GithubRepo { id: number; name: string; owner: { id: number; login: string; type?: "User" | "Organization" | string }; default_branch?: string }

/** the Worker's tag, which the Builds endpoints address it by; null when there is no such Worker */
export async function workerTag(cf: CfApi, account: string, name: string): Promise<string | null> {
  const list = (await cf.json<{ id: string; tag?: string }[]>("GET", `/accounts/${account}/workers/scripts`)).result ?? [];
  return list.find((s) => s.id === name)?.tag ?? null;
}

/** the repository, as GitHub describes it (the connection wants its numeric ids) */
export async function githubRepo(repo: string, opts: { token?: string; api?: string } = {}): Promise<GithubRepo> {
  const api = (opts.api ?? process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const res = await fetch(`${api}/repos/${repo}`, { headers: { accept: "application/vnd.github+json", "user-agent": "voidbase", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) } });
  if (!res.ok) throw new Error(`GitHub: ${res.status} for ${repo}${res.status === 404 ? " (a private repository needs GH_TOKEN)" : ""}`);
  return (await res.json()) as GithubRepo;
}

export const APP_NOT_INSTALLED = 8000008;

/** the repository connection, created or found; a CfError with code 8000008 means the GitHub App is not installed for it */
export async function connectRepo(cf: CfApi, account: string, repo: GithubRepo): Promise<string> {
  const r = await cf.json<{ repo_connection_uuid?: string; uuid?: string; id?: string }>("PUT", `/accounts/${account}/builds/repos/connections`, {
    provider_type: "github", provider_account_id: String(repo.owner.id), provider_account_name: repo.owner.login, repo_id: String(repo.id), repo_name: repo.name,
  });
  const uuid = r.result?.repo_connection_uuid ?? r.result?.uuid ?? r.result?.id;
  if (!uuid) throw new Error(`repository connection created but no uuid in ${JSON.stringify(r.result)}`);
  return uuid;
}

export const appNotInstalled = (e: unknown): boolean => e instanceof CfError && e.errors.some((x) => x.code === APP_NOT_INSTALLED);

/** the build tokens the account has (the dashboard's connect wizard creates one) */
export async function buildTokens(cf: CfApi, account: string): Promise<{ uuid: string; name?: string }[]> {
  const r = await cf.json<{ build_token_uuid: string; build_token_name?: string }[]>("GET", `/accounts/${account}/builds/tokens`);
  return (r.result ?? []).map((t) => ({ uuid: t.build_token_uuid, name: t.build_token_name }));
}

/** what a build deploys with: the Worker, its bindings' resources, and the account read that finds them */
export const BUILD_TOKEN_PERMISSIONS = ["Workers Scripts Write", "Workers KV Storage Write", "Workers R2 Storage Write", "D1 Write", "Queues Write", "Account Settings Read"];

/**
 * The build token the account's builds run with: the one it has, or one made here. Making one is two calls: an API
 * token scoped to this account with BUILD_TOKEN_PERMISSIONS, created through `creator` (a token allowed to create tokens),
 * then registered with Workers Builds (POST /builds/tokens: build_token_name, build_token_secret, cloudflare_token_id).
 * Null when there is none and no creator to make one.
 */
export async function ensureBuildToken(builds: CfApi, account: string, creator: CfApi | null, name = "voidbase builds"): Promise<{ uuid: string; created: boolean } | null> {
  const have = await buildTokens(builds, account);
  if (have[0]) return { uuid: have[0].uuid, created: false };
  if (!creator) return null;
  const token = await createAccountToken(creator, account, name, BUILD_TOKEN_PERMISSIONS);
  const made = (await builds.json<{ build_token_uuid: string }>("POST", `/accounts/${account}/builds/tokens`, { build_token_name: name, build_token_secret: token.value, cloudflare_token_id: token.id })).result;
  return { uuid: made.build_token_uuid, created: true };
}

export async function triggers(cf: CfApi, account: string, tag: string): Promise<Trigger[]> {
  return (await cf.json<Trigger[]>("GET", `/accounts/${account}/builds/workers/${tag}/triggers`)).result ?? [];
}

/**
 * Creates the trigger, or updates the one with the same name (else the same branch shape: the dashboard names its
 * own). `keepPaths` leaves an existing trigger's watch paths alone, so a project whose builds are started from
 * GitHub (paths excluded) is not switched back to building on push.
 */
export async function ensureTrigger(cf: CfApi, account: string, tag: string, connection: string, buildToken: string, want: TriggerSpec, keepPaths = true): Promise<{ uuid: string; created: boolean }> {
  const same = (a: unknown, b: unknown) => JSON.stringify([...((a as string[] | undefined) ?? [])].sort()) === JSON.stringify([...((b as string[] | undefined) ?? [])].sort());
  const all = await triggers(cf, account, tag);
  const existing = all.find((t) => t.trigger_name === want.trigger_name) ?? all.find((t) => same(t.branch_includes, want.branch_includes) && same(t.branch_excludes, want.branch_excludes));
  if (existing) {
    const patch: Record<string, unknown> = { ...want, build_token_uuid: buildToken };
    if (keepPaths) { delete patch.path_includes; delete patch.path_excludes; }
    await cf.json("PATCH", `/accounts/${account}/builds/triggers/${existing.trigger_uuid}`, patch);
    return { uuid: existing.trigger_uuid, created: false };
  }
  const r = await cf.json<Trigger>("POST", `/accounts/${account}/builds/triggers`, { ...want, external_script_id: tag, repo_connection_uuid: connection, build_token_uuid: buildToken });
  return { uuid: r.result.trigger_uuid, created: true };
}

export async function setTriggerEnv(cf: CfApi, account: string, trigger: string, vars: BuildEnv): Promise<void> {
  if (Object.keys(vars).length) await cf.json("PATCH", `/accounts/${account}/builds/triggers/${trigger}/environment_variables`, vars);
}

/** the dashboard page where the repository is connected to the Worker (installs the App, creates the build token) */
export const buildsSettingsLink = (worker: string) => `https://dash.cloudflare.com/?to=/:account/workers/services/view/${encodeURIComponent(worker)}/production/settings/builds`;
