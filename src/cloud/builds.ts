// Cloudflare Workers Builds, through its REST API: the pieces `voidbase sync` uses to connect a GitHub repository
// to a deployed instance so that a push builds and deploys it (docs/deploy.md). scripts/cf-builds.ts, which wires
// this repository's own CI, does the same by hand.
//
// Two things the API cannot do, and a dashboard visit must: install the "Cloudflare Workers and Pages" GitHub App
// for the repository (a connection to a repository the App does not cover fails with code 8000008), and create the
// build token (the dashboard's connect wizard makes one; `POST /builds/tokens` accepts nothing). Every endpoint here
// wants a *user* API token with "Workers Builds Configuration: Edit" and "Workers Scripts: Edit".
import { CfError, type CfApi } from "./rest";

export interface Trigger {
  trigger_uuid: string; trigger_name: string; external_script_id?: string; repo_connection_uuid?: string; build_token_uuid?: string;
  build_command?: string; deploy_command?: string; root_directory?: string; branch_includes?: string[]; branch_excludes?: string[]; path_includes?: string[]; path_excludes?: string[];
  build_caching?: boolean;
}
export type TriggerSpec = Omit<Trigger, "trigger_uuid" | "external_script_id" | "repo_connection_uuid" | "build_token_uuid">;
export type BuildEnv = Record<string, { value: string; is_secret: boolean }>;
export interface GithubRepo { id: number; name: string; owner: { id: number; login: string }; default_branch?: string }

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
