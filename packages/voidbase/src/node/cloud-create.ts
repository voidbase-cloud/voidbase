// `voidbase instances create --cloudflare <name>`: a vanilla instance created on Cloudflare from the CLI, with nothing
// built locally first beyond the release this CLI already is (src/node/bundle.ts). Until now only the site could
// create one (src/cloud/client.ts), through the user's voidbase.cloud session; this does the same upload with the
// Cloudflare token this machine has (deployTarget), so a journey or a script can create an instance on its own.
//
// The upload is provisionInstance's, as the site's is: the D1 database, the bucket, the queue, the release's system
// migrations, the static assets and the script, which carries `voidbase` and `voidbase-release:<version>`. That tag
// is what makes it vanilla to `voidbase instances --cloudflare` and what lets `voidbase update --cloudflare` rebuild
// it later. The superuser password is generated here, sent to the Worker as a secret, printed once and kept nowhere.
import type { CfApi } from "../cloud/rest";

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** why `name` cannot be created, or null when it can */
export function createRefusal(name: string, exists: boolean): string | null {
  if (!NAME.test(name)) return `"${name}" is not a Worker name: lowercase letters, digits and dashes, 63 characters at most`;
  if (exists) return `a Worker called ${name} already exists on this account: voidbase update --cloudflare ${name} rebuilds it, or choose another name`;
  return null;
}

const randomPassword = (): string => {
  const a = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => a[b % a.length]).join("");
};

export interface Created { url: string | null; release: string; email: string; password: string }

/** build this CLI's release and upload it as a new instance called `name` */
export async function createOnCloudflare(o: { api: CfApi; account: string; name: string; email: string; log?: (line: string) => void }): Promise<Created> {
  const log = o.log ?? ((l: string) => console.log(l));
  const { buildRelease, releaseFromDir } = await import("./bundle");
  const { provisionInstance } = await import("../cloud/rest");
  const built = await buildRelease({ log: (l) => log(`  ${l}`) });
  const password = randomPassword();
  // the token the instance rebuilds itself with (src/cloud/tokens.ts), when this machine holds a token that may create tokens
  const creatorToken = process.env.CLOUDFLARE_TOKEN_CREATOR;
  let rebuildToken: string | undefined;
  if (creatorToken) {
    const { CfApi } = await import("../cloud/rest");
    const { createRebuildToken } = await import("../cloud/tokens");
    rebuildToken = (await createRebuildToken(new CfApi(creatorToken), o.account, o.name)).value;
    log("  made the instance's rebuild token (Workers Scripts Write on this account: Cloudflare scopes a token to an account, not to one Worker)");
  } else log("  no CLOUDFLARE_TOKEN_CREATOR: the instance is created without a rebuild token, so installing a plugin from its admin panel cannot rebuild it yet");
  const r = await provisionInstance(o.api, { account: o.account, name: o.name, release: releaseFromDir(built.dir), superuser: { email: o.email, password }, rebuildToken, applyDoMigrations: true, log: (l) => log(`  ${l}`) });
  return { url: r.url ?? null, release: r.release, email: o.email, password };
}
