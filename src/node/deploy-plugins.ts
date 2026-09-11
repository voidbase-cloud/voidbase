// Where `voidbase deploy` finds the plugins that act at deploy time, and how it runs them.
//
// Two sources, one order. The shipped plugins come first, in SHIPPED order, from a static registry here that maps
// a shipped name to its deploy module; the module is imported only when the deploy runs, so nothing on the Workers
// side ever sees Node code. Then the installed plugins (voidbase.lock, verified the way the build verifies them)
// that ship a `deploy.js` beside their `bundle.js`, in the lockfile's order. A shipped plugin the project turned
// off, or shadowed by installing one of the same name, is skipped, the same rule app.ts applies at runtime.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SHIPPED } from "../server/plugins/shipped";
import { lockPath, rootOfPluginsDir, verifyInstalled } from "./installed";
import type { DeployContext, DeployPhase, DeployPlugin } from "./deploy-plugin";

/** a shipped name to the function that loads its deploy half; the import is lazy on purpose */
export type DeployRegistry = Partial<Record<string, () => Promise<DeployPlugin>>>;

/** the shipped plugins that have a deploy-time half (src/node/plugins/<name>.ts); none yet */
export const SHIPPED_DEPLOY: DeployRegistry = {};

export interface DiscoveredDeployPlugin {
  name: string;
  /** "shipped", or the marketplace and version an installed one came from */
  origin: string;
  plugin: DeployPlugin;
  /** the deploy.js an installed plugin was loaded from */
  file?: string;
}

/** the file an installed plugin's deploy half lives in, beside its bundle */
export const deployFileOf = (pluginsDir: string, name: string): string => join(pluginsDir, name, "deploy.js");

const shaped = (x: unknown, name: string, where: string): DeployPlugin => {
  const p = x as Partial<DeployPlugin> | null;
  if (!p || typeof p !== "object" || typeof p.name !== "string" || !p.manifest) throw new Error(`${where} does not export a deploy plugin ({ name, manifest, deploy })`);
  if (p.name !== name) throw new Error(`${where} calls itself ${JSON.stringify(p.name)}, but it is ${name}'s`);
  if (p.deploy !== undefined && (typeof p.deploy !== "object" || p.deploy === null)) throw new Error(`${where}: deploy is not an object of hooks`);
  return p as DeployPlugin;
};

/**
 * Every deploy plugin this project runs, in the order their hooks run: shipped first (SHIPPED order), then installed
 * (lockfile order). `registry` and `shipped` are the real ones unless a test says otherwise.
 */
export async function discoverDeployPlugins(pluginsDir: string, o: { registry?: DeployRegistry; shipped?: readonly string[] } = {}): Promise<DiscoveredDeployPlugin[]> {
  const registry = o.registry ?? SHIPPED_DEPLOY;
  const root = rootOfPluginsDir(pluginsDir);
  const { installed, disabled } = existsSync(lockPath(root)) ? await verifyInstalled(root) : { installed: [], disabled: [] as string[] };
  const shadowed = new Set(installed.map((p) => p.name));
  const out: DiscoveredDeployPlugin[] = [];
  for (const name of o.shipped ?? SHIPPED) {
    const load = registry[name];
    if (!load || disabled.includes(name) || shadowed.has(name)) continue;
    out.push({ name, origin: "shipped", plugin: shaped(await load(), name, `the shipped plugin ${name}'s deploy module`) });
  }
  for (const p of installed) {
    const file = deployFileOf(pluginsDir, p.name);
    if (!existsSync(file)) continue;
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown; deploy?: unknown };
    out.push({ name: p.name, origin: `${p.marketplace} ${p.version}`, plugin: shaped(mod.default ?? mod.deploy, p.name, file), file });
  }
  return out;
}

/** run one phase's hooks in discovery order; a hook that throws fails the deploy with the plugin named. Returns who ran. */
export async function runDeployHooks(phase: DeployPhase, plugins: DiscoveredDeployPlugin[], ctx: DeployContext): Promise<string[]> {
  const ran: string[] = [];
  for (const p of plugins) {
    const hooks = p.plugin.deploy; const fn = hooks?.[phase];
    if (!hooks || !fn) continue;
    try { await fn.call(hooks, ctx); ran.push(p.name); }
    catch (e) { throw new Error(`deploy plugin ${p.name} (${p.origin}) failed in ${phase}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return ran;
}
