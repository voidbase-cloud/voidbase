// What a plugin declares about itself.
//
// The manifest is the whole of what the loader knows before it runs anything, which is deliberate: every failure
// the roadmap promises to catch at install rather than at boot has to be answerable from these fields alone. If a
// question needs the plugin's code to answer it, it is a question the loader cannot ask early enough to be useful.
//
// It is also the answer to the two orderings problem. cordis orders code by `requires`; migrations have always
// ordered by filename. Those are two orderings that must agree, and they agree here: a plugin's migrations run
// after the migrations of everything it requires, and within one plugin filenames still decide.

/** an interface is a name and a major version: `auth@1`. A major bump is a different interface, not a compatible one. */
export type InterfaceName = `${string}@${number}`;

/**
 * What happens if you do nothing.
 *
 * core      installed and enabled by default and shipped with voidbase, because the instance is not usable
 *           without it. Removable on purpose, never by accident.
 * official  ours, supported, versioned with voidbase, and it arrives because you asked for it.
 * community somebody else's, from our marketplace or a registry of your own.
 */
export type Tier = "core" | "official" | "community";

/** a configuration field's value, as its type says */
export type ConfigValue = string | number | boolean;

/**
 * One field of a plugin's configuration plane (./config.ts). `applies` is the plugin's promise about when a change
 * takes effect: `runtime`, read on every request; `rebuild`, read when the instance is built or started. `knob` is the
 * environment variable that sets it too, and the one the plugin reads; without one it is VOIDBASE_<PLUGIN>_<FIELD>.
 */
export interface ConfigField {
  type: "string" | "number" | "boolean";
  applies: "runtime" | "rebuild";
  default?: ConfigValue;
  knob?: string;
  description?: string;
}

/** a field a plugin adds to a collection somebody else owns */
export interface FieldPatch {
  name: string;
  type: string;
  required?: boolean;
  [option: string]: unknown;
}

export interface PluginManifest {
  /** the install name, unique in an instance: `backups-r2` */
  name: string;
  version: string;
  tier: Tier;
  /** the voidbase versions this works against, as a semver range. Install refuses outside it. */
  voidbase: string;

  /** the interfaces this plugin implements, so something else can require them without naming it */
  provides?: InterfaceName[];
  /** the interfaces it cannot run without. A missing one means it does not load, and the instance says so. */
  requires?: InterfaceName[];

  /**
   * The collections this plugin owns and creates. Two plugins claiming one name collide at install rather than
   * discovering each other at boot, which is why this is declared rather than inferred from the migrations.
   */
  collections?: string[];
  /**
   * Fields added to a collection somebody else owns. Declared rather than migrated, because a migration cannot say
   * whose collection it is touching and the loader has to know in order to order it, or to refuse it when the
   * owner is absent.
   */
  extends?: Record<string, FieldPatch[]>;
  /**
   * The plugin's configuration plane: the fields an admin sets on a vanilla instance and a developer commits in
   * pb_plugins/<name>/config.json on an extended one. Declared, so both can be shown before anything is changed.
   */
  config?: Record<string, ConfigField>;
}

/** a plugin as the loader holds it: what it declared, and what it does */
export interface Plugin {
  manifest: PluginManifest;
  /** mounts routes, hooks and cron handlers. Runs at module scope, before the app serves anything. */
  apply?: (ctx: import("../kernel").Kernel) => void | Promise<void>;
  /**
   * What this plugin says about itself on `GET /api/plugins`, under its own name: the knobs it found, where its
   * work goes with these bindings. Per env, because a binding arrives with the request and not at module scope.
   *
   * It is the plugin's answer rather than the core's because a plugin installed under a shipped name replaces the
   * shipped one, and the core calling the shipped module went on describing code that was no longer running. A
   * plugin without one is simply not named in that part of the answer.
   */
  info?: (env: import("../types").Bindings) => object | Promise<object>;
}

const NAME = /^[a-z][a-z0-9-]*$/;
const INTERFACE = /^[a-z][a-z0-9-]*@\d+$/;
const FIELD = /^[a-z][a-z0-9_]*$/;
const KNOB = /^[A-Z][A-Z0-9_]*$/;

/** what is wrong with a manifest, said all at once rather than one throw at a time */
export function checkManifest(m: PluginManifest): string[] {
  const wrong: string[] = [];
  if (!NAME.test(m.name)) wrong.push(`name "${m.name}" must be lowercase letters, digits and dashes`);
  if (!m.version) wrong.push(`${m.name} declares no version`);
  if (!m.voidbase) wrong.push(`${m.name} declares no voidbase range, so no install can tell whether it fits`);
  for (const i of m.provides ?? []) if (!INTERFACE.test(i)) wrong.push(`${m.name} provides "${i}", which is not name@major`);
  for (const i of m.requires ?? []) if (!INTERFACE.test(i)) wrong.push(`${m.name} requires "${i}", which is not name@major`);
  for (const c of m.collections ?? []) {
    if (m.extends && c in m.extends) wrong.push(`${m.name} both owns and extends "${c}"; it is one or the other`);
  }
  for (const [field, spec] of Object.entries(m.config ?? {})) {
    const at = `${m.name}'s config field ${JSON.stringify(field)}`;
    if (!FIELD.test(field)) wrong.push(`${at} must be lowercase letters, digits and underscores`);
    if (!["string", "number", "boolean"].includes(spec?.type)) wrong.push(`${at} has type ${JSON.stringify(spec?.type)}, and a field is a string, a number or a boolean`);
    if (!["runtime", "rebuild"].includes(spec?.applies)) wrong.push(`${at} must say whether it applies at runtime or needs a rebuild`);
    if (spec?.default !== undefined && typeof spec.default !== spec.type) wrong.push(`${at} defaults to a ${typeof spec.default}, and it is a ${spec.type}`);
    if (spec?.knob !== undefined && !KNOB.test(spec.knob)) wrong.push(`${at} names the knob ${JSON.stringify(spec.knob)}, which is not an environment variable name`);
  }
  return wrong;
}

export { configKnob } from "./config";
