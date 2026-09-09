// The four failures the loader owns, because cordis does not.
//
// Measured against cordis 4.0.0-rc.9, and each of these is why this file exists:
//
//   - Two services registered under one name: the first wins, the second is discarded, nothing is thrown. The
//     roadmap says ambiguity "has to be resolved on purpose rather than by whichever won a sort", which is exactly
//     what cordis does instead.
//   - A dependency cycle: every plugin in it waits forever and nothing is thrown. An instance that boots to a
//     silent deadlock is worse than one that refuses to start.
//   - A missing requirement: cordis gets this right, the plugin does not run. What it cannot do is say which
//     interface was missing or who wanted it, because by then nobody is left to ask.
//   - A version mismatch: not cordis's concern at all.
//
// So the graph is checked here, whole, before a single plugin is handed over. Everything wrong with it is reported
// at once rather than one throw at a time, because an install that fails four times in a row teaches you four
// things slowly.
import { KNOWN } from "../interfaces";
import type { InterfaceName, Plugin } from "./manifest";
import { checkManifest } from "./manifest";

/**
 * The interfaces an instance is not usable without, whoever provides them.
 *
 * An interface joins this list in the same commit that removes its built-in implementation, and not before:
 * listing `auth@1` while auth was still built in would have made every instance warn that it was running without
 * auth while auth was running fine. Auth left the core on 2026-09-09 (plugins/auth.ts provides it), so an instance
 * without a provider is one that says so.
 */
export const CORE: InterfaceName[] = ["auth@1"];

export interface Resolution {
  /** load order: everything a plugin requires comes before it */
  order: Plugin[];
  /** which plugin provides each interface */
  providers: Map<InterfaceName, string>;
  /** what is wrong, in the order a person would want to read it */
  problems: string[];
  /** core interfaces nothing provides: not a refusal, but the instance has to say so */
  missingCore: InterfaceName[];
}

/** the migration order the manifest promises: after everything this plugin requires, and stable among equals */
export function migrationOrder(order: Plugin[]): string[] {
  return order.map((p) => p.manifest.name);
}

export function resolve(plugins: Plugin[], voidbaseVersion: string, core: InterfaceName[] = CORE): Resolution {
  const problems: string[] = [];
  const providers = new Map<InterfaceName, string>();
  const byName = new Map<string, Plugin>();

  for (const p of plugins) {
    problems.push(...checkManifest(p.manifest));
    const seen = byName.get(p.manifest.name);
    if (seen) problems.push(`two plugins are called "${p.manifest.name}"; a name is how an instance refers to one, so it has to be unique`);
    byName.set(p.manifest.name, p);
  }

  // an interface nobody defines is a typo, and a typo in a manifest is a plugin that never loads for a reason
  // nobody can see. src/server/interfaces is the list; a name outside it is refused rather than resolved to
  // nothing.
  const known = new Set<string>(KNOWN);
  for (const p of plugins) {
    for (const i of [...(p.manifest.provides ?? []), ...(p.manifest.requires ?? [])]) {
      if (!known.has(i)) problems.push(`${p.manifest.name} names the interface "${i}", which this voidbase does not define`);
    }
  }

  // a plugin that does not fit this voidbase is refused now, rather than found out by a request
  for (const p of plugins) {
    if (p.manifest.voidbase && !satisfies(voidbaseVersion, p.manifest.voidbase)) {
      problems.push(`${p.manifest.name} works against voidbase ${p.manifest.voidbase}, and this is ${voidbaseVersion}`);
    }
  }

  // one interface, one provider, chosen on purpose
  for (const p of plugins) {
    for (const i of p.manifest.provides ?? []) {
      const already = providers.get(i);
      if (already) {
        problems.push(
          `${already} and ${p.manifest.name} both provide "${i}". Two providers of one interface is ambiguous: remove one, or say in the manifest which is meant.`,
        );
        continue;
      }
      providers.set(i, p.manifest.name);
    }
  }

  // a collection has one owner, and extending one nobody owns is a typo you want to hear about at install
  const owners = new Map<string, string>();
  for (const p of plugins) {
    for (const c of p.manifest.collections ?? []) {
      const already = owners.get(c);
      if (already) problems.push(`${already} and ${p.manifest.name} both own the collection "${c}"`);
      else owners.set(c, p.manifest.name);
    }
  }
  for (const p of plugins) {
    for (const c of Object.keys(p.manifest.extends ?? {})) {
      if (!owners.has(c)) {
        problems.push(`${p.manifest.name} extends the collection "${c}", which no installed plugin owns`);
      }
    }
  }

  // everything required is provided by somebody
  for (const p of plugins) {
    for (const i of p.manifest.requires ?? []) {
      if (!providers.has(i)) problems.push(`${p.manifest.name} requires "${i}" and nothing installed provides it`);
    }
  }

  // A core plugin is the tier that exists because the instance is not usable without it, so an instance missing
  // one is not lean, it is broken. That is a warning to say out loud rather than a refusal, because removing one
  // has to be possible: replacing auth is the entire point of moving it out.
  const missingCore = core.filter((i) => !providers.has(i));

  const { order, cycles } = sort(plugins, providers, owners);
  for (const c of cycles) problems.push(`these plugins depend on each other in a circle, which cannot be loaded: ${c.join(" -> ")}`);

  return { order, providers, problems, missingCore };
}

/**
 * Load order, and the cycles that make one impossible.
 *
 * Depth-first, marking as it goes: grey means "on the current path", so meeting grey again is the cycle and the
 * path from it is the thing worth printing. A plugin depends on whoever provides what it requires, and on whoever
 * owns a collection it extends, because an extension has to run after the collection exists.
 */
function sort(plugins: Plugin[], providers: Map<InterfaceName, string>, owners: Map<string, string>) {
  const byName = new Map(plugins.map((p) => [p.manifest.name, p]));
  const colour = new Map<string, "grey" | "black">();
  const path: string[] = [];
  const order: Plugin[] = [];
  const cycles: string[][] = [];

  const needs = (p: Plugin): string[] => [
    ...(p.manifest.requires ?? []).map((i) => providers.get(i)).filter((n): n is string => !!n),
    ...Object.keys(p.manifest.extends ?? {}).map((c) => owners.get(c)).filter((n): n is string => !!n),
  ];

  const walk = (name: string) => {
    const mark = colour.get(name);
    if (mark === "black") return;
    if (mark === "grey") {
      cycles.push([...path.slice(path.indexOf(name)), name]);
      return;
    }
    const p = byName.get(name);
    if (!p) return;
    colour.set(name, "grey");
    path.push(name);
    for (const dep of needs(p)) if (dep !== name) walk(dep);
    path.pop();
    colour.set(name, "black");
    order.push(p);
  };

  for (const p of plugins) walk(p.manifest.name);
  return { order, cycles };
}

/**
 * Semver ranges, only as far as a manifest needs them: `1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.2.3`, `*`, and any of
 * those separated by `||`. A prerelease satisfies a range whose own bound carries one, which is what lets a plugin
 * declare `^0.9.0-beta` and work against the betas it was written for.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parse(version);
  if (!v) return false;
  return range.split("||").some((part) => matches(v, part.trim()));
}

function matches(v: number[], part: string): boolean {
  if (!part || part === "*" || part === "x") return true;
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(part);
  if (!m) return false;
  const bound = parse(m[2]!);
  if (!bound) return false;
  const cmp = compare(v, bound);
  switch (m[1]) {
    case "^": return cmp >= 0 && caretTop(v, bound);
    case "~": return cmp >= 0 && v[0] === bound[0] && v[1] === bound[1];
    case ">=": return cmp >= 0;
    case "<=": return cmp <= 0;
    case ">": return cmp > 0;
    case "<": return cmp < 0;
    default: return cmp === 0;
  }
}

// ^1.2.3 keeps the major; below 1.0.0 the minor is the major, which is the convention every 0.x depends on
function caretTop(v: number[], bound: number[]): boolean {
  if (bound[0]! > 0) return v[0] === bound[0];
  if (bound[1]! > 0) return v[0] === 0 && v[1] === bound[1];
  return v[0] === 0 && v[1] === 0;
}

function parse(s: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(s.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const compare = (a: number[], b: number[]): number =>
  a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
