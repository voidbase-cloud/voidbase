// An experiment: what a voidbase instance looks like if its features are plugins rather than imports.
//
// src/server/app.ts imports about forty modules and wires them into one Hono app by hand. Ten already follow a
// `mount(app)` convention, which is most of a plugin boundary drawn by accident. This is the smallest thing that
// can say whether the rest of the way is worth walking: a cordis context, one service other code needs (the hub),
// and one feature that declares what it needs instead of importing it (backups).
//
// What cordis is for here, and what it is not:
//
//   - It is for composition and lifetime. A plugin says `inject: ["hub"]` and does not run until that exists; when
//     a service goes away everything that injected it is torn down with it. Hand-rolled plugin systems get that
//     part wrong and it cannot be retrofitted afterwards.
//   - It is NOT for loading. On Cloudflare the hooks are a build-time virtual module (platform/workers/hooks.ts):
//     no filesystem, no eval, so the set of plugins is fixed when `voidbase deploy` runs, and cordis's own loader
//     and hmr packages do not come along. That is not a loss. Every other part of a voidbase project is declared
//     in the repository and shipped by a push, and a plugin that could rewrite a live instance would be the one
//     thing that was not.
//
// Applying a plugin is asynchronous: cordis returns a fiber and the plugin runs on a later tick. Routes have to be
// mounted before the first request is served, so `ready()` awaits them all. That is the one thing about this model
// a Worker cares about, and it is why the kernel is built once per isolate rather than per request.
import { Context } from "cordis";
import type { Hono } from "hono";
import type { AppEnv } from "./types";

export interface Kernel extends Context {
  /** the app a plugin mounts its routes on */
  app: Hono<AppEnv>;
}

export function createKernel(app: Hono<AppEnv>): Kernel {
  const kernel = new Context() as Kernel;
  kernel.app = app;
  return kernel;
}

/** every fiber a plugin call returned, so the app is fully mounted before it serves anything */
const pending = new WeakMap<Kernel, Promise<unknown>[]>();

export function use(kernel: Kernel, plugin: Parameters<Kernel["plugin"]>[0], config?: unknown): void {
  const fiber = kernel.plugin(plugin as never, config as never);
  const list = pending.get(kernel) ?? [];
  list.push(Promise.resolve(fiber as unknown as Promise<unknown>));
  pending.set(kernel, list);
}

export async function ready(kernel: Kernel): Promise<void> {
  await Promise.all(pending.get(kernel) ?? []);
  pending.delete(kernel);
}
