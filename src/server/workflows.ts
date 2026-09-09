// What a workflows/ module reaches voidbase through (`@voidbase-cloud/voidbase/workflows`).
//
// A Cloudflare Workflow's steps run inside the app's own Worker, outside any request: no hook store, no `$app`, and
// the bindings arrive as `this.env`. `withApp` opens the app for one step the way a cron tick is opened, so
// `pb.$app` (find, save, collections) and everything the app's shared code needs work inside `fn`, with the
// Secrets Store bindings resolved first. The class itself extends WorkflowEntrypoint from cloudflare:workers in
// the module; the adapter bundles the module, the deploy exports the class from the Worker and binds it as
// WORKFLOW_<NAME>, and `env.WORKFLOW_<NAME>.create({ id, params })` starts an instance.
import { withHookStore } from "./hooks/migrations";
import { resolveSecretBindings } from "./secrets-store";
import type { AppEnv } from "./types";

export async function withApp<T>(env: AppEnv["Bindings"], fn: () => Promise<T> | T): Promise<T> {
  await resolveSecretBindings(env as unknown as Record<string, unknown>);
  return withHookStore(env.DB, env, fn);
}
