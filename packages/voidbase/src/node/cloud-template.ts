// `voidbase instances create --cloudflare <name> --template <template>`: a cloud instance shaped like a template, with
// nothing built on this machine first (voidbase-stories e-cloud-first.feature: "Creating a cloud instance from a
// template"). The template is fetched into a scratch directory, deployed the way `voidbase sync up` deploys a project
// (its hooks, migrations, pb_public and plugins go with it), and the scratch directory is removed: the instance is
// what remains.
//
// A template is somebody's working project, so it can name where its author deploys it. None of that is this
// instance's: the deploy runs with the shell's deploy-target knobs cleared, under the name given, on workers.dev, and
// with a superuser of its own that is printed once and kept nowhere.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncOptions } from "./sync";
import type { Fetched, FetchOptions } from "./template";

/** where a deploy would otherwise send the instance: the template author's hostnames and Worker, or another project's in this shell */
export const TARGET_KNOBS = ["VOIDBASE_DOMAINS", "VOIDBASE_DEPLOY_DOMAIN", "VOIDBASE_CANONICAL_DOMAIN", "VOIDBASE_DEPLOY_NAME"] as const;
const SUPERUSER = ["VOIDBASE_SUPERUSER_EMAIL", "VOIDBASE_SUPERUSER_PASSWORD"] as const;

const randomPassword = (): string => { const a = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; return Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => a[b % a.length]).join(""); };

export interface TemplateCreateOptions {
  template: string; name: string; email: string; account?: string; ref?: string; marketplace?: string;
  log?: (line: string) => void;
  /** seams for the tests: the download, the dependency install and the deploy */
  fetchTemplate?: (input: string, dir: string, o: FetchOptions) => Promise<Fetched>;
  install?: (dir: string) => void;
  sync?: (o: SyncOptions) => Promise<void>;
}

export async function createFromTemplate(o: TemplateCreateOptions): Promise<{ repository: string; ref: string; email: string; password: string }> {
  const log = o.log ?? ((l: string) => console.log(l));
  const T = await import("./template");
  const fetchTemplate = o.fetchTemplate ?? T.fetchTemplate;
  const install = o.install ?? ((dir: string) => { const r = Bun.spawnSync(["bun", "install"], { cwd: dir, stdout: "inherit", stderr: "inherit" }); if (r.exitCode !== 0) throw new Error("installing the template's dependencies failed; nothing deployed"); });
  const sync = o.sync ?? (await import("./sync")).sync;

  const scratch = mkdtempSync(join(tmpdir(), "voidbase-cloud-template-"));
  const dir = join(scratch, "project");
  const saved = Object.fromEntries([...TARGET_KNOBS, ...SUPERUSER].map((k) => [k, process.env[k]]));
  const password = randomPassword();
  try {
    const fetched = await fetchTemplate(o.template, dir, { ref: o.ref, marketplaces: T.templateMarketplaces(o.marketplace), log });
    log(`${fetched.files} files from ${fetched.repository} at ${fetched.ref}`);
    if (existsSync(join(dir, "package.json"))) install(dir);
    for (const k of TARGET_KNOBS) delete process.env[k];
    process.env.VOIDBASE_SUPERUSER_EMAIL = o.email; process.env.VOIDBASE_SUPERUSER_PASSWORD = password;
    await sync({ dir, name: o.name, account: o.account, data: false, ci: false, log });
    return { repository: fetched.repository, ref: fetched.ref, email: o.email, password };
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(scratch, { recursive: true, force: true });
  }
}
