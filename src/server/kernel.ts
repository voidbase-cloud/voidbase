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

/** work a plugin does once per isolate with the bindings, on the first request: creating what it owns */
export type Bootstrap = (env: Bindings) => Promise<void> | void;

export interface Kernel extends Context {
  /** the app a plugin mounts its routes on */
  app: Hono<AppEnv>;
  /** what plugins asked to run at bootstrap, in load order (onBootstrap) */
  bootstraps: { plugin: string; run: Bootstrap }[];
}

export function createKernel(app: Hono<AppEnv>): Kernel {
  const kernel = new Context() as Kernel;
  kernel.app = app;
  kernel.bootstraps = [];
  return kernel;
}

/**
 * Register work to do once per isolate, on the first request, with the bindings: a plugin cannot touch the database
 * in `apply`, because `apply` runs at module scope and the bindings arrive with the request. The kernel runs these
 * after voidbase's own bootstrap (the system collections, the settings row, the superuser), in load order, so a
 * plugin that extends a collection another one owns runs after the owner created it.
 */
export function onBootstrap(ctx: Kernel, run: Bootstrap): void {
  // a plugin's ctx is a fork; `bootstraps` reaches the root's list through it. The name is the plugin being applied
  // right now: load() applies them one at a time, and cordis refuses a property set on a fork.
  ctx.bootstraps.push({ plugin: applying ?? "?", run });
}
let applying: string | undefined;

const bootstrapped = new WeakMap<Kernel, Promise<void>>();
/** run every plugin's bootstrap once per isolate; a failure is retried by the next request, the way voidbase's own is */
export function runBootstraps(kernel: Kernel, env: Bindings): Promise<void> {
  let p = bootstrapped.get(kernel);
  if (!p) {
    p = (async () => { for (const b of kernel.bootstraps) await b.run(env); })().catch((err) => { bootstrapped.delete(kernel); throw err; });
    bootstrapped.set(kernel, p);
  }
  return p;
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
  /** where each plugin came from: "shipped", or the marketplace and version it was installed from */
  origins: Record<string, string>;
  /** shipped plugins the project turned off in voidbase.lock */
  disabled: string[];
}

const loaded = new WeakMap<Kernel, Loaded>();
export const whatLoaded = (kernel: Kernel): Loaded =>
  loaded.get(kernel) ?? { names: [], providers: {}, tiers: {}, missingCore: [], origins: {}, disabled: [] };

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
export async function load(kernel: Kernel, plugins: Plugin[], voidbaseVersion: string, extra: { origins?: Record<string, string>; disabled?: string[] } = {}): Promise<Loaded> {
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
      apply: (ctx: Context) => { applying = plugin.manifest.name; try { return apply(ctx as Kernel); } finally { applying = undefined; } },
    });
  }

  const result: Loaded = {
    names: order.map((p) => p.manifest.name),
    providers: Object.fromEntries([...providers].map(([i, n]) => [i, n])),
    tiers: Object.fromEntries(order.map((p) => [p.manifest.name, p.manifest.tier])),
    missingCore,
    origins: extra.origins ?? Object.fromEntries(order.map((p) => [p.manifest.name, "shipped"])),
    disabled: extra.disabled ?? [],
  };
  loaded.set(kernel, result);
  logger.info("voidbase: plugins loaded", { plugins: result.names });
  if (missingCore.length) {
    logger.warn("voidbase: no plugin provides a core interface; the instance is running without it", { missing: missingCore });
  }
  return result;
}

// Nothing here builds services out of bindings, and the first attempt at it is why.
//
// The plan called for a second phase: bindings arrive with the request, so a service wrapping one would be created
// on the first request and kept for the isolate. It was written, and then it had no callers, because the thing it
// was for turned out to be solved already. voidbase threads a RecordContext through the write path carrying db,
// storage, auth and collections — a container by another name — and anything a request needs can travel on it or
// on the Hono context beside c.env.
//
// So a binding-backed service does not need a phase of its own. It needs to be reachable from the request, which
// is a smaller idea. The kernel composes what is fixed at deploy: routes, hooks, and the interfaces plugins fill.
