// A plugin's configuration plane: the fields its manifest declares under `config`, and the value each one holds.
//
// A field is a knob with a name, a type and a default, and the plugin says which kind it is: `runtime`, read on every
// request, so a change takes effect at once; or `rebuild`, read when the instance is built or started (a value written
// into the Worker's configuration at deploy, a route mounted at boot), so a change waits for the next rebuild. That
// is the plugin's call because only the plugin knows where it reads the value, and nobody should find out by being
// surprised.
//
// Where a value comes from, first match wins:
//   environment  the knob itself (VOIDBASE_HSTS, ...), set on the deploy or the process. It was the only place
//                through 0.9.0-beta.58 and it still wins, so nothing that configured a plugin that way changes.
//   instance     what an admin set from the panel on a vanilla instance, kept in `_params` (./plugin-config-store.ts).
//   project      pb_plugins/<name>/config.json on an extended project, committed with the project and carried by
//                its build. A plugin configured there is read only on the instance: git is what declares it.
//   default      what the manifest says.
//
// This module holds no database and no platform: the knob readers (response-policy.ts `readKnob`, payments-shared
// `knob`, and a plugin's own) ask `configKnob` after the environment, synchronously, and the store fills in what an
// admin set before the request reads it.
import type { ConfigField, ConfigValue, PluginManifest } from "./plugins/manifest";

export type ConfigValues = Record<string, Record<string, ConfigValue>>;
export type ConfigSource = "environment" | "instance" | "project" | "default";

/** a field's knob: the one it names, or VOIDBASE_<PLUGIN>_<FIELD> */
export const knobOf = (plugin: string, field: string, spec: ConfigField): string => spec.knob ?? `VOIDBASE_${plugin}_${field}`.toUpperCase().replace(/-/g, "_");

const planes = new Map<string, Record<string, ConfigField>>();
const byKnob = new Map<string, { plugin: string; field: string; spec: ConfigField }>();
let project: ConfigValues = {};
let stored: ConfigValues = {};
/** what an admin had set when this instance started: a rebuild field keeps reading it until the next start */
let atStart: ConfigValues | undefined;

/** the planes of the plugins that loaded, and the project's config.json files; called once the kernel has loaded */
export function declareConfig(manifests: PluginManifest[], fromProject: ConfigValues = {}): void {
  planes.clear(); byKnob.clear();
  for (const m of manifests) {
    if (!m.config || !Object.keys(m.config).length) continue;
    planes.set(m.name, m.config);
    for (const [field, spec] of Object.entries(m.config)) byKnob.set(knobOf(m.name, field, spec), { plugin: m.name, field, spec });
  }
  project = fromProject; stored = {}; atStart = undefined;
}

/** what an admin has set, as the store last read it; the first read is what this instance started with */
export function useStoredConfig(values: ConfigValues): void {
  stored = values;
  if (!atStart) atStart = structuredClone(values);
}

export const configPlane = (plugin: string): Record<string, ConfigField> | undefined => planes.get(plugin);
/** a plugin whose configuration is the project's: read only here, changed by a commit */
export const configuredInProject = (plugin: string): boolean => Object.hasOwn(project, plugin);

const pick = (plugin: string, field: string, spec: ConfigField, from: ConfigValues | undefined): { value: ConfigValue | undefined; source: ConfigSource } => {
  const set = from?.[plugin]?.[field];
  if (set !== undefined && !configuredInProject(plugin)) return { value: set, source: "instance" };
  const committed = project[plugin]?.[field];
  if (committed !== undefined) return { value: committed, source: "project" };
  return { value: spec.default, source: "default" };
};
const effective = (plugin: string, field: string, spec: ConfigField) => pick(plugin, field, spec, spec.applies === "rebuild" ? (atStart ?? stored) : stored);

/** a declared knob's value when the environment does not set it, or undefined for a knob no plugin declares */
export function configKnob(knob: string): string | undefined {
  const d = byKnob.get(knob);
  if (!d) return undefined;
  const { value } = effective(d.plugin, d.field, d.spec);
  return value === undefined ? undefined : String(value);
}

/** a value as its field's type, or why it is not one */
export function coerce(spec: ConfigField, value: unknown): { value: ConfigValue } | { problem: string } {
  if (spec.type === "string") return typeof value === "string" ? { value } : { problem: "must be a string" };
  if (spec.type === "number") { const n = typeof value === "string" && value.trim() ? Number(value) : value; return typeof n === "number" && Number.isFinite(n) ? { value: n } : { problem: "must be a number" }; }
  if (typeof value === "boolean") return { value };
  if (value === "true" || value === "false") return { value: value === "true" };
  return { problem: "must be true or false" };
}

/** a knob as the environment sets it for this request: the request's bindings, then the process's; undefined when unset */
export const environmentOf = (env?: object) => (knob: string): string | undefined => {
  let v = "";
  try { v = String((env as Record<string, unknown> | undefined)?.[knob] ?? (typeof process === "undefined" ? undefined : process.env?.[knob]) ?? "").trim(); } catch { v = ""; }
  return v || undefined;
};

export interface FieldReport extends ConfigField { knob: string; value: ConfigValue | null; source: ConfigSource; pending?: ConfigValue | null }

/**
 * Every plane, field by field: its declaration, the value in effect and where it came from, and for a rebuild field
 * an admin changed since this instance started, the value waiting for the next rebuild. `environment` reads the
 * knob the way the plugin does.
 */
export function configReport(environment: (knob: string) => string | undefined): Record<string, { editable: boolean; fields: Record<string, FieldReport> }> {
  const out: Record<string, { editable: boolean; fields: Record<string, FieldReport> }> = {};
  for (const [plugin, plane] of planes) {
    const fields: Record<string, FieldReport> = {};
    for (const [field, spec] of Object.entries(plane)) {
      const knob = knobOf(plugin, field, spec);
      const env = environment(knob);
      const { value, source } = env ? { value: env as ConfigValue, source: "environment" as const } : effective(plugin, field, spec);
      const report: FieldReport = { ...spec, knob, value: value ?? null, source };
      if (spec.applies === "rebuild" && !configuredInProject(plugin)) {
        const now = pick(plugin, field, spec, stored).value, then = pick(plugin, field, spec, atStart ?? stored).value;
        if (now !== then) report.pending = now ?? null;
      }
      fields[field] = report;
    }
    out[plugin] = { editable: !configuredInProject(plugin), fields };
  }
  return out;
}
