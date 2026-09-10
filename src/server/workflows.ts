// What a workflows/ module reaches voidbase through (`@voidbase-cloud/voidbase/workflows`).
//
// A Cloudflare Workflow's steps run inside the app's own Worker, outside any request: no hook store, no `$app`, and
// the bindings arrive as `this.env`. `withApp` opens the app for one step the way a cron tick is opened, so
// `pb.$app` (find, save, collections) and everything the app's shared code needs work inside `fn`, with the
// Secrets Store bindings resolved first. The class itself extends WorkflowEntrypoint from cloudflare:workers in
// the module; the adapter bundles the module, the deploy exports the class from the Worker and binds it as
// WORKFLOW_<NAME>, and `env.WORKFLOW_<NAME>.create({ id, params })` starts an instance.
// the app module itself: evaluating it installs the hook services and loads the hook files (app.ts, at its end).
// A Workflow step can run in an isolate where the fetch handler never imported it, so the import is made here.
import "./app";
import { loadHooks } from "./hooks";
import { withHookStore } from "./hooks/migrations";
import { resolveSecretBindings } from "./secrets-store";
import type { AppEnv } from "./types";

export async function withApp<T>(env: AppEnv["Bindings"], fn: () => Promise<T> | T): Promise<T> {
  // a Workflow step can run in an isolate that never served a request, where nothing has loaded the hook files
  // yet (they publish the PocketBase API the app's shared code reaches through `pb`); loading is once per isolate
  loadHooks();
  await resolveSecretBindings(env as unknown as Record<string, unknown>);
  return withHookStore(env.DB, env, fn);
}
