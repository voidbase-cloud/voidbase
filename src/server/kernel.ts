// The plugin kernel: what composes an instance out of plugins rather than imports.
//
// src/server/app.ts imports about forty modules and wires them into one Hono app by hand. Ten already follow a
// `mount(app)` convention, which is most of a plugin boundary drawn by accident. This is the rest of the way.
//
// What cordis is for here, and what it is not:
//
//   - It is for composition and lifetime. A plugin requires an interface and does not run until something provides
//     it; when a provider goes away everything that required it is torn down with it. Hand-rolled plugin systems
//     get that part wrong and it cannot be retrofitted afterwards.
//   - It is NOT for loading. On Cloudflare the hooks are a build-time virtual module (platform/workers/hooks.ts):
//     no filesystem, no eval, so the set of plugins is fixed when `voidbase deploy` runs, and cordis's own loader
//     and hmr packages do not come along. That is not a loss. Every other part of a voidbase project is declared
//     in the repository and shipped by a push, and a plugin that could rewrite a live instance would be the one
//     thing that was not.
//   - It is NOT the judge of whether a set of plugins makes sense. Two providers of one interface are accepted
//     silently by cordis and a cycle deadlocks in it without an error, so plugins/resolve.ts checks the graph
//     whole, before any of it is handed over.
//
// Two constraints decide the shape, and they only fit together one way:
//
//   Mounting. Hono's default SmartRouter builds its matcher on the first match and refuses routes afterwards, so
//   everything a plugin mounts has to be in place before the app serves anything. cordis applies a plugin on a
//   later tick, so `load` awaits. Top level await in an ES module is where both facts are true at once, and the
//   Worker bundle accepts it.
//
//   Bindings. They arrive with the request, not at module scope, so a service wrapping one cannot exist when the
//   mounting happens. Those are built on the first request instead and memoised for the isolate, which is what
//   `services` is for. A plugin therefore cannot decide *whether* to mount by looking at a binding: it mounts, and
//   answers for the binding's absence when it is called.
import { Context } from "cordis";
import type { Hono } from "hono";
import { logger } from "#platform/log";
import type { AppEnv, Bindings } from "./types";
import type { Plugin } from "./plugins/manifest";
import { resolve } from "./plugins/resolve";

export interface Kernel extends Context {
  /** the app a plugin mounts its routes on */
  app: Hono<AppEnv>;
}

export function createKernel(app: Hono<AppEnv>): Kernel {
  const kernel = new Context() as Kernel;
  kernel.app = app;
  return kernel;
}

/** what this instance ended up running, for the health endpoint and for anything that asks */
export interface Loaded {
  names: string[];
  providers: Record<string, string>;
  /** the tiers a name belongs to, so an instance can say what it is missing */
  tiers: Record<string, string>;
  /**
   * Core interfaces nothing provides. An instance can be run without one, because replacing auth is the entire
   * point of moving it out, but it is not a lean instance and it should not have to be guessed at from a 404.
   */
  missingCore: string[];
}

const loaded = new WeakMap<Kernel, Loaded>();
export const whatLoaded = (kernel: Kernel): Loaded =>
  loaded.get(kernel) ?? { names: [], providers: {}, tiers: {}, missingCore: [] };

/**
 * Fill an interface this plugin declared it provides. The name is the one in the manifest, version and all.
 *
 * The plugin registers it rather than the kernel declaring it up front, for two reasons. cordis refuses an
 * assignment to a service owned by another fiber, so a plugin cannot fill a slot the root opened. And a service
 * registered by the plugin's own fiber is disposed with it, which is the whole reason to be here: remove the
 * provider and everything that required the interface unloads, without anyone writing that down.
 */
export function serve<T>(ctx: Kernel, iface: string, implementation: T): void {
  (ctx as unknown as { provide(name: string, value: T): void }).provide(iface, implementation);
}

/** the implementation behind an interface, for a plugin that required it */
export function using<T>(ctx: Kernel, iface: string): T {
  return (ctx as unknown as Record<string, T>)[iface];
}

/**
 * Check the graph, then apply it in order.
 *
 * Nothing is applied if anything is wrong, and everything wrong is reported at once: an install that fails four
 * times in a row teaches you four things slowly.
 */
export async function load(kernel: Kernel, plugins: Plugin[], voidbaseVersion: string): Promise<Loaded> {
  const { order, providers, problems, missingCore } = resolve(plugins, voidbaseVersion);
  if (problems.length) {
    throw new Error(`voidbase: these plugins cannot be loaded together:\n  - ${problems.join("\n  - ")}`);
  }

  for (const plugin of order) {
    if (!plugin.apply) continue;
    const apply = plugin.apply;
    await kernel.plugin({
      name: plugin.manifest.name,
      // cordis waits on service names, and an interface is a service name
      inject: plugin.manifest.requires ?? [],
      apply: (ctx: Context) => apply(ctx as Kernel),
    });
  }

  const result: Loaded = {
    names: order.map((p) => p.manifest.name),
    providers: Object.fromEntries([...providers].map(([i, n]) => [i, n])),
    tiers: Object.fromEntries(order.map((p) => [p.manifest.name, p.manifest.tier])),
    missingCore,
  };
  loaded.set(kernel, result);
  logger.info("voidbase: plugins loaded", { plugins: result.names });
  if (missingCore.length) {
    logger.warn("voidbase: no plugin provides a core interface; the instance is running without it", { missing: missingCore });
  }
  return result;
}

// ---- services that wrap a binding ------------------------------------------------------------------------------
// Built on the first request, because that is when a binding exists, and kept for the isolate. voidbase already
// assumes bindings are stable per isolate: app.ts re-attaches the hub and the jobs queue on every request from
// c.env, which is the same assumption written less visibly.

type ServiceFactory = (kernel: Kernel, env: Bindings) => void;
const factories = new WeakMap<Kernel, ServiceFactory[]>();
const built = new WeakSet<Kernel>();

/** register something that needs a binding; it is created when the first request brings one */
export function withBindings(kernel: Kernel, factory: ServiceFactory): void {
  const list = factories.get(kernel) ?? [];
  list.push(factory);
  factories.set(kernel, list);
}

/** called once per isolate, by the first request through the app */
export function attachBindings(kernel: Kernel, env: Bindings): void {
  if (built.has(kernel)) return;
  built.add(kernel);
  for (const factory of factories.get(kernel) ?? []) factory(kernel, env);
}
