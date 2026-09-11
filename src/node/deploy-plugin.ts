// What a plugin does at deploy time: the surface `voidbase deploy` offers beside the runtime `Plugin`.
//
// A runtime plugin lives inside the instance and answers requests. Some of what a plugin is about happens around
// a deploy instead, as an account-level action: attaching a hostname, scheduling a backup, turning an observability
// setting on, creating a preview instance. Those are the same shape: something to do to the Worker config before
// the upload, something to do on the account after it, and something to undo when the Worker goes. That shape is
// this file. It is types only, so a plugin package can import it without pulling the deploy in, and the Workers
// build never sees it (src/node is Node's side; the runtime plugin stays in src/server/plugins).
import type { CfApi } from "../cloud/rest";
import type { PluginManifest } from "../server/plugins/manifest";

/** what a hook sees: the deploy as far as it has got, and the means to act on the account */
export interface DeployContext {
  /** the Worker's name */
  name: string;
  /** the Cloudflare account the deploy targets; `id` is empty on a local run */
  account: { id: string };
  /** the Cloudflare API client the deploy uses (src/cloud/rest.ts), or null on a local run, where nothing reaches Cloudflare */
  api: CfApi | null;
  /** the resolved deploy environment: the shell, the .env files and pb_secrets/secrets.json, read the way the deploy's own knobs are */
  env: Record<string, string>;
  /**
   * the Worker config (wrangler.jsonc) as composed, before the upload. Mutable in `before`, which is where a plugin
   * turns workers.dev off or adds a binding; written to disk after the `before` hooks ran. Read-only in effect after.
   */
  config: Record<string, unknown>;
  /** the non-secret vars the deploy bakes into the Worker (its .env); mutable in `before`, where a plugin adds its own */
  vars: Record<string, string>;
  /**
   * where the Worker answers. Null in `before` unless a plugin claims it (a custom domain): the deploy then reports
   * that instead of the workers.dev address. In `after`, the URL the deploy reports, or null when there is none.
   */
  url: string | null;
  log: (line: string) => void;
  /** `voidbase serve --workers`: the same project on this machine; `api` is null and the account id empty */
  local: boolean;
  /** `--dry-run`: a hook says what it would do and touches nothing */
  dryRun: boolean;
}

export interface DeployHooks {
  /** after the config is composed, before the upload: change `ctx.config` and `ctx.vars`, claim `ctx.url`, or refuse the deploy by throwing */
  before?(ctx: DeployContext): Promise<void>;
  /** after the upload and the deploy's own post-steps (secrets, redirect rules): act on the account with `ctx.api` */
  after?(ctx: DeployContext): Promise<void>;
  /** `voidbase deploy --remove`, before the Worker is deleted: undo what `after` did on the account */
  remove?(ctx: DeployContext): Promise<void>;
}

/**
 * A plugin's deploy-time half. Shipped plugins register theirs in src/node/deploy-plugins.ts; an installed plugin
 * ships it as `deploy.js` beside its `bundle.js` in pb_plugins/<name>/, default-exporting this object.
 */
export interface DeployPlugin {
  /** the plugin's name, the same as its manifest's and its pb_plugins directory */
  name: string;
  manifest: PluginManifest;
  deploy?: DeployHooks;
}

export type DeployPhase = keyof DeployHooks;
