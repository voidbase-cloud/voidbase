// Where an admin's plugin configuration is kept on a vanilla instance: one `_params` row, like the settings, read into
// ./config.ts before a request reads a knob. An isolate re-reads it after a short while so a change made through
// another isolate reaches this one; the isolate that made the change has it at once.
import { one, run } from "../db";
import { ApiError, badRequest, notFound } from "../errors";
import { nowString } from "../ids";
import { coerce, configPlane, configuredInProject, useStoredConfig, type ConfigValues } from "./config";
import type { ConfigValue } from "./manifest";

const ROW = "plugin-config";
let readAt = 0;

export async function loadStoredConfig(db: D1Database, maxAgeMs = 30_000): Promise<ConfigValues> {
  if (readAt && Date.now() - readAt < maxAgeMs) return {};
  const row = await one<{ value: string }>(db, "SELECT value FROM `_params` WHERE id = ?", [ROW]);
  const values = row ? (JSON.parse(row.value) as ConfigValues) : {};
  useStoredConfig(values); readAt = Date.now();
  return values;
}

/** set some of a plugin's fields; says which took effect and which wait for the next rebuild */
export async function setPluginConfig(db: D1Database, plugin: string, body: unknown): Promise<{ applied: string[]; waitsForRebuild: string[]; message: string }> {
  const plane = configPlane(plugin);
  if (!plane) throw notFound(`${plugin} is not a loaded plugin with a configuration plane.`);
  if (configuredInProject(plugin)) throw new ApiError(409, `${plugin} is configured in the project, in pb_plugins/${plugin}/config.json: change it there, commit it, and let the build carry it.`);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("Send the fields to change as a JSON object.");
  const problems: Record<string, string> = {}; const changes: Record<string, ConfigValue> = {};
  for (const [field, value] of Object.entries(body)) {
    const spec = plane[field];
    if (!spec) { problems[field] = `${plugin} declares no field called ${field}`; continue; }
    const c = coerce(spec, value);
    if ("problem" in c) problems[field] = c.problem; else changes[field] = c.value;
  }
  if (Object.keys(problems).length) throw badRequest(`These fields cannot be set: ${Object.entries(problems).map(([f, p]) => `${f} ${p}`).join("; ")}.`);
  const values = await loadStoredConfig(db, 0);
  values[plugin] = { ...values[plugin], ...changes };
  const now = nowString();
  await run(db, "INSERT INTO `_params` (id, value, created, updated) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated = excluded.updated", [ROW, JSON.stringify(values), now, now]);
  useStoredConfig(values);
  const fields = Object.keys(changes);
  const applied = fields.filter((f) => plane[f]!.applies === "runtime"), waitsForRebuild = fields.filter((f) => plane[f]!.applies === "rebuild");
  const message = [applied.length ? `${applied.join(", ")} took effect.` : "", waitsForRebuild.length ? `${waitsForRebuild.join(", ")} ${waitsForRebuild.length === 1 ? "waits" : "wait"} for the next rebuild.` : ""].filter(Boolean).join(" ");
  return { applied, waitsForRebuild, message };
}
