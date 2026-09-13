// Cloudflare API tokens made by voidbase itself, through a token that may create tokens (CLOUDFLARE_TOKEN_CREATOR: the
// dashboard's "Create Additional Tokens" template, User > API Tokens > Edit). wrangler's login cannot do this: none of its
// OAuth scopes reaches API tokens. Two are made:
//   a build token      what Workers Builds runs a project's build with (./builds.ts ensureBuildToken)
//   a rebuild token    what a vanilla instance uploads a new version of itself with (src/server/rebuild), kept as that
//                      instance's secret VOIDBASE_REBUILD_TOKEN
// A token's permissions are account-wide: Cloudflare scopes an API token to an account or a zone, not to one Worker, so
// an instance's rebuild token could upload any Worker on the account. It is kept out of every plugin's reach only as far
// as a Worker's secrets are, which is the limit to know about it.
import type { CfApi } from "./rest";

/** create an API token scoped to `account` with the permission groups named, through `creator`; returns its id and value */
export async function createAccountToken(creator: CfApi, account: string, name: string, permissions: string[]): Promise<{ id: string; value: string }> {
  const groups = (await creator.json<{ id: string; name: string }[]>("GET", "/user/tokens/permission_groups")).result ?? [];
  const ids = permissions.map((n) => ({ n, id: groups.find((g) => g.name === n)?.id }));
  const missing = ids.filter((x) => !x.id).map((x) => x.n);
  if (missing.length) throw new Error(`Cloudflare offers no permission group called ${missing.join(", ")}; the token "${name}" cannot be made with them`);
  const token = (await creator.json<{ id: string; value: string }>("POST", "/user/tokens", {
    name, policies: [{ effect: "allow", resources: { [`com.cloudflare.api.account.${account}`]: "*" }, permission_groups: ids.map((x) => ({ id: x.id })) }],
  })).result;
  if (!token?.id || !token.value) throw new Error(`Cloudflare made the token "${name}" but did not hand it back`);
  return { id: token.id, value: token.value };
}

/** what a rebuild inside an instance does with its token: upload a version of its Worker and deploy it */
export const REBUILD_TOKEN_PERMISSIONS = ["Workers Scripts Write"];

/** the rebuild token of one instance */
export const createRebuildToken = (creator: CfApi, account: string, worker: string) => createAccountToken(creator, account, `voidbase rebuild: ${worker}`, REBUILD_TOKEN_PERMISSIONS);
